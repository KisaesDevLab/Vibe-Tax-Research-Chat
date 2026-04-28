// Phase 6 — model registry CRUD + manifest refresh + default-model.
import { Router } from 'express';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getDb } from '@vibe/db';
import { models } from '@vibe/db/schema';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { audit } from '../../lib/audit.js';
import { logger } from '../../lib/logger.js';
import { env } from '../../config/env.js';
import { getSetting } from '../../lib/settings-store.js';
import { SETTING_KEYS } from '@vibe/db/schema';

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
  // Guard: refuse to disable the model that's currently set as the
  // default. Without this, admins can lock every user out of chat with
  // a single PATCH — the next chat-send picks the saved default,
  // doesn't find it active, and 400s. They'd have to fix it via SQL.
  if (parsed.data.is_active === false) {
    const currentDefault = await getSetting<string>(SETTING_KEYS.DEFAULT_MODEL_ID);
    if (currentDefault === req.params.id) {
      res.status(409).json({
        error: 'cannot_disable_default_model',
        detail: 'Pick a different default model first under Admin → Models → Set default.',
      });
      return;
    }
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

// Resolve the bundled seed manifest. The seed file lives in the @vibe/db
// package so we walk up from this compiled file's location to find it.
// Compiled dist path: apps/api/dist/routes/admin/models.js
//   → ../../../../packages/db/seeds/models.json
async function loadBundledManifest(): Promise<{ models: ManifestEntry[] } | null> {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
      path.resolve(here, '../../../../packages/db/seeds/models.json'),
      // Fallback for ts-node / dev path: apps/api/src/routes/admin/models.ts
      path.resolve(here, '../../../../../packages/db/seeds/models.json'),
    ];
    for (const p of candidates) {
      try {
        const raw = await fs.readFile(p, 'utf-8');
        return JSON.parse(raw) as { models: ManifestEntry[] };
      } catch {
        // try next candidate
      }
    }
  } catch (err) {
    logger.warn({ err }, 'bundled manifest read failed');
  }
  return null;
}

adminModelsRouter.post('/refresh', async (_req, res) => {
  // Try the configured upstream URL first; on ANY failure (network,
  // non-2xx, parse error) fall back to the manifest bundled with @vibe/db.
  // The bundled file is the same one the seeder uses, so a fresh appliance
  // always has a working "Refresh from upstream" even before a real CDN
  // exists at MODELS_MANIFEST_URL.
  let manifest: { models: ManifestEntry[] } | null = null;
  let source: 'upstream' | 'bundled' = 'upstream';
  let upstream_error: string | undefined;
  try {
    const r = await fetch(env.MODELS_MANIFEST_URL, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) {
      upstream_error = `HTTP ${r.status}`;
    } else {
      manifest = (await r.json()) as { models: ManifestEntry[] };
    }
  } catch (err) {
    upstream_error = (err as Error).message;
  }
  if (!manifest) {
    logger.warn(
      { url: env.MODELS_MANIFEST_URL, upstream_error },
      'upstream manifest unreachable; falling back to bundled seed',
    );
    manifest = await loadBundledManifest();
    source = 'bundled';
  }
  if (!manifest) {
    res.status(502).json({ error: 'manifest_unavailable', upstream_error });
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

  res.json({
    source,
    upstream_error,
    added,
    updated,
    removed: [],
    unchanged_count: current.length - updated.length,
  });
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
