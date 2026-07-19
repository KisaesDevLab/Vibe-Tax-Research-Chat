// TP-10 — engagement adapters + core state machine. OpenSign and Stripe
// are env-driven; unconfigured adapters throw typed not_configured
// errors that the routes map to the manual-override operating mode.
// When BOTH the letter is signed and payment lands, the plan
// auto-advances presented → engaged (names unlock in deliverables).
import { eq } from 'drizzle-orm';
import { getDb } from '@vibe/db';
import { engagements, plans, webhook_events } from '@vibe/db/schema';
import { audit } from '../audit.js';
import { logger } from '../logger.js';

export class ProviderNotConfiguredError extends Error {
  code = 'not_configured' as const;
  constructor(provider: string) {
    super(`${provider} is not configured — use the manual override to record this step.`);
  }
}

export interface SignatureProvider {
  createEnvelope(input: {
    planTitle: string;
    clientName: string;
    flatFee: number | null;
  }): Promise<{ envelopeId: string }>;
}

export interface PaymentProvider {
  createInvoice(input: {
    planTitle: string;
    clientName: string;
    amount: number;
  }): Promise<{ invoiceId: string }>;
}

export function getSignatureProvider(): SignatureProvider {
  const base = process.env.OPENSIGN_BASE_URL;
  const key = process.env.OPENSIGN_API_KEY;
  if (!base || !key) throw new ProviderNotConfiguredError('opensign');
  return {
    async createEnvelope(input) {
      const res = await fetch(`${base.replace(/\/+$/, '')}/api/v1/documents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-token': key },
        body: JSON.stringify({
          title: `Engagement letter — ${input.planTitle}`,
          merge_fields: { client_name: input.clientName, plan_fee: input.flatFee },
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`opensign_create_failed_${res.status}`);
      const body = (await res.json()) as { id?: string; objectId?: string };
      return { envelopeId: body.id ?? body.objectId ?? 'unknown' };
    },
  };
}

export function getPaymentProvider(): PaymentProvider {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new ProviderNotConfiguredError('stripe');
  return {
    async createInvoice(input) {
      const res = await fetch('https://api.stripe.com/v1/invoices', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${key}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          description: `${input.planTitle} — ${input.clientName}`,
          currency: 'usd',
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`stripe_create_failed_${res.status}`);
      const body = (await res.json()) as { id: string };
      return { invoiceId: body.id };
    },
  };
}

export async function ensureEngagement(planId: string) {
  const db = getDb();
  const [existing] = await db
    .select()
    .from(engagements)
    .where(eq(engagements.plan_id, planId))
    .limit(1);
  if (existing) return existing;
  const [row] = await db
    .insert(engagements)
    .values({ plan_id: planId })
    .onConflictDoNothing({ target: engagements.plan_id })
    .returning();
  if (row) return row;
  const [raced] = await db
    .select()
    .from(engagements)
    .where(eq(engagements.plan_id, planId))
    .limit(1);
  return raced!;
}

/** Idempotency: returns false when this provider event was already seen. */
export async function recordWebhookEvent(
  provider: string,
  externalEventId: string,
): Promise<boolean> {
  const inserted = await getDb()
    .insert(webhook_events)
    .values({ provider, external_event_id: externalEventId, processed_at: new Date() })
    .onConflictDoNothing()
    .returning({ id: webhook_events.id });
  return inserted.length > 0;
}

export interface EngagementUpdate {
  letter_status?: string;
  payment_status?: string;
  opensign_envelope_id?: string;
  stripe_invoice_id?: string;
  event: { source: string; kind: string; detail?: string };
}

/** Applies an update and auto-advances the plan when signed AND paid. */
export async function applyEngagementUpdate(
  planId: string,
  update: EngagementUpdate,
  actorUserId: string | null,
): Promise<{ engaged: boolean }> {
  const db = getDb();
  const engagement = await ensureEngagement(planId);
  const next = {
    letter_status: update.letter_status ?? engagement.letter_status,
    payment_status: update.payment_status ?? engagement.payment_status,
    opensign_envelope_id: update.opensign_envelope_id ?? engagement.opensign_envelope_id,
    stripe_invoice_id: update.stripe_invoice_id ?? engagement.stripe_invoice_id,
    events: [...engagement.events, { at: new Date().toISOString(), ...update.event }],
    updated_at: new Date(),
  };
  await db.update(engagements).set(next).where(eq(engagements.id, engagement.id));

  let engaged = false;
  if (next.letter_status === 'signed' && next.payment_status === 'paid') {
    const [plan] = await db.select().from(plans).where(eq(plans.id, planId)).limit(1);
    if (plan && plan.status === 'presented') {
      await db
        .update(plans)
        .set({ status: 'engaged', updated_at: new Date() })
        .where(eq(plans.id, planId));
      engaged = true;
      logger.info({ planId }, 'plan auto-advanced to engaged');
      await audit({
        actor_user_id: actorUserId,
        action: 'plan.transition',
        target_type: 'plan',
        target_id: planId,
        metadata: {
          client_id: plan.client_id,
          from: 'presented',
          to: 'engaged',
          via: 'engagement',
        },
      });
    }
  }
  await audit({
    actor_user_id: actorUserId,
    action: 'engagement.update',
    target_type: 'plan',
    target_id: planId,
    metadata: { ...update.event, letter: next.letter_status, payment: next.payment_status },
  });
  return { engaged };
}
