// TP-4 — table-set read API (admin). TP-14 adds the publish endpoint:
// drafts arrive from the tables-draft job via the review queue; an admin
// publishes here, which pins the set and kicks golden-regression.
import { Router } from 'express';
import { desc, eq } from 'drizzle-orm';
import { getDb } from '@vibe/db';
import { table_sets } from '@vibe/db/schema';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { requirePlanning } from '../../middleware/planning-flag.js';
import { goldenRegressionQueue } from '../../jobs/queues.js';
import { audit } from '../../lib/audit.js';

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
  const [row] = await getDb()
    .select()
    .from(table_sets)
    .where(eq(table_sets.id, req.params.id))
    .limit(1);
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
  const db = getDb();
  const [row] = await db.select().from(table_sets).where(eq(table_sets.id, req.params.id)).limit(1);
  if (!row) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  if (row.status === 'published') {
    res.status(409).json({ error: 'already_published' });
    return;
  }
  await db
    .update(table_sets)
    .set({ status: 'published', published_at: new Date() })
    .where(eq(table_sets.id, row.id));
  const job = await goldenRegressionQueue.add('on-publish', {
    table_set_id: row.id,
    triggered_by: `publish:${req.auth!.user_id}`,
  });
  await audit({
    actor_user_id: req.auth!.user_id,
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
