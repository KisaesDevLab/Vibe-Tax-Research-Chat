// TP-10 — engagement adapters + core state machine, hardened in QA
// round 1. OpenSign and Stripe are env-driven; unconfigured adapters
// throw typed not_configured errors that the routes map to the
// manual-override operating mode. When BOTH the letter is signed and
// payment lands, the plan auto-advances presented → engaged.
//
// Concurrency invariants (webhooks arrive concurrently by design):
//   - ledger insert + state update are ONE transaction: a failure after
//     dedupe rolls the ledger back, so provider retries re-apply.
//   - the engagement row is locked (SELECT … FOR UPDATE) for the
//     read-modify-write, so concurrent signed+paid can't lose an update.
//   - transitions are MONOTONIC: 'signed' and 'paid' are terminal for
//     their fields except via the audited manual override.
import { and, eq } from 'drizzle-orm';
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
    planId: string;
    planTitle: string;
    clientName: string;
    flatFee: number | null;
  }): Promise<{ envelopeId: string }>;
}

export interface PaymentProvider {
  createInvoice(input: {
    planId: string;
    planTitle: string;
    clientName: string;
    /** First contact email — required upstream; invoices are emailed. */
    clientEmail: string;
    /** Whole dollars. */
    amount: number;
    /** Reused across sends once pinned on the engagement row. */
    customerId: string | null;
    /** Pinned invoice from the previous send, voided (best-effort)
     *  before minting the replacement so the client can't pay both. */
    previousInvoiceId: string | null;
    /** 1-based send attempt — scopes idempotency keys so a deliberate
     *  re-send mints a new invoice while a timeout retry replays. */
    attempt: number;
  }): Promise<{ invoiceId: string; customerId: string }>;
}

export function getSignatureProvider(): SignatureProvider {
  const base = process.env.OPENSIGN_BASE_URL;
  const key = process.env.OPENSIGN_API_KEY;
  if (!base || !key) throw new ProviderNotConfiguredError('opensign');
  return {
    async createEnvelope(input) {
      // plan_id rides in the envelope metadata so the signed webhook can
      // echo it back — the inbound handler requires payload.plan_id.
      const res = await fetch(`${base.replace(/\/+$/, '')}/api/v1/documents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-token': key },
        body: JSON.stringify({
          title: `Engagement letter — ${input.planTitle}`,
          merge_fields: { client_name: input.clientName, plan_fee: input.flatFee },
          metadata: { plan_id: input.planId },
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
  // Idempotency keys are scoped to the plan + send attempt (+ cents for
  // money-bearing calls): a timeout retry within an attempt replays
  // Stripe's cached response instead of minting duplicates, while a
  // deliberate re-send (next attempt) gets fresh keys — a reused key
  // with drifted params would otherwise 400 idempotency_error and block
  // sends for 24h.
  const call = async (path: string, form: Record<string, string>, idempotencyKey?: string) => {
    const res = await fetch(`https://api.stripe.com${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/x-www-form-urlencoded',
        ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
      },
      body: new URLSearchParams(form),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`stripe_${path.replace(/\W+/g, '_')}_failed_${res.status}`);
    return (await res.json()) as { id: string };
  };
  return {
    async createInvoice(input) {
      const cents = Math.round(input.amount * 100);
      const scope = `${input.planId}-a${input.attempt}`;
      // A deliberate re-send supersedes the previous invoice — void it
      // so the client can't pay the old email too. Best-effort: a void
      // fails if the invoice was already paid (the webhook records that
      // payment) or already voided; either way the re-send proceeds.
      if (input.previousInvoiceId) {
        await call(
          `/v1/invoices/${input.previousInvoiceId}/void`,
          {},
          `void-${scope}-${input.previousInvoiceId}`,
        ).catch(() => undefined);
      }
      // One customer per engagement, pinned on first send: a fresh
      // customer per attempt would strand a failed attempt's invoice
      // items where a later invoice could sweep them in.
      const customerId =
        input.customerId ??
        (
          await call(
            '/v1/customers',
            {
              name: input.clientName,
              email: input.clientEmail,
              description: `Tax plan client — ${input.planTitle}`,
            },
            `cust-${scope}`,
          )
        ).id;
      // Invoice FIRST — created INERT (no auto_advance), with pending
      // items excluded, then the line item attached directly to it, then
      // an explicit finalize. Three properties this ordering buys:
      //   - an orphaned item from a failed earlier attempt can never be
      //     swept into this invoice (a fee change can't over-bill);
      //   - a draft orphaned by a mid-sequence failure or timeout is
      //     harmless — it never finalizes, never emails, and never
      //     auto-pays at $0 (a $0-paid webhook would falsely mark the
      //     engagement paid);
      //   - a retry under the same attempt keys REPLAYS the cached
      //     create/item responses and simply completes the remaining
      //     steps — never deleting, so the replayed id stays valid.
      // send_invoice (not the charge_automatically default): the
      // customer has no payment method on file — Stripe emails the
      // hosted invoice on finalization instead of attempting a doomed
      // automatic charge. NOTE: that email depends on the account's
      // "Email finalized invoices to customers" setting (Stripe default
      // ON) — documented in docs/planning-module.md.
      const invoice = await call(
        '/v1/invoices',
        {
          customer: customerId,
          description: `${input.planTitle} — ${input.clientName}`,
          'metadata[plan_id]': input.planId,
          collection_method: 'send_invoice',
          days_until_due: '30',
          pending_invoice_items_behavior: 'exclude',
        },
        `inv-${scope}-${cents}`,
      );
      await call(
        '/v1/invoiceitems',
        {
          customer: customerId,
          invoice: invoice.id,
          currency: 'usd',
          amount: String(cents),
          description: input.planTitle,
        },
        `item-${scope}-${cents}`,
      );
      await call(
        `/v1/invoices/${invoice.id}/finalize`,
        { auto_advance: 'true' },
        `fin-${scope}-${cents}`,
      );
      return { invoiceId: invoice.id, customerId };
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

export interface EngagementUpdate {
  letter_status?: string;
  payment_status?: string;
  opensign_envelope_id?: string;
  stripe_invoice_id?: string;
  stripe_customer_id?: string;
  event: { source: string; kind: string; detail?: string };
}

/** Fields where forward progress must never be undone by a webhook. */
const TERMINAL_LETTER = 'signed';
const TERMINAL_PAYMENT = 'paid';

export interface EngagementApplyResult {
  engaged: boolean;
  /** True when the external event id was already processed. */
  replay: boolean;
}

/**
 * Applies an update atomically and auto-advances the plan when signed
 * AND paid. When `dedupe` is given, the webhook-event ledger insert
 * happens in the SAME transaction — a failure anywhere rolls the ledger
 * back so the provider's retry is re-applied rather than swallowed.
 */
export async function applyEngagementUpdate(
  planId: string,
  update: EngagementUpdate,
  actorUserId: string | null,
  dedupe?: { provider: string; externalEventId: string },
): Promise<EngagementApplyResult> {
  const db = getDb();
  const manual = update.event.source === 'manual-override';

  const outcome = await db.transaction(async (tx) => {
    if (dedupe) {
      const inserted = await tx
        .insert(webhook_events)
        .values({
          provider: dedupe.provider,
          external_event_id: dedupe.externalEventId,
          processed_at: new Date(),
        })
        .onConflictDoNothing()
        .returning({ id: webhook_events.id });
      if (inserted.length === 0) {
        return { engaged: false, replay: true, clientId: null, letter: '', payment: '' };
      }
    }

    // Ensure-then-lock: the row must exist before FOR UPDATE can pin it.
    await tx
      .insert(engagements)
      .values({ plan_id: planId })
      .onConflictDoNothing({ target: engagements.plan_id });
    const [engagement] = await tx
      .select()
      .from(engagements)
      .where(eq(engagements.plan_id, planId))
      .for('update')
      .limit(1);
    if (!engagement) throw new Error(`engagement row missing for plan ${planId}`);

    // Monotonic guards: a webhook can never move signed→anything or
    // paid→anything; only the audited manual override may.
    let letter = update.letter_status ?? engagement.letter_status;
    if (!manual && engagement.letter_status === TERMINAL_LETTER) letter = TERMINAL_LETTER;
    let payment = update.payment_status ?? engagement.payment_status;
    if (!manual && engagement.payment_status === TERMINAL_PAYMENT) payment = TERMINAL_PAYMENT;

    await tx
      .update(engagements)
      .set({
        letter_status: letter,
        payment_status: payment,
        opensign_envelope_id: update.opensign_envelope_id ?? engagement.opensign_envelope_id,
        stripe_invoice_id: update.stripe_invoice_id ?? engagement.stripe_invoice_id,
        stripe_customer_id: update.stripe_customer_id ?? engagement.stripe_customer_id,
        events: [...engagement.events, { at: new Date().toISOString(), ...update.event }],
        updated_at: new Date(),
      })
      .where(eq(engagements.id, engagement.id));

    let engaged = false;
    let clientId: string | null = null;
    if (letter === TERMINAL_LETTER && payment === TERMINAL_PAYMENT) {
      // Conditional update is the race guard: only one transaction can
      // flip presented → engaged.
      const advanced = await tx
        .update(plans)
        .set({ status: 'engaged', updated_at: new Date() })
        .where(and(eq(plans.id, planId), eq(plans.status, 'presented')))
        .returning({ client_id: plans.client_id });
      if (advanced.length > 0) {
        engaged = true;
        clientId = advanced[0]!.client_id;
      }
    }
    return { engaged, replay: false, clientId, letter, payment };
  });

  if (outcome.replay) return { engaged: false, replay: true };

  if (outcome.engaged) {
    logger.info({ planId }, 'plan auto-advanced to engaged');
    await audit({
      actor_user_id: actorUserId,
      action: 'plan.transition',
      target_type: 'plan',
      target_id: planId,
      metadata: {
        client_id: outcome.clientId,
        from: 'presented',
        to: 'engaged',
        via: 'engagement',
      },
    });
  }
  await audit({
    actor_user_id: actorUserId,
    action: 'engagement.update',
    target_type: 'plan',
    target_id: planId,
    metadata: { ...update.event, letter: outcome.letter, payment: outcome.payment },
  });
  return { engaged: outcome.engaged, replay: false };
}
