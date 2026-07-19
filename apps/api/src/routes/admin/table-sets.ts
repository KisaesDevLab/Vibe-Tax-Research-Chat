// TP-4 — table-set read API (admin). Write path is TP-14's tables:draft →
// review → publish flow; nothing here mutates.
import { Router } from 'express';
import { desc, eq } from 'drizzle-orm';
import { getDb } from '@vibe/db';
import { table_sets } from '@vibe/db/schema';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { requirePlanning } from '../../middleware/planning-flag.js';

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
