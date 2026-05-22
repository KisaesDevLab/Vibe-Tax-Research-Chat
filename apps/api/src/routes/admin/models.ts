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
import {
  discoverAnthropicModels,
  type DiscoveredModel,
} from '../../lib/anthropic/models-discovery.js';

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
  // Set true when the entry was synthesized from an Anthropic Models
  // API discovery for which no pricing manifest entry exists. Admin
  // must edit pricing before this row can be applied.
  pricing_unknown?: boolean;
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

// Map an Anthropic Models API discovery result into our ManifestEntry
// shape by joining against the pricing manifest. Models present in the
// API but absent from the pricing manifest are emitted with
// pricing_unknown:true so the apply step can refuse them until an
// admin has set real pricing.
function mergeDiscoveryWithPricing(
  discovered: DiscoveredModel[],
  pricingManifest: { models: ManifestEntry[] } | null,
): ManifestEntry[] {
  const pricingById = new Map<string, ManifestEntry>(
    (pricingManifest?.models ?? []).map((m) => [m.model_id, m]),
  );
  const out: ManifestEntry[] = [];
  for (const d of discovered) {
    const pricing = pricingById.get(d.id);
    if (pricing) {
      // Use bundled pricing; let Anthropic's display_name override only
      // when the seed left it as the model id itself (typo guard).
      out.push({
        ...pricing,
        model_id: d.id,
        display_name: pricing.display_name || d.display_name,
      });
    } else {
      out.push({
        model_id: d.id,
        display_name: d.display_name,
        input_per_mtok: 0,
        output_per_mtok: 0,
        cache_write_per_mtok: 0,
        cache_read_per_mtok: 0,
        tokenizer_factor: 1,
        web_fetch_unit_cost: 0.01,
        web_search_unit_cost: 0.01,
        is_active: false,
        notes:
          'Discovered via Anthropic Models API; no pricing in bundled manifest. Set pricing before activating.',
        pricing_unknown: true,
      });
    }
  }
  return out;
}

adminModelsRouter.post('/refresh', async (_req, res) => {
  // Source-of-truth ladder:
  //   1. Anthropic Models API (admin's key) — authoritative for which
  //      models the appliance can invoke today. Returns id /
  //      display_name / capabilities but NOT pricing.
  //   2. Upstream manifest URL — pricing reference (currently a
  //      placeholder CDN; the 404 fallback was the only path until
  //      Anthropic discovery landed).
  //   3. Bundled seed at packages/db/seeds/models.json — pricing
  //      reference shipped inside @vibe/db. Always present.
  //
  // The Anthropic API call uses the encrypted admin-stored key. When
  // it succeeds, we cross-reference its results against the pricing
  // manifest (upstream OR bundled). When it fails (no key, network
  // error, non-2xx) we fall back to a pure-manifest diff so the
  // refresh button still works on a fresh appliance with no key set.
  let pricingManifest: { models: ManifestEntry[] } | null = null;
  let upstream_error: string | undefined;
  try {
    const r = await fetch(env.MODELS_MANIFEST_URL, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) {
      upstream_error = `HTTP ${r.status}`;
    } else {
      pricingManifest = (await r.json()) as { models: ManifestEntry[] };
    }
  } catch (err) {
    upstream_error = (err as Error).message;
  }
  if (!pricingManifest) {
    pricingManifest = await loadBundledManifest();
  }

  let manifest: { models: ManifestEntry[] } | null = null;
  let source: 'anthropic' | 'upstream' | 'bundled' = 'bundled';
  let discovery_error: string | undefined;

  const discovery = await discoverAnthropicModels();
  if (discovery.ok) {
    manifest = { models: mergeDiscoveryWithPricing(discovery.models, pricingManifest) };
    source = 'anthropic';
  } else {
    discovery_error = discovery.error;
    logger.warn(
      { discovery_error },
      'anthropic models discovery failed; falling back to manifest only',
    );
    if (pricingManifest) {
      manifest = pricingManifest;
      source = upstream_error ? 'bundled' : 'upstream';
    }
  }

  if (!manifest) {
    res.status(502).json({ error: 'manifest_unavailable', upstream_error, discovery_error });
    return;
  }

  // Diff against current DB rows.
  const current = await getDb().select().from(models);
  const byDbId = new Map(current.map((m) => [m.model_id, m]));
  const byManifestId = new Map(manifest.models.map((m) => [m.model_id, m]));

  const added: ManifestEntry[] = [];
  const updated: Array<{ model_id: string; before: unknown; after: ManifestEntry }> = [];
  const removed: Array<{ model_id: string; display_name: string }> = [];

  for (const m of manifest.models) {
    const cur = byDbId.get(m.model_id);
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
    if (cur.display_name !== m.display_name && m.display_name) {
      changedFields.display_name = [cur.display_name, m.display_name];
    }
    if (Object.keys(changedFields).length > 0) {
      updated.push({ model_id: m.model_id, before: changedFields, after: m });
    }
  }

  // Removed = in DB, not in the discovered list. We only compute
  // `removed[]` when the source is Anthropic — otherwise a stale
  // pricing manifest would mass-flag every model as removed.
  if (source === 'anthropic') {
    for (const cur of current) {
      if (!byManifestId.has(cur.model_id)) {
        removed.push({ model_id: cur.model_id, display_name: cur.display_name });
      }
    }
  }

  res.json({
    source,
    upstream_error,
    discovery_error,
    added,
    updated,
    removed,
    unchanged_count: current.length - updated.length - removed.length,
  });
});

const applySchema = z.object({
  added: z.array(z.any()).default([]),
  updated: z.array(z.any()).default([]),
  removed: z.array(z.any()).default([]),
});

adminModelsRouter.post('/refresh/apply', async (req, res) => {
  const parsed = applySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }

  // Refuse to insert added rows whose pricing was not supplied. The
  // refresh endpoint emits pricing_unknown:true for models surfaced
  // by the Anthropic Models API that have no entry in the pricing
  // manifest. Letting them through would create a $0-priced model
  // that silently undercounts spend until an admin notices.
  const addedEntries = parsed.data.added as ManifestEntry[];
  const unpriced = addedEntries.filter((m) => m.pricing_unknown);
  if (unpriced.length > 0) {
    res.status(400).json({
      error: 'pricing_required',
      detail: `Set pricing for these models before applying: ${unpriced.map((m) => m.model_id).join(', ')}`,
      model_ids: unpriced.map((m) => m.model_id),
    });
    return;
  }

  const db = getDb();
  for (const m of addedEntries) {
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
  // Removed models: soft-deactivate rather than hard-delete. Anthropic
  // may temporarily 404 a model (capacity blip, regional rollout) and
  // we should not lose pricing history, usage_events foreign keys, or
  // audit trail. The admin can re-activate via the Models page.
  for (const rem of parsed.data.removed as Array<{ model_id: string }>) {
    if (!rem.model_id) continue;
    // Guard: never auto-deactivate the current default model. If
    // Anthropic ever drops it from the list, surface a manual decision
    // rather than locking the appliance out of chat.
    const currentDefault = await getSetting<string>(SETTING_KEYS.DEFAULT_MODEL_ID);
    if (currentDefault === rem.model_id) {
      logger.warn(
        { model_id: rem.model_id },
        'refresh.apply: refusing to deactivate current default model; admin must choose a new default first',
      );
      continue;
    }
    await db
      .update(models)
      .set({
        is_active: false,
        notes: 'Auto-deactivated by refresh — no longer listed by Anthropic Models API',
        updated_at: new Date(),
        updated_by: req.auth!.user_id,
      })
      .where(eq(models.model_id, rem.model_id));
  }
  await audit({
    actor_user_id: req.auth!.user_id,
    action: 'admin.model.refresh.apply',
    metadata: {
      added_count: parsed.data.added.length,
      updated_count: parsed.data.updated.length,
      removed_count: parsed.data.removed.length,
    },
    ip: req.ip,
  });
  res.status(204).end();
});
