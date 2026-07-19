// TP-10 — engagement endpoints on a plan: kick off the letter/invoice
// through the adapters (when configured), read state, and the audited
// admin manual override — the no-credentials operating mode.
import { Router } from 'express';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { getDb } from '@vibe/db';
import { engagements, plans, clients } from '@vibe/db/schema';
import { requireRole } from '../../middleware/auth.js';
import {
  ensureEngagement,
  applyEngagementUpdate,
  getSignatureProvider,
  getPaymentProvider,
  ProviderNotConfiguredError,
} from '../../lib/engagement/index.js';

export const engagementRouter = Router({ mergeParams: true });

const uuidSchema = z.string().uuid();

async function loadPlanWithClient(planId: string) {
  const db = getDb();
  const [plan] = await db.select().from(plans).where(eq(plans.id, planId)).limit(1);
  if (!plan) return null;
  const [client] = await db.select().from(clients).where(eq(clients.id, plan.client_id)).limit(1);
  const clientEmail = client?.contacts.find((c) => c.email)?.email ?? null;
  return { plan, clientName: client?.name ?? '—', clientEmail };
}

engagementRouter.get('/', async (req, res) => {
  const planId = (req.params as { id?: string }).id ?? '';
  if (!uuidSchema.safeParse(planId).success) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  const loaded = await loadPlanWithClient(planId);
  if (!loaded) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  // A GET must not create rows: below presented there is nothing to
  // engage, and the insert would give the draft plan a NO ACTION
  // dependent that blocks deletion. Return the default shape instead.
  if (!['presented', 'engaged', 'delivered', 'archived'].includes(loaded.plan.status)) {
    const [existing] = await getDb()
      .select()
      .from(engagements)
      .where(eq(engagements.plan_id, planId))
      .limit(1);
    res.json({
      engagement: existing ?? {
        plan_id: planId,
        letter_status: 'none',
        payment_status: 'none',
        events: [],
      },
    });
    return;
  }
  const engagement = await ensureEngagement(planId);
  res.json({ engagement });
});

// Letters and invoices go to real clients — they must never leave for a
// plan that hasn't cleared the review gate.
const PRESENTED_PLUS = ['presented', 'engaged', 'delivered'];

engagementRouter.post('/send-letter', async (req, res) => {
  const planId = (req.params as { id?: string }).id ?? '';
  if (!uuidSchema.safeParse(planId).success) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  const loaded = await loadPlanWithClient(planId);
  if (!loaded) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  if (!PRESENTED_PLUS.includes(loaded.plan.status)) {
    res.status(409).json({ error: 'plan_not_presented' });
    return;
  }
  try {
    const provider = getSignatureProvider();
    const { envelopeId } = await provider.createEnvelope({
      planId,
      planTitle: loaded.plan.title,
      clientName: loaded.clientName,
      flatFee: loaded.plan.fee_plan?.flatFee ?? null,
    });
    await applyEngagementUpdate(
      planId,
      {
        letter_status: 'sent',
        opensign_envelope_id: envelopeId,
        event: { source: 'opensign', kind: 'letter.sent' },
      },
      req.auth!.user_id,
    );
    res.json({ ok: true, envelope_id: envelopeId });
  } catch (err) {
    if (err instanceof ProviderNotConfiguredError) {
      res.status(503).json({ error: err.code, message: err.message });
      return;
    }
    res.status(502).json({ error: (err as Error).message });
  }
});

engagementRouter.post('/send-invoice', async (req, res) => {
  const planId = (req.params as { id?: string }).id ?? '';
  if (!uuidSchema.safeParse(planId).success) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  const loaded = await loadPlanWithClient(planId);
  if (!loaded) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  if (!PRESENTED_PLUS.includes(loaded.plan.status)) {
    res.status(409).json({ error: 'plan_not_presented' });
    return;
  }
  const amount = loaded.plan.fee_plan?.flatFee;
  if (!amount || amount <= 0) {
    res.status(400).json({ error: 'no_fee_configured' });
    return;
  }
  // send_invoice collection EMAILS the hosted invoice — without an
  // address it would sit undelivered in Stripe while the UI reported
  // success. Fail loud; the manual override covers out-of-band billing.
  if (!loaded.clientEmail) {
    res.status(400).json({ error: 'no_client_email' });
    return;
  }
  try {
    const provider = getPaymentProvider();
    const engagement = await ensureEngagement(planId);
    const attempt =
      engagement.events.filter((e) => e.source === 'stripe' && e.kind === 'invoice.sent').length +
      1;
    const { invoiceId, customerId } = await provider.createInvoice({
      planId,
      planTitle: loaded.plan.title,
      clientName: loaded.clientName,
      clientEmail: loaded.clientEmail,
      amount,
      customerId: engagement.stripe_customer_id,
      attempt,
    });
    await applyEngagementUpdate(
      planId,
      {
        payment_status: 'invoiced',
        stripe_invoice_id: invoiceId,
        stripe_customer_id: customerId,
        event: { source: 'stripe', kind: 'invoice.sent' },
      },
      req.auth!.user_id,
    );
    res.json({ ok: true, invoice_id: invoiceId });
  } catch (err) {
    if (err instanceof ProviderNotConfiguredError) {
      res.status(503).json({ error: err.code, message: err.message });
      return;
    }
    res.status(502).json({ error: (err as Error).message });
  }
});

// Admin manual override: record letter-signed / payment-received when
// the integrations aren't configured (or happened out of band).
const overrideSchema = z.object({
  step: z.enum(['letter-sent', 'letter-signed', 'invoice-sent', 'payment-received']),
});

engagementRouter.post('/override', requireRole('admin'), async (req, res) => {
  const planId = (req.params as { id?: string }).id ?? '';
  const parsed = overrideSchema.safeParse(req.body ?? {});
  if (!uuidSchema.safeParse(planId).success || !parsed.success) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  const loaded = await loadPlanWithClient(planId);
  if (!loaded) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  // Same gate as send-letter/send-invoice: engagement state must not be
  // recorded before the plan clears review. Below presented the plan
  // advance would silently no-op and a later draft-delete would drop the
  // row recording a real out-of-band signature/payment.
  if (!PRESENTED_PLUS.includes(loaded.plan.status)) {
    res.status(409).json({ error: 'plan_not_presented' });
    return;
  }
  const update =
    parsed.data.step === 'letter-sent'
      ? { letter_status: 'sent' }
      : parsed.data.step === 'letter-signed'
        ? { letter_status: 'signed' }
        : parsed.data.step === 'invoice-sent'
          ? { payment_status: 'invoiced' }
          : { payment_status: 'paid' };
  const { engaged } = await applyEngagementUpdate(
    planId,
    { ...update, event: { source: 'manual-override', kind: parsed.data.step } },
    req.auth!.user_id,
  );
  const engagement = await ensureEngagement(planId);
  res.json({ engagement, engaged });
});
