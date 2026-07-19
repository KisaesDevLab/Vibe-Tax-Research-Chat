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
import { eq } from 'drizzle-orm';
import { getDb } from '@vibe/db';
import { plans } from '@vibe/db/schema';
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A signature-valid event whose plan_id is not a UUID (someone typed
 * metadata by hand in the provider dashboard) or matches no plan must be
 * ACKNOWLEDGED, not 500'd: throwing makes the provider retry a poison
 * event for days and can get the whole endpoint auto-disabled.
 */
async function resolvablePlan(planId: string): Promise<boolean> {
  if (!UUID_RE.test(planId)) return false;
  const [row] = await getDb()
    .select({ id: plans.id })
    .from(plans)
    .where(eq(plans.id, planId))
    .limit(1);
  return Boolean(row);
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
  let payload: {
    event_id?: string;
    type?: string;
    plan_id?: string;
    envelope_id?: string;
    metadata?: { plan_id?: string };
    document?: { id?: string; metadata?: { plan_id?: string } };
  };
  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch {
    res.status(400).json({ error: 'bad_payload' });
    return;
  }
  // The outbound envelope carries plan_id under metadata; accept the
  // natural echo shapes as well as a top-level plan_id so the round-trip
  // doesn't depend on OpenSign flattening the metadata for us.
  const planId =
    payload.plan_id ?? payload.metadata?.plan_id ?? payload.document?.metadata?.plan_id;
  if (!payload.event_id || !planId) {
    res.status(400).json({ error: 'missing_fields' });
    return;
  }
  if (!(await resolvablePlan(planId))) {
    logger.warn({ planId, type: payload.type }, 'opensign webhook for unresolvable plan ignored');
    res.status(200).json({ ok: true, ignored: true, reason: 'unknown_plan' });
    return;
  }
  // Only event types we actually handle mutate state. Everything else
  // (viewed, delivered, resent, …) is acknowledged WITHOUT touching the
  // engagement or the ledger — an unknown type must never downgrade
  // 'signed' back to 'sent', and not consuming the ledger keeps the
  // event replayable if a later version learns to handle it.
  const letterStatus =
    payload.type === 'document.signed'
      ? 'signed'
      : payload.type === 'document.declined'
        ? 'declined'
        : null;
  if (!letterStatus) {
    res.status(200).json({ ok: true, ignored: true });
    return;
  }
  const { applyEngagementUpdate } = await import('../../lib/engagement/index.js');
  const result = await applyEngagementUpdate(
    planId,
    {
      letter_status: letterStatus,
      opensign_envelope_id: payload.envelope_id ?? payload.document?.id,
      event: { source: 'opensign', kind: payload.type ?? 'unknown' },
    },
    null,
    { provider: 'opensign', externalEventId: payload.event_id },
  );
  res.status(200).json(result.replay ? { ok: true, replay: true } : { ok: true });
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
  // During webhook-secret rotation Stripe signs with BOTH secrets and the
  // header carries multiple v1= entries — accept if ANY matches, so a
  // roll never rejects valid events.
  const kvs = header
    .split(',')
    .map((p) => {
      const i = p.indexOf('=');
      return i === -1 ? null : ([p.slice(0, i).trim(), p.slice(i + 1)] as const);
    })
    .filter((p): p is readonly [string, string] => p !== null);
  const t = kvs.find(([k]) => k === 't')?.[1];
  const v1s = kvs.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!t || v1s.length === 0) {
    res.status(401).json({ error: 'no_signature' });
    return;
  }
  const ts = Number(t);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) {
    res.status(401).json({ error: 'timestamp_out_of_tolerance' });
    return;
  }
  const raw = Buffer.isBuffer(req.body) ? (req.body as Buffer) : Buffer.from('');
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${t}.${raw.toString('utf8')}`)
    .digest('hex');
  if (!v1s.some((v) => safeEqual(v, expected))) {
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
  if (!(await resolvablePlan(planId))) {
    logger.warn({ planId, type: payload.type }, 'stripe webhook for unresolvable plan ignored');
    res.status(200).json({ ok: true, ignored: true, reason: 'unknown_plan' });
    return;
  }
  // Stripe does not guarantee event ordering: an invoice.finalized
  // arriving after invoice.paid must not regress 'paid'. Only the two
  // types we handle mutate state; others are acknowledged untouched.
  const paymentStatus =
    payload.type === 'invoice.paid'
      ? 'paid'
      : payload.type === 'invoice.payment_failed'
        ? 'failed'
        : null;
  if (!paymentStatus) {
    res.status(200).json({ ok: true, ignored: true });
    return;
  }
  // When the engagement has a pinned invoice, events for a DIFFERENT
  // invoice that merely shares the plan metadata must not mutate payment
  // state — an orphaned or superseded invoice getting paid/failed out of
  // band would otherwise overwrite the tracked invoice's status. A null
  // pin still accepts (the manual dashboard-invoice flow).
  const eventInvoiceId = payload.data?.object?.id;
  const { engagements: engagementsTable } = await import('@vibe/db/schema');
  const [existingEngagement] = await getDb()
    .select({ stripe_invoice_id: engagementsTable.stripe_invoice_id })
    .from(engagementsTable)
    .where(eq(engagementsTable.plan_id, planId))
    .limit(1);
  if (
    existingEngagement?.stripe_invoice_id &&
    eventInvoiceId &&
    existingEngagement.stripe_invoice_id !== eventInvoiceId
  ) {
    logger.warn(
      { planId, eventInvoiceId, pinned: existingEngagement.stripe_invoice_id },
      'stripe webhook for non-pinned invoice ignored',
    );
    res.status(200).json({ ok: true, ignored: true, reason: 'invoice_mismatch' });
    return;
  }
  const { applyEngagementUpdate } = await import('../../lib/engagement/index.js');
  const result = await applyEngagementUpdate(
    planId,
    {
      payment_status: paymentStatus,
      stripe_invoice_id: payload.data?.object?.id,
      event: { source: 'stripe', kind: payload.type ?? 'unknown' },
    },
    null,
    { provider: 'stripe', externalEventId: payload.id },
  );
  res.status(200).json(result.replay ? { ok: true, replay: true } : { ok: true });
});
