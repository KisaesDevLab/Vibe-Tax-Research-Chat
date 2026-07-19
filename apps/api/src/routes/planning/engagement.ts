// TP-10 — engagement endpoints on a plan: kick off the letter/invoice
// through the adapters (when configured), read state, and the audited
// admin manual override — the no-credentials operating mode.
import { Router } from 'express';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { getDb } from '@vibe/db';
import { plans, clients } from '@vibe/db/schema';
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
  return { plan, clientName: client?.name ?? '—' };
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
  const engagement = await ensureEngagement(planId);
  res.json({ engagement });
});

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
  try {
    const provider = getSignatureProvider();
    const { envelopeId } = await provider.createEnvelope({
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
  const amount = loaded.plan.fee_plan?.flatFee;
  if (!amount || amount <= 0) {
    res.status(400).json({ error: 'no_fee_configured' });
    return;
  }
  try {
    const provider = getPaymentProvider();
    const { invoiceId } = await provider.createInvoice({
      planTitle: loaded.plan.title,
      clientName: loaded.clientName,
      amount,
    });
    await applyEngagementUpdate(
      planId,
      {
        payment_status: 'invoiced',
        stripe_invoice_id: invoiceId,
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
