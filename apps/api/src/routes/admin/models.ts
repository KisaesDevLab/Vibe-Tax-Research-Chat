// Phase 6 — model registry CRUD + manifest refresh + default-model.
import { Router } from 'express';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { getDb } from '@vibe/db';
import { models } from '@vibe/db/schema';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { audit } from '../../lib/audit.js';
import { env } from '../../config/env.js';

export const adminModelsRouter = Router();
adminModelsRouter.use(requireAuth, requireRole('admin'));

adminModelsRouter.get('/', async (_req, res) => {
  const rows = await getDb().select().from(models);
  res.json({ models: rows });
});

const patchSchema = z.object({
  display_name: z.string().min(1).optional(),
  input_per_mtok: z.number().nonnegative().optional(),
  output_per_mtok: z.number().nonnegative().optional(),
  cache_write_per_mtok: z.number().nonnegative().optional(),
  cache_read_per_mtok: z.number().nonnegative().optional(),
  tokenizer_factor: z.number().positive().optional(),
  web_fetch_unit_cost: z.number().nonnegative().optional(),
  web_search_unit_cost: z.number().nonnegative().optional(),
  web_tools_enabled: z.boolean().optional(),
  fetches_per_turn: z.number().int().nonnegative().optional(),
  searches_per_turn: z.number().int().nonnegative().optional(),
  is_active: z.boolean().optional(),
  notes: z.string().nullable().optional(),
});

adminModelsRouter.patch('/:id', async (req, res) => {
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'bad_request', detail: parsed.error.flatten() });
    return;
  }
  const update: Record<string, unknown> = { updated_at: new Date(), updated_by: req.auth!.user_id };
  for (const [k, v] of Object.entries(parsed.data)) {
    if (v === undefined) continue;
    update[k] = typeof v === 'number' ? v.toString() : v;
  }
  await getDb().update(models).set(update).where(eq(models.model_id, req.params.id));
  await audit({
    actor_user_id: req.auth!.user_id,
    action: 'admin.model.update',
    target_type: 'model',
    target_id: req.params.id,
    metadata: parsed.data,
    ip: req.ip,
  });
  res.status(204).end();
});

interface ManifestEntry {
  model_id: string;
  display_name: string;
  input_per_mtok: number;
  output_per_mtok: number;
  cache_write_per_mtok: number;
  cache_read_per_mtok: number;
  tokenizer_factor?: number;
  web_fetch_unit_cost?: number;
  web_search_unit_cost?: number;
  is_active?: boolean;
  notes?: string;
}

adminModelsRouter.post('/refresh', async (_req, res) => {
  // Fetch the upstream manifest with a 5s timeout.
  let manifest: { models: ManifestEntry[] };
  try {
    const r = await fetch(env.MODELS_MANIFEST_URL, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) {
      res.status(502).json({ error: 'manifest_fetch_failed', status: r.status });
      return;
    }
    manifest = (await r.json()) as { models: ManifestEntry[] };
  } catch (err) {
    res.status(502).json({ error: 'manifest_fetch_failed', detail: (err as Error).message });
    return;
  }

  // Diff against current.
  const current = await getDb().select().from(models);
  const byId = new Map(current.map((m) => [m.model_id, m]));
  const added: ManifestEntry[] = [];
  const updated: Array<{ model_id: string; before: unknown; after: ManifestEntry }> = [];
  for (const m of manifest.models) {
    const cur = byId.get(m.model_id);
    if (!cur) {
      added.push(m);
      continue;
    }
    const changedFields: Record<string, [unknown, unknown]> = {};
    const compare: Array<keyof ManifestEntry> = [
      'input_per_mtok',
      'output_per_mtok',
      'cache_write_per_mtok',
      'cache_read_per_mtok',
      'tokenizer_factor',
      'web_fetch_unit_cost',
      'web_search_unit_cost',
    ];
    for (const f of compare) {
      const b = Number((cur as Record<string, unknown>)[f]);
      const a = Number(m[f] ?? b);
      if (Math.abs(a - b) > 1e-9) changedFields[f] = [b, a];
    }
    if (Object.keys(changedFields).length > 0) {
      updated.push({ model_id: m.model_id, before: changedFields, after: m });
    }
  }

  res.json({ added, updated, removed: [], unchanged_count: current.length - updated.length });
});

const applySchema = z.object({
  added: z.array(z.any()).default([]),
  updated: z.array(z.any()).default([]),
});

adminModelsRouter.post('/refresh/apply', async (req, res) => {
  const parsed = applySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  const db = getDb();
  for (const m of parsed.data.added as ManifestEntry[]) {
    await db
      .insert(models)
      .values({
        model_id: m.model_id,
        display_name: m.display_name,
        input_per_mtok: m.input_per_mtok.toString(),
        output_per_mtok: m.output_per_mtok.toString(),
        cache_write_per_mtok: m.cache_write_per_mtok.toString(),
        cache_read_per_mtok: m.cache_read_per_mtok.toString(),
        tokenizer_factor: (m.tokenizer_factor ?? 1).toString(),
        web_fetch_unit_cost: (m.web_fetch_unit_cost ?? 0.01).toString(),
        web_search_unit_cost: (m.web_search_unit_cost ?? 0.01).toString(),
        is_active: m.is_active ?? true,
        notes: m.notes ?? null,
        updated_by: req.auth!.user_id,
      })
      .onConflictDoNothing({ target: models.model_id });
  }
  for (const u of parsed.data.updated as Array<{ after: ManifestEntry }>) {
    const m = u.after;
    await db
      .update(models)
      .set({
        display_name: m.display_name,
        input_per_mtok: m.input_per_mtok.toString(),
        output_per_mtok: m.output_per_mtok.toString(),
        cache_write_per_mtok: m.cache_write_per_mtok.toString(),
        cache_read_per_mtok: m.cache_read_per_mtok.toString(),
        tokenizer_factor: (m.tokenizer_factor ?? 1).toString(),
        web_fetch_unit_cost: (m.web_fetch_unit_cost ?? 0.01).toString(),
        web_search_unit_cost: (m.web_search_unit_cost ?? 0.01).toString(),
        notes: m.notes ?? null,
        updated_at: new Date(),
        updated_by: req.auth!.user_id,
      })
      .where(eq(models.model_id, m.model_id));
  }
  await audit({
    actor_user_id: req.auth!.user_id,
    action: 'admin.model.refresh.apply',
    metadata: { added_count: parsed.data.added.length, updated_count: parsed.data.updated.length },
    ip: req.ip,
  });
  res.status(204).end();
});
