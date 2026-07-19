// TP-12 — review-queue admin surface + the pipeline draft trigger.
// The queue is the single funnel for every pipeline-produced change
// (strategy drafts now; table drafts, watch hits, golden failures in
// TP-14). Approving a strategy-draft publishes the version and bumps
// strategies.current_version_id; nothing publishes any other way.
import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, sql } from 'drizzle-orm';
import { getDb } from '@vibe/db';
import { review_queue, strategies, strategy_versions } from '@vibe/db/schema';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { audit } from '../../lib/audit.js';
import { strategyAuthorQueue } from '../../jobs/queues.js';

export const adminReviewQueueRouter = Router();
adminReviewQueueRouter.use(requireAuth, requireRole('admin'));

const listQuery = z.object({
  status: z.enum(['open', 'approved', 'rejected']).default('open'),
  kind: z.string().optional(),
});

adminReviewQueueRouter.get('/', async (req, res) => {
  const parsed = listQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  const db = getDb();
  const where = parsed.data.kind
    ? and(eq(review_queue.status, parsed.data.status), eq(review_queue.kind, parsed.data.kind))
    : eq(review_queue.status, parsed.data.status);
  const items = await db
    .select()
    .from(review_queue)
    .where(where)
    .orderBy(desc(review_queue.created_at))
    .limit(200);
  const [counts] = await db
    .select({
      open: sql<number>`count(*) filter (where status = 'open')`,
      approved: sql<number>`count(*) filter (where status = 'approved')`,
      rejected: sql<number>`count(*) filter (where status = 'rejected')`,
    })
    .from(review_queue);
  res.json({ items, counts });
});

adminReviewQueueRouter.get('/:id', async (req, res) => {
  const db = getDb();
  const [item] = await db
    .select()
    .from(review_queue)
    .where(eq(review_queue.id, req.params.id))
    .limit(1);
  if (!item) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  // Strategy drafts get the side-by-side payload: draft version content
  // plus the currently published content for diffing in the UI.
  let draft = null;
  let published = null;
  const versionId = (item.payload as { version_id?: string }).version_id;
  const strategyId = (item.payload as { strategy_id?: string }).strategy_id;
  if (versionId) {
    [draft] = await db
      .select()
      .from(strategy_versions)
      .where(eq(strategy_versions.id, versionId))
      .limit(1);
  }
  if (strategyId) {
    const [s] = await db.select().from(strategies).where(eq(strategies.id, strategyId)).limit(1);
    if (s?.current_version_id) {
      [published] = await db
        .select()
        .from(strategy_versions)
        .where(eq(strategy_versions.id, s.current_version_id))
        .limit(1);
    }
  }
  res.json({ item, draft, published });
});

const decisionSchema = z.object({ note: z.string().max(2000).optional() });

adminReviewQueueRouter.post('/:id/approve', async (req, res) => {
  const parsed = decisionSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  const db = getDb();
  const [item] = await db
    .select()
    .from(review_queue)
    .where(eq(review_queue.id, req.params.id))
    .limit(1);
  if (!item) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  if (item.status !== 'open') {
    res.status(409).json({ error: 'already_decided' });
    return;
  }

  const actor = req.auth!.user_id;
  if (item.kind === 'strategy-draft') {
    const { version_id, strategy_id } = item.payload as {
      version_id?: string;
      strategy_id?: string;
    };
    if (!version_id || !strategy_id) {
      res.status(422).json({ error: 'malformed_payload' });
      return;
    }
    await db.transaction(async (tx) => {
      await tx
        .update(strategy_versions)
        .set({ status: 'published', reviewed_by: actor })
        .where(eq(strategy_versions.id, version_id));
      await tx
        .update(strategies)
        .set({ current_version_id: version_id })
        .where(eq(strategies.id, strategy_id));
      await tx
        .update(review_queue)
        .set({ status: 'approved', decided_by: actor, decided_at: new Date() })
        .where(eq(review_queue.id, item.id));
    });
    await audit({
      actor_user_id: actor,
      action: 'strategy.publish',
      target_type: 'strategy',
      target_id: strategy_id,
      metadata: { version_id, via: 'review-queue', note: parsed.data.note ?? null },
    });
  } else {
    // Non-strategy kinds (TP-14) record the decision only; their side
    // effects (e.g. table publish) run through their own endpoints.
    await db
      .update(review_queue)
      .set({ status: 'approved', decided_by: actor, decided_at: new Date() })
      .where(eq(review_queue.id, item.id));
    await audit({
      actor_user_id: actor,
      action: 'review_queue.approve',
      target_type: 'review_queue',
      target_id: item.id,
      metadata: { kind: item.kind, note: parsed.data.note ?? null },
    });
  }
  res.json({ ok: true });
});

adminReviewQueueRouter.post('/:id/reject', async (req, res) => {
  const parsed = decisionSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  const db = getDb();
  const [item] = await db
    .select()
    .from(review_queue)
    .where(eq(review_queue.id, req.params.id))
    .limit(1);
  if (!item) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  if (item.status !== 'open') {
    res.status(409).json({ error: 'already_decided' });
    return;
  }
  const actor = req.auth!.user_id;
  const versionId = (item.payload as { version_id?: string }).version_id;
  await db.transaction(async (tx) => {
    if (item.kind === 'strategy-draft' && versionId) {
      await tx
        .update(strategy_versions)
        .set({ status: 'deprecated' })
        .where(and(eq(strategy_versions.id, versionId), eq(strategy_versions.status, 'draft')));
    }
    await tx
      .update(review_queue)
      .set({ status: 'rejected', decided_by: actor, decided_at: new Date() })
      .where(eq(review_queue.id, item.id));
  });
  await audit({
    actor_user_id: actor,
    action: 'review_queue.reject',
    target_type: 'review_queue',
    target_id: item.id,
    metadata: { kind: item.kind, note: parsed.data.note ?? null },
  });
  res.json({ ok: true });
});

// ── pipeline trigger: POST /api/admin/strategies/:id/draft ─────────────
export const adminStrategyDraftRouter = Router();
adminStrategyDraftRouter.use(requireAuth, requireRole('admin'));

adminStrategyDraftRouter.post('/:id/draft', async (req, res) => {
  const db = getDb();
  const [strategy] = await db
    .select()
    .from(strategies)
    .where(eq(strategies.id, req.params.id))
    .limit(1);
  if (!strategy) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const job = await strategyAuthorQueue.add('draft', {
    strategy_id: strategy.id,
    triggered_by: `admin:${req.auth!.user_id}`,
  });
  await audit({
    actor_user_id: req.auth!.user_id,
    action: 'strategy.draft_requested',
    target_type: 'strategy',
    target_id: strategy.id,
    metadata: { job_id: job.id ?? null },
  });
  res.status(202).json({ ok: true, job_id: job.id });
});
