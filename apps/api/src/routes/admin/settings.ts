// Phase 5 — anthropic key management + general settings.
import { Router } from 'express';
import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import { getDb } from '@vibe/db';
import { models } from '@vibe/db/schema';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { audit } from '../../lib/audit.js';
import { getSetting, setSetting, deleteSetting } from '../../lib/settings-store.js';
import { fingerprint } from '../../lib/crypto.js';
import { validateKey } from '../../lib/anthropic/client.js';
import { SETTING_KEYS } from '@vibe/db/schema';
import {
  WEB_RESOURCE_SOURCES,
  MCP_IMPLEMENTED_SOURCES,
  getWebResourceStrategy,
  setWebResourceStrategy,
  type WebResourceMode,
  type WebResourceSource,
} from '../../lib/web-resource-strategy.js';

export const adminSettingsRouter = Router();
adminSettingsRouter.use(requireAuth, requireRole('admin'));

// ── Anthropic API key ────────────────────────────────────────────────────
const keySchema = z.object({
  api_key: z.string().min(20),
  validate: z.boolean().default(true),
});

adminSettingsRouter.get('/anthropic-key', async (_req, res) => {
  const key = await getSetting<string>(SETTING_KEYS.ANTHROPIC_API_KEY);
  if (!key) {
    res.json({ configured: false });
    return;
  }
  res.json({ configured: true, fingerprint: fingerprint(key) });
});

adminSettingsRouter.post('/anthropic-key', async (req, res) => {
  const parsed = keySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  if (parsed.data.validate) {
    const v = await validateKey(parsed.data.api_key);
    if (!v.ok) {
      // Never echo the key back, only the validation error.
      res.status(400).json({ error: 'key_validation_failed', detail: v.error });
      return;
    }
  }
  await setSetting(SETTING_KEYS.ANTHROPIC_API_KEY, parsed.data.api_key, {
    encrypted: true,
    updated_by: req.auth!.user_id,
  });
  await audit({
    actor_user_id: req.auth!.user_id,
    action: 'admin.settings.anthropic_key.set',
    metadata: { fingerprint: fingerprint(parsed.data.api_key) },
    ip: req.ip,
  });
  res.json({ ok: true, fingerprint: fingerprint(parsed.data.api_key) });
});

adminSettingsRouter.delete('/anthropic-key', async (req, res) => {
  await deleteSetting(SETTING_KEYS.ANTHROPIC_API_KEY);
  await audit({
    actor_user_id: req.auth!.user_id,
    action: 'admin.settings.anthropic_key.delete',
    ip: req.ip,
  });
  res.status(204).end();
});

// ── Default model ────────────────────────────────────────────────────────
const defaultModelSchema = z.object({ model_id: z.string().min(1) });

adminSettingsRouter.post('/default-model', async (req, res) => {
  const parsed = defaultModelSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  // Validate the model_id exists in the registry AND is active. A default
  // pointing at an unknown / retired model would silently break the next
  // chat turn with a 500 from the resolveModel step in messages.ts.
  const [m] = await getDb()
    .select({ model_id: models.model_id, is_active: models.is_active })
    .from(models)
    .where(and(eq(models.model_id, parsed.data.model_id), eq(models.is_active, true)))
    .limit(1);
  if (!m) {
    res.status(400).json({ error: 'unknown_or_inactive_model', model_id: parsed.data.model_id });
    return;
  }
  await setSetting(SETTING_KEYS.DEFAULT_MODEL_ID, parsed.data.model_id, {
    updated_by: req.auth!.user_id,
  });
  await audit({
    actor_user_id: req.auth!.user_id,
    action: 'admin.settings.default_model.set',
    metadata: { model_id: parsed.data.model_id },
    ip: req.ip,
  });
  res.json({ ok: true });
});

// ── Phase 36 — per-source web_resource_strategy ──────────────────────────
const webResourceStrategySchema = z.object({
  strategy: z.record(z.enum(WEB_RESOURCE_SOURCES), z.enum(['anthropic', 'mcp'])),
});

adminSettingsRouter.get('/web-resource-strategy', async (_req, res) => {
  const strategy = await getWebResourceStrategy();
  res.json({
    strategy,
    implemented: MCP_IMPLEMENTED_SOURCES,
    sources: WEB_RESOURCE_SOURCES,
  });
});

adminSettingsRouter.put('/web-resource-strategy', async (req, res) => {
  const parsed = webResourceStrategySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'bad_request', detail: parsed.error.flatten() });
    return;
  }
  // Reject any 'mcp' selection for a source whose authority-mcp impl is
  // still a stub — flipping an unimplemented source to mcp would just
  // make Claude burn a turn on a 501-bound tool call.
  const violators: WebResourceSource[] = [];
  for (const [src, mode] of Object.entries(parsed.data.strategy) as Array<
    [WebResourceSource, WebResourceMode]
  >) {
    if (mode === 'mcp' && !MCP_IMPLEMENTED_SOURCES.includes(src)) {
      violators.push(src);
    }
  }
  if (violators.length > 0) {
    res.status(400).json({
      error: 'mcp_not_implemented',
      sources: violators,
      message:
        'Selected sources have only stub authority-mcp implementations. ' +
        'Keep them on anthropic until the real fetcher ships.',
    });
    return;
  }
  // Fill in unspecified sources with the existing strategy so a partial
  // PUT doesn't silently revert the rest to the default.
  const current = await getWebResourceStrategy();
  const next = { ...current, ...parsed.data.strategy };
  await setWebResourceStrategy(next, req.auth!.user_id);
  await audit({
    actor_user_id: req.auth!.user_id,
    action: 'admin.settings.web_resource_strategy.set',
    metadata: { strategy: next },
    ip: req.ip,
  });
  res.json({ ok: true, strategy: next });
});

// ── Generic getter for non-secret settings ───────────────────────────────
adminSettingsRouter.get('/:key', async (req, res) => {
  // Refuse to surface encrypted settings via the generic getter.
  if (req.params.key === SETTING_KEYS.ANTHROPIC_API_KEY) {
    res.status(403).json({ error: 'use_dedicated_endpoint' });
    return;
  }
  const v = await getSetting(req.params.key);
  res.json({ key: req.params.key, value: v });
});
