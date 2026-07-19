// TP-4 — table-set read API (admin). TP-14 adds the publish endpoint:
// drafts arrive from the tables-draft job via the review queue; an admin
// publishes here, which pins the set and kicks golden-regression.
import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { getDb, type Db } from '@vibe/db';
import { table_sets, type TableSet } from '@vibe/db/schema';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { requirePlanning } from '../../middleware/planning-flag.js';
import { goldenRegressionQueue } from '../../jobs/queues.js';
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
