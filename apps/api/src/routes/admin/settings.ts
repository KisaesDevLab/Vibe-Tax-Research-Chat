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
  buildMailer,
  buildProviderFromDraft,
  resetMailer,
  renderTestEmail,
  type EmailConfig,
  type EmailProviderKind,
} from '../../lib/email/index.js';
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

// ── Email settings (SMTP / Resend) ───────────────────────────────────────
// The provider radio in the UI determines which secret slot is filled:
// EMAIL_SMTP_PASSWORD when provider=smtp, EMAIL_RESEND_API_KEY when
// provider=resend. Both are stored encrypted via the same seal/open
// pattern as the Anthropic key.

const smtpSettingsSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  secure: z.boolean(),
  user: z.string().min(1),
});

const emailSettingsSchema = z
  .object({
    provider: z.enum(['smtp', 'resend']),
    from_address: z.string().email(),
    from_name: z.string().min(1).max(120),
    smtp: smtpSettingsSchema.optional(),
    password: z.string().min(1).optional(),
    resend_api_key: z.string().min(1).optional(),
    validate: z.boolean().default(true),
  })
  .superRefine((v, ctx) => {
    if (v.provider === 'smtp' && !v.smtp) {
      ctx.addIssue({
        code: 'custom',
        path: ['smtp'],
        message: 'smtp config required when provider=smtp',
      });
    }
  });

adminSettingsRouter.get('/email', async (_req, res) => {
  const config = await getSetting<EmailConfig>(SETTING_KEYS.EMAIL_CONFIG);
  if (!config) {
    res.json({ configured: false });
    return;
  }
  // The has_secret flag tells the UI whether to require a fresh password/
  // api_key on the next save (no) or allow updating other fields without
  // re-typing it (yes).
  const secretKey =
    config.provider === 'smtp'
      ? SETTING_KEYS.EMAIL_SMTP_PASSWORD
      : SETTING_KEYS.EMAIL_RESEND_API_KEY;
  const secret = await getSetting<string>(secretKey);
  res.json({
    configured: true,
    provider: config.provider,
    from_address: config.from_address,
    from_name: config.from_name,
    smtp: config.smtp,
    has_secret: Boolean(secret),
    fingerprint: secret ? fingerprint(secret) : undefined,
  });
});

adminSettingsRouter.post('/email', async (req, res) => {
  const parsed = emailSettingsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'bad_request', detail: parsed.error.flatten() });
    return;
  }
  const { provider, from_address, from_name, smtp, password, resend_api_key, validate } =
    parsed.data;

  // Resolve the secret: prefer the freshly-supplied one; otherwise reuse
  // whatever's already encrypted in the DB for this provider. First-time
  // save MUST supply a secret.
  const existingSecretKey =
    provider === 'smtp' ? SETTING_KEYS.EMAIL_SMTP_PASSWORD : SETTING_KEYS.EMAIL_RESEND_API_KEY;
  const supplied = provider === 'smtp' ? password : resend_api_key;
  const existing = await getSetting<string>(existingSecretKey);
  const effectiveSecret = supplied ?? existing;
  if (!effectiveSecret) {
    res.status(400).json({ error: 'secret_required', detail: 'no password / api key on file' });
    return;
  }

  const draftConfig: EmailConfig = {
    provider,
    from_address,
    from_name,
    smtp: provider === 'smtp' ? smtp : undefined,
  };

  if (validate) {
    try {
      const probe = buildProviderFromDraft(draftConfig, effectiveSecret);
      await probe.verify();
    } catch (err) {
      res.status(400).json({
        error: 'email_validation_failed',
        detail: (err as Error).message,
      });
      return;
    }
  }

  await setSetting(SETTING_KEYS.EMAIL_CONFIG, draftConfig as unknown as Record<string, unknown>, {
    updated_by: req.auth!.user_id,
  });
  if (supplied) {
    // Rotate the other provider's secret out so a stale Resend key doesn't
    // linger when the admin switches to SMTP (and vice versa). Only the
    // chosen provider's secret stays encrypted in the DB.
    await setSetting(existingSecretKey, supplied, {
      encrypted: true,
      updated_by: req.auth!.user_id,
    });
    const otherKey =
      provider === 'smtp' ? SETTING_KEYS.EMAIL_RESEND_API_KEY : SETTING_KEYS.EMAIL_SMTP_PASSWORD;
    await deleteSetting(otherKey);
  }
  resetMailer();
  await audit({
    actor_user_id: req.auth!.user_id,
    action: 'admin.settings.email.set',
    metadata: {
      provider,
      from_address,
      from_name,
      rotated_secret: Boolean(supplied),
      fingerprint: fingerprint(effectiveSecret),
    },
    ip: req.ip,
  });
  res.json({ ok: true, fingerprint: fingerprint(effectiveSecret) });
});

adminSettingsRouter.delete('/email', async (req, res) => {
  await deleteSetting(SETTING_KEYS.EMAIL_CONFIG);
  await deleteSetting(SETTING_KEYS.EMAIL_SMTP_PASSWORD);
  await deleteSetting(SETTING_KEYS.EMAIL_RESEND_API_KEY);
  resetMailer();
  await audit({
    actor_user_id: req.auth!.user_id,
    action: 'admin.settings.email.delete',
    ip: req.ip,
  });
  res.status(204).end();
});

adminSettingsRouter.post('/email/send-test', async (req, res) => {
  const mailer = await buildMailer();
  if (!mailer) {
    res.status(400).json({ error: 'email_not_configured' });
    return;
  }
  try {
    await mailer.send({
      to: req.auth!.email,
      ...renderTestEmail(),
    });
  } catch (err) {
    res.status(502).json({ error: 'email_send_failed', detail: (err as Error).message });
    return;
  }
  await audit({
    actor_user_id: req.auth!.user_id,
    action: 'admin.settings.email.send_test',
    metadata: { to: req.auth!.email, provider: mailer.kind },
    ip: req.ip,
  });
  res.json({ ok: true, sent_to: req.auth!.email });
});

// ── App base URL (for password-reset links) ──────────────────────────────
// Plain string, no encryption needed. Used by the reset-email job to build
// /reset?token=... links. Settable independently so admins can update it
// without touching email config.
const appBaseUrlSchema = z.object({
  // Accept any URL; the reset job will append /reset?token=... so trailing
  // slashes are normalized away. Empty string deletes.
  url: z.string().url().or(z.literal('')),
});

adminSettingsRouter.get('/app-base-url', async (_req, res) => {
  const v = await getSetting<string>(SETTING_KEYS.APP_BASE_URL);
  res.json({ url: v ?? '' });
});

adminSettingsRouter.post('/app-base-url', async (req, res) => {
  const parsed = appBaseUrlSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'bad_request', detail: parsed.error.flatten() });
    return;
  }
  if (parsed.data.url === '') {
    await deleteSetting(SETTING_KEYS.APP_BASE_URL);
  } else {
    // Normalize trailing slash so callers don't have to.
    const url = parsed.data.url.replace(/\/+$/, '');
    await setSetting(SETTING_KEYS.APP_BASE_URL, url, { updated_by: req.auth!.user_id });
  }
  await audit({
    actor_user_id: req.auth!.user_id,
    action: 'admin.settings.app_base_url.set',
    metadata: { url: parsed.data.url },
    ip: req.ip,
  });
  res.json({ ok: true });
});

// ── TP-0 — planning module flag ──────────────────────────────────────────
// Master switch for the Planning + Clients modules. The web client reads
// the effective value from GET /api/config; this endpoint is the admin
// write path.
const planningEnabledSchema = z.object({ enabled: z.boolean() });

adminSettingsRouter.post('/planning-enabled', async (req, res) => {
  const parsed = planningEnabledSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  await setSetting(SETTING_KEYS.PLANNING_ENABLED, parsed.data.enabled, {
    updated_by: req.auth!.user_id,
  });
  await audit({
    actor_user_id: req.auth!.user_id,
    action: 'admin.settings.planning_enabled.set',
    metadata: { enabled: parsed.data.enabled },
    ip: req.ip,
  });
  res.json({ ok: true, enabled: parsed.data.enabled });
});

// Keep TS happy — provider is consumed via parsed.data.provider above, but
// the type import is otherwise just for the EmailConfig signature.
void (null as unknown as EmailProviderKind);

// ── Generic getter for non-secret settings ───────────────────────────────
const ENCRYPTED_KEYS_DENYLIST: ReadonlySet<string> = new Set([
  SETTING_KEYS.ANTHROPIC_API_KEY,
  SETTING_KEYS.EMAIL_SMTP_PASSWORD,
  SETTING_KEYS.EMAIL_RESEND_API_KEY,
]);

adminSettingsRouter.get('/:key', async (req, res) => {
  // Refuse to surface encrypted settings via the generic getter.
  if (ENCRYPTED_KEYS_DENYLIST.has(req.params.key)) {
    res.status(403).json({ error: 'use_dedicated_endpoint' });
    return;
  }
  const v = await getSetting(req.params.key);
  res.json({ key: req.params.key, value: v });
});
