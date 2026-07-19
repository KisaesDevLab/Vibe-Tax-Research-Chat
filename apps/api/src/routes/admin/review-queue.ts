// TP-12 — review-queue admin surface + the pipeline draft trigger.
// The queue is the single funnel for every pipeline-produced change
// (strategy drafts now; table drafts, watch hits, golden failures in
// TP-14). Approving a strategy-draft publishes the version and bumps
// strategies.current_version_id; approving a table-draft publishes the
// table set; nothing publishes any other way.
import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, ne, sql } from 'drizzle-orm';
import { getDb } from '@vibe/db';
import { review_queue, strategies, strategy_versions, table_sets } from '@vibe/db/schema';
import { listModuleRefs } from '@vibe/strategies';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { requirePlanning } from '../../middleware/planning-flag.js';
import { audit } from '../../lib/audit.js';
import {
  goldenRegressionQueue,
  strategyAuthorQueue,
  strategyRefreshQueue,
} from '../../jobs/queues.js';
import { publishTableSet } from './table-sets.js';

const idParam = z.string().uuid();

// Decision failures inside the transaction: throwing rolls everything
// back; the route maps the code onto an HTTP status.
class DecisionError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly code: string,
  ) {
    super(code);
  }
}

// Every review_queue kind is a planning-pipeline artifact (strategy-draft,
// table-draft, golden-failure, watch-hit, archive-scan-hit), and approving
// a table-draft publishes the table set — so the whole surface sits behind
// the planning flag, same as the standalone publish endpoint.
export const adminReviewQueueRouter = Router();
adminReviewQueueRouter.use(requireAuth, requireRole('admin'), requirePlanning);

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
  const id = idParam.safeParse(req.params.id);
  if (!id.success) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  const db = getDb();
  const [item] = await db.select().from(review_queue).where(eq(review_queue.id, id.data)).limit(1);
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
// A draft whose validation failed can still be approved, but only with an
// explicit override — never by accident.
const approveSchema = decisionSchema.extend({ force: z.boolean().optional() });

adminReviewQueueRouter.post('/:id/approve', async (req, res) => {
  const id = idParam.safeParse(req.params.id);
  if (!id.success) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  const parsed = approveSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  const db = getDb();
  const [item] = await db.select().from(review_queue).where(eq(review_queue.id, id.data)).limit(1);
  if (!item) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  if (item.status !== 'open') {
    res.status(409).json({ error: 'already_decided' });
    return;
  }

  const actor = req.auth!.user_id;
  // Row-guarded decision: two admins clicking approve concurrently must
  // not both "win" — the guard makes the loser's transaction roll back.
  const decideOpen = async (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => {
    const [decided] = await tx
      .update(review_queue)
      .set({ status: 'approved', decided_by: actor, decided_at: new Date() })
      .where(and(eq(review_queue.id, item.id), eq(review_queue.status, 'open')))
      .returning({ id: review_queue.id });
    if (!decided) throw new DecisionError(409, 'already_decided');
  };

  try {
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
        await decideOpen(tx);
        const [version] = await tx
          .select()
          .from(strategy_versions)
          .where(eq(strategy_versions.id, version_id))
          .limit(1);
        // Only a live draft is publishable — a deleted or already
        // deprecated/published version means the item is stale.
        if (!version || version.status !== 'draft') {
          throw new DecisionError(422, 'version_not_draft');
        }
        // The math is compiled TS; approving content that points at a
        // module this build doesn't ship would break compute at runtime.
        if (version.apply_module_ref && !listModuleRefs().includes(version.apply_module_ref)) {
          throw new DecisionError(422, 'unknown_apply_module');
        }
        const validation = (item.payload as { validation?: { ok?: boolean } }).validation;
        if (validation?.ok === false && parsed.data.force !== true) {
          throw new DecisionError(422, 'validation_failed_requires_force');
        }
        // One published version per strategy: demote the outgoing
        // published row(s) or research-launch and the currency jobs see
        // stale versions still marked 'published'.
        await tx
          .update(strategy_versions)
          .set({ status: 'deprecated' })
          .where(
            and(
              eq(strategy_versions.strategy_id, strategy_id),
              eq(strategy_versions.status, 'published'),
              ne(strategy_versions.id, version_id),
            ),
          );
        await tx
          .update(strategy_versions)
          .set({ status: 'published', reviewed_by: actor })
          .where(eq(strategy_versions.id, version_id));
        await tx
          .update(strategies)
          .set({ current_version_id: version_id })
          .where(eq(strategies.id, strategy_id));
      });
      await audit({
        actor_user_id: actor,
        action: 'strategy.publish',
        target_type: 'strategy',
        target_id: strategy_id,
        metadata: {
          version_id,
          via: 'review-queue',
          forced: parsed.data.force === true,
          note: parsed.data.note ?? null,
        },
      });
    } else if (item.kind === 'table-draft') {
      // Approving a table draft IS the publish — the review queue is the
      // web UI's only path here. The standalone publish endpoint shares
      // publishTableSet().
      const tableSetId = (item.payload as { table_set_id?: string }).table_set_id;
      if (!tableSetId) {
        res.status(422).json({ error: 'malformed_payload' });
        return;
      }
      const row = await db.transaction(async (tx) => {
        await decideOpen(tx);
        const outcome = await publishTableSet(tx, tableSetId, actor);
        if (!outcome.ok) {
          throw new DecisionError(
            outcome.reason === 'not_found' ? 422 : 409,
            outcome.reason === 'not_found' ? 'malformed_payload' : outcome.reason,
          );
        }
        return outcome.row;
      });
      const job = await goldenRegressionQueue.add('on-publish', {
        table_set_id: row.id,
        triggered_by: `review-queue:${actor}`,
      });
      await audit({
        actor_user_id: actor,
        action: 'table_set.publish',
        target_type: 'table_set',
        target_id: row.id,
        metadata: {
          tax_year: row.tax_year,
          version: row.version,
          via: 'review-queue',
          golden_regression_job: job.id ?? null,
          note: parsed.data.note ?? null,
        },
      });
    } else {
      // Remaining kinds (watch hits, golden failures, …) record the
      // decision only; any follow-up runs through its own endpoint.
      await db.transaction(decideOpen);
      await audit({
        actor_user_id: actor,
        action: 'review_queue.approve',
        target_type: 'review_queue',
        target_id: item.id,
        metadata: { kind: item.kind, note: parsed.data.note ?? null },
      });
    }
  } catch (err) {
    if (err instanceof DecisionError) {
      res.status(err.httpStatus).json({ error: err.code });
      return;
    }
    throw err;
  }
  res.json({ ok: true });
});

adminReviewQueueRouter.post('/:id/reject', async (req, res) => {
  const id = idParam.safeParse(req.params.id);
  if (!id.success) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  const parsed = decisionSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  const db = getDb();
  const [item] = await db.select().from(review_queue).where(eq(review_queue.id, id.data)).limit(1);
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
  const tableSetId = (item.payload as { table_set_id?: string }).table_set_id;
  try {
    await db.transaction(async (tx) => {
      const [decided] = await tx
        .update(review_queue)
        .set({ status: 'rejected', decided_by: actor, decided_at: new Date() })
        .where(and(eq(review_queue.id, item.id), eq(review_queue.status, 'open')))
        .returning({ id: review_queue.id });
      if (!decided) throw new DecisionError(409, 'already_decided');
      if (item.kind === 'strategy-draft' && versionId) {
        // 'rejected', NOT 'deprecated': deprecated means "superseded but
        // once published" and stays resolvable for plans pinned to it.
        // A rejected draft was never approved — it must never become
        // pinnable or computable.
        await tx
          .update(strategy_versions)
          .set({ status: 'rejected' })
          .where(and(eq(strategy_versions.id, versionId), eq(strategy_versions.status, 'draft')));
      }
      if (item.kind === 'table-draft' && tableSetId) {
        // A rejected draft is dead: mark the row so the standalone
        // publish endpoint refuses it (not_a_draft) and the tables-draft
        // job knows the version slot is spent.
        await tx
          .update(table_sets)
          .set({ status: 'rejected' })
          .where(and(eq(table_sets.id, tableSetId), eq(table_sets.status, 'draft')));
      }
    });
  } catch (err) {
    if (err instanceof DecisionError) {
      res.status(err.httpStatus).json({ error: err.code });
      return;
    }
    throw err;
  }
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
// Same planning-flag gate as the review queue the drafts land in — with
// the module off, triggering drafts would park items nobody can see.
adminStrategyDraftRouter.use(requireAuth, requireRole('admin'), requirePlanning);

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

// ── sweep trigger: POST /api/admin/strategies/refresh-sweep ────────────
// The strategy-refresh worker sweeps every strategy when the job carries
// no strategy_id; until now nothing ever enqueued that shape.
adminStrategyDraftRouter.post('/refresh-sweep', async (req, res) => {
  const job = await strategyRefreshQueue.add('sweep', {
    triggered_by: `admin:${req.auth!.user_id}`,
  });
  await audit({
    actor_user_id: req.auth!.user_id,
    action: 'strategy.refresh_sweep_requested',
    target_type: 'job',
    target_id: 'strategy-refresh',
    metadata: { job_id: job.id ?? null },
  });
  res.status(202).json({ ok: true, job_id: job.id });
});
