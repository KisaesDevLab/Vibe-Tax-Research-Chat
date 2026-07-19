// Phase 8 — webhook receivers.
//
// IMPORTANT: this router is mounted with `express.raw({ type: '*/*' })` so
// `req.body` is the raw request bytes (Buffer) — GitHub computes the HMAC over
// the exact transmitted payload, not the JSON-parsed value. Re-parsing via
// `express.json()` and then `JSON.stringify(req.body)` would NOT produce
// byte-identical output (whitespace, key ordering, escape differences) and
// would reject otherwise-valid signatures.
import { Router } from 'express';
import crypto from 'node:crypto';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { audit } from '../../lib/audit.js';
import { skillsSyncQueue } from '../../jobs/queues.js';

export const webhooksRouter = Router();

// GitHub push webhook for skills repo. HMAC-verified via X-Hub-Signature-256.
webhooksRouter.post('/github', async (req, res) => {
  const secret = env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    res.status(503).json({ error: 'webhook_secret_not_configured' });
    return;
  }
  const sig = req.header('X-Hub-Signature-256');
  if (!sig) {
    res.status(401).json({ error: 'no_signature' });
    return;
  }
  const raw = Buffer.isBuffer(req.body) ? (req.body as Buffer) : Buffer.from('');
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
  let match = false;
  try {
    match =
      sig.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    match = false;
  }
  if (!match) {
    res.status(401).json({ error: 'bad_signature' });
    return;
  }
  const event = req.header('X-GitHub-Event');
  if (event !== 'push') {
    res.status(204).end();
    return;
  }
  // Schedule a dry-run.
  await skillsSyncQueue.add('webhook-dry-run', { triggered_by: 'webhook' });
  await audit({ action: 'webhook.github.push.received', metadata: { event }, ip: req.ip });
  logger.info('skills sync webhook accepted; dry-run queued');
  res.status(202).json({ accepted: true });
});

// ── TP-10 — engagement webhooks (OpenSign + Stripe) ─────────────────────
// Same raw-body + timingSafeEqual discipline. Both handlers are
// idempotent via the webhook_events ledger: a replayed event id is
// acknowledged 200 but changes nothing.

function safeEqual(a: string, b: string): boolean {
  try {
    return a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

// OpenSign: X-OpenSign-Signature = hex HMAC-SHA256 over the raw body.
webhooksRouter.post('/opensign', async (req, res) => {
  const secret = process.env.OPENSIGN_WEBHOOK_SECRET;
  if (!secret) {
    res.status(503).json({ error: 'webhook_secret_not_configured' });
    return;
  }
  const sig = req.header('X-OpenSign-Signature');
  if (!sig) {
    res.status(401).json({ error: 'no_signature' });
    return;
  }
  const raw = Buffer.isBuffer(req.body) ? (req.body as Buffer) : Buffer.from('');
  const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  if (!safeEqual(sig, expected)) {
    res.status(401).json({ error: 'bad_signature' });
    return;
  }
  let payload: { event_id?: string; type?: string; plan_id?: string; envelope_id?: string };
  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch {
    res.status(400).json({ error: 'bad_payload' });
    return;
  }
  if (!payload.event_id || !payload.plan_id) {
    res.status(400).json({ error: 'missing_fields' });
    return;
  }
  const { recordWebhookEvent, applyEngagementUpdate } =
    await import('../../lib/engagement/index.js');
  const fresh = await recordWebhookEvent('opensign', payload.event_id);
  if (!fresh) {
    res.status(200).json({ ok: true, replay: true });
    return;
  }
  const letterStatus =
    payload.type === 'document.signed'
      ? 'signed'
      : payload.type === 'document.declined'
        ? 'declined'
        : 'sent';
  await applyEngagementUpdate(
    payload.plan_id,
    {
      letter_status: letterStatus,
      opensign_envelope_id: payload.envelope_id,
      event: { source: 'opensign', kind: payload.type ?? 'unknown' },
    },
    null,
  );
  res.status(200).json({ ok: true });
});

// Stripe: Stripe-Signature: t=<ts>,v1=<hex hmac over `${t}.${raw}`>,
// verified manually (5-minute tolerance) so test fixtures can sign
// without SDK credentials.
webhooksRouter.post('/stripe', async (req, res) => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    res.status(503).json({ error: 'webhook_secret_not_configured' });
    return;
  }
  const header = req.header('Stripe-Signature') ?? '';
  const parts = Object.fromEntries(
    header
      .split(',')
      .map((p) => p.split('=') as [string, string])
      .filter((p) => p.length === 2),
  ) as { t?: string; v1?: string };
  if (!parts.t || !parts.v1) {
    res.status(401).json({ error: 'no_signature' });
    return;
  }
  const ts = Number(parts.t);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) {
    res.status(401).json({ error: 'timestamp_out_of_tolerance' });
    return;
  }
  const raw = Buffer.isBuffer(req.body) ? (req.body as Buffer) : Buffer.from('');
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${parts.t}.${raw.toString('utf8')}`)
    .digest('hex');
  if (!safeEqual(parts.v1, expected)) {
    res.status(401).json({ error: 'bad_signature' });
    return;
  }
  let payload: {
    id?: string;
    type?: string;
    data?: { object?: { id?: string; metadata?: { plan_id?: string } } };
  };
  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch {
    res.status(400).json({ error: 'bad_payload' });
    return;
  }
  const planId = payload.data?.object?.metadata?.plan_id;
  if (!payload.id || !planId) {
    res.status(400).json({ error: 'missing_fields' });
    return;
  }
  const { recordWebhookEvent, applyEngagementUpdate } =
    await import('../../lib/engagement/index.js');
  const fresh = await recordWebhookEvent('stripe', payload.id);
  if (!fresh) {
    res.status(200).json({ ok: true, replay: true });
    return;
  }
  const paymentStatus =
    payload.type === 'invoice.paid'
      ? 'paid'
      : payload.type === 'invoice.payment_failed'
        ? 'failed'
        : 'invoiced';
  await applyEngagementUpdate(
    planId,
    {
      payment_status: paymentStatus,
      stripe_invoice_id: payload.data?.object?.id,
      event: { source: 'stripe', kind: payload.type ?? 'unknown' },
    },
    null,
  );
  res.status(200).json({ ok: true });
});
