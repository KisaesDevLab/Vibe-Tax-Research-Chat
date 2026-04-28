// Phase 5 — anthropic key management + general settings.
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { audit } from '../../lib/audit.js';
import { getSetting, setSetting, deleteSetting } from '../../lib/settings-store.js';
import { fingerprint } from '../../lib/crypto.js';
import { validateKey } from '../../lib/anthropic/client.js';
import { SETTING_KEYS } from '@vibe/db/schema';

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
  // TODO Phase 6: validate model_id exists and is_active=true.
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
