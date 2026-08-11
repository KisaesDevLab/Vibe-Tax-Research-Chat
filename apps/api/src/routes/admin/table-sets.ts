// TP-4 — table-set read API (admin). TP-14 adds the publish endpoint:
// drafts arrive from the tables-draft job via the review queue; an admin
// publishes here, which pins the set and kicks golden-regression.
import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, sql } from 'drizzle-orm';
import { getDb, type Db } from '@vibe/db';
import { review_queue, table_sets, type TableSet } from '@vibe/db/schema';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { requirePlanning } from '../../middleware/planning-flag.js';
import { goldenRegressionQueue, tablesDraftQueue } from '../../jobs/queues.js';
import { audit } from '../../lib/audit.js';

const idParam = z.string().uuid();

// Accepts either the db handle or a transaction — the review-queue
// approve path publishes inside its decision transaction.
type DbOrTx = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

export type PublishTableSetOutcome =
  | { ok: true; row: TableSet }
  | { ok: false; reason: 'not_found' | 'already_published' | 'not_a_draft' };

/**
 * Publish a draft table set. Only 'draft' rows are publishable — a
 * 'rejected' row must be redrafted, not resurrected. The UPDATE is
 * row-guarded on status so a concurrent publish loses cleanly.
 */
export async function publishTableSet(
  tx: DbOrTx,
  tableSetId: string,
  actorUserId: string,
): Promise<PublishTableSetOutcome> {
  const [row] = await tx.select().from(table_sets).where(eq(table_sets.id, tableSetId)).limit(1);
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.status === 'published') return { ok: false, reason: 'already_published' };
  if (row.status !== 'draft') return { ok: false, reason: 'not_a_draft' };
  const [updated] = await tx
    .update(table_sets)
    .set({ status: 'published', published_at: new Date(), published_by: actorUserId })
    .where(and(eq(table_sets.id, tableSetId), eq(table_sets.status, 'draft')))
    .returning();
  if (!updated) return { ok: false, reason: 'already_published' }; // raced
  return { ok: true, row: updated };
}

export const adminTableSetsRouter = Router();
adminTableSetsRouter.use(requireAuth, requireRole('admin'), requirePlanning);

adminTableSetsRouter.get('/', async (_req, res) => {
  const rows = await getDb()
    .select({
      id: table_sets.id,
      tax_year: table_sets.tax_year,
      version: table_sets.version,
      status: table_sets.status,
      published_at: table_sets.published_at,
      created_at: table_sets.created_at,
    })
    .from(table_sets)
    .orderBy(desc(table_sets.tax_year), desc(table_sets.version));
  res.json({ table_sets: rows });
});

adminTableSetsRouter.get('/:id', async (req, res) => {
  const id = idParam.safeParse(req.params.id);
  if (!id.success) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  const [row] = await getDb().select().from(table_sets).where(eq(table_sets.id, id.data)).limit(1);
  if (!row) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.json({ table_set: row });
});

// TP-14 — publish a draft table set. Published sets are immutable in
// practice (plans pin them); publishing automatically re-runs every
// golden against the new set so drift lands in the review queue.
adminTableSetsRouter.post('/:id/publish', async (req, res) => {
  const id = idParam.safeParse(req.params.id);
  if (!id.success) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  const db = getDb();
  const actor = req.auth!.user_id;
  const outcome = await db.transaction((tx) => publishTableSet(tx, id.data, actor));
  if (!outcome.ok) {
    if (outcome.reason === 'not_found') {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.status(409).json({ error: outcome.reason });
    return;
  }
  const row = outcome.row;
  const job = await goldenRegressionQueue.add('on-publish', {
    table_set_id: row.id,
    triggered_by: `publish:${actor}`,
  });
  await audit({
    actor_user_id: actor,
    action: 'table_set.publish',
    target_type: 'table_set',
    target_id: row.id,
    metadata: {
      tax_year: row.tax_year,
      version: row.version,
      golden_regression_job: job.id ?? null,
    },
  });
  res.json({ ok: true, golden_regression_job: job.id });
});

// Manually kick the next-year drafting job. Exists because the annual
// Oct 1 cron predates the real Rev. Proc. cycle (figures usually publish
// late Oct/Nov) — the admin rejects the stale draft, then redrafts here
// once the official numbers are out. The handler itself dedupes against
// an open table-draft review item, so double-clicks are harmless.
adminTableSetsRouter.post('/draft', async (req, res) => {
  const job = await tablesDraftQueue.add('manual', { triggered_by: req.auth!.user_id });
  await audit({
    actor_user_id: req.auth!.user_id,
    action: 'table_set.draft_trigger',
    metadata: { job_id: job.id ?? null },
    ip: req.ip,
  });
  res.status(202).json({ ok: true, job_id: job.id });
});

// Edit a DRAFT table set (payload figures and/or source notes) before it
// is published. Published sets stay immutable — plans pin them. When an
// open review item references this draft, its field diff is recomputed
// against the same base so reviewers never see a stale diff.
const editSchema = z.object({
  payload: z.record(z.unknown()),
  source_notes: z
    .array(
      z.object({
        group: z.string(),
        authority: z.string(),
        url: z.string().optional(),
        note: z.string().optional(),
      }),
    )
    .optional(),
});

adminTableSetsRouter.patch('/:id', async (req, res) => {
  const id = idParam.safeParse(req.params.id);
  if (!id.success) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  const parsed = editSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'bad_request', detail: parsed.error.flatten() });
    return;
  }
  const db = getDb();
  const [row] = await db.select().from(table_sets).where(eq(table_sets.id, id.data)).limit(1);
  if (!row) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  if (row.status !== 'draft') {
    res.status(409).json({
      error: 'not_a_draft',
      detail: 'Published table sets are immutable — draft a new version instead.',
    });
    return;
  }

  await db
    .update(table_sets)
    .set({
      payload: parsed.data.payload as never,
      ...(parsed.data.source_notes ? { source_notes: parsed.data.source_notes as never } : {}),
    })
    .where(and(eq(table_sets.id, id.data), eq(table_sets.status, 'draft')));

  // Refresh the open review item's diff against its recorded base.
  const [item] = await db
    .select()
    .from(review_queue)
    .where(
      and(
        eq(review_queue.kind, 'table-draft'),
        eq(review_queue.status, 'open'),
        sql`payload->>'table_set_id' = ${id.data}`,
      ),
    )
    .limit(1);
  if (item) {
    const itemPayload = item.payload as Record<string, unknown>;
    const baseId =
      typeof itemPayload.base_table_set_id === 'string' ? itemPayload.base_table_set_id : null;
    if (baseId) {
      const [base] = await db.select().from(table_sets).where(eq(table_sets.id, baseId)).limit(1);
      if (base) {
        const { diffTableFields } = await import('../../jobs/handlers/currency.js');
        const fieldDiff = diffTableFields(base.payload, parsed.data.payload);
        await db
          .update(review_queue)
          .set({
            payload: {
              ...itemPayload,
              field_diff: fieldDiff.slice(0, 400),
              ...(parsed.data.source_notes ? { source_notes: parsed.data.source_notes } : {}),
              edited_by: req.auth!.user_id,
            } as never,
          })
          .where(eq(review_queue.id, item.id));
      }
    }
  }

  await audit({
    actor_user_id: req.auth!.user_id,
    action: 'table_set.edit',
    target_type: 'table_set',
    target_id: id.data,
    metadata: {
      tax_year: row.tax_year,
      version: row.version,
      source_notes_updated: Boolean(parsed.data.source_notes),
    },
    ip: req.ip,
  });
  res.json({ ok: true });
});
