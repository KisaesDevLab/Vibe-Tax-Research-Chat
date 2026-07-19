// QA round 4 — the Stripe invoice sequence: inert-draft-first ordering,
// direct item attachment, explicit finalize, attempt-scoped idempotency
// keys, customer reuse. The ordering IS the safety property: an
// orphaned draft must be inert and a same-attempt retry must replay and
// complete rather than wedge.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getPaymentProvider } from './index.js';

interface Call {
  url: string;
  form: Record<string, string>;
  idempotencyKey: string | undefined;
}

const calls: Call[] = [];
let failOn: ((url: string) => boolean) | null = null;

function mockFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const form = Object.fromEntries(new URLSearchParams(String(init.body ?? '')));
      const headers = init.headers as Record<string, string>;
      calls.push({ url, form, idempotencyKey: headers['idempotency-key'] });
      if (failOn?.(url)) return new Response('{"error":{}}', { status: 500 });
      const id = url.includes('/customers')
        ? 'cus_test'
        : url.includes('/invoiceitems')
          ? 'ii_test'
          : 'in_test';
      return new Response(JSON.stringify({ id }), { status: 200 });
    }),
  );
}

const input = {
  planId: 'plan-1',
  planTitle: 'Plan',
  clientName: 'Client',
  clientEmail: 'client@example.com',
  amount: 1_000,
  customerId: null,
  attempt: 1,
};

describe('stripe createInvoice sequence', () => {
  beforeEach(() => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    calls.length = 0;
    failOn = null;
    mockFetch();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.STRIPE_SECRET_KEY;
  });

  it('creates customer → inert draft invoice → attached item → explicit finalize', async () => {
    const { invoiceId, customerId } = await getPaymentProvider().createInvoice(input);
    expect(invoiceId).toBe('in_test');
    expect(customerId).toBe('cus_test');
    expect(calls.map((c) => c.url)).toEqual([
      'https://api.stripe.com/v1/customers',
      'https://api.stripe.com/v1/invoices',
      'https://api.stripe.com/v1/invoiceitems',
      'https://api.stripe.com/v1/invoices/in_test/finalize',
    ]);
    const invoice = calls[1]!.form;
    // The draft must be INERT: no auto_advance at creation, pending
    // items excluded, send_invoice collection.
    expect(invoice.auto_advance).toBeUndefined();
    expect(invoice.pending_invoice_items_behavior).toBe('exclude');
    expect(invoice.collection_method).toBe('send_invoice');
    expect(invoice['metadata[plan_id]']).toBe('plan-1');
    // Item attaches directly to the invoice — never a floating pending
    // item a later invoice could sweep.
    expect(calls[2]!.form.invoice).toBe('in_test');
    expect(calls[2]!.form.amount).toBe('100000');
    // auto_advance arrives only at finalize.
    expect(calls[3]!.form.auto_advance).toBe('true');
  });

  it('scopes idempotency keys per attempt so retries replay and re-sends mint', async () => {
    await getPaymentProvider().createInvoice(input);
    expect(calls.map((c) => c.idempotencyKey)).toEqual([
      'cust-plan-1-a1',
      'inv-plan-1-a1-100000',
      'item-plan-1-a1-100000',
      'fin-plan-1-a1-100000',
    ]);
    calls.length = 0;
    await getPaymentProvider().createInvoice({ ...input, customerId: 'cus_test', attempt: 2 });
    expect(calls.map((c) => c.idempotencyKey)).toEqual([
      'inv-plan-1-a2-100000',
      'item-plan-1-a2-100000',
      'fin-plan-1-a2-100000',
    ]);
  });

  it('reuses the pinned customer without a create call', async () => {
    await getPaymentProvider().createInvoice({ ...input, customerId: 'cus_pinned' });
    expect(calls.some((c) => c.url.endsWith('/v1/customers'))).toBe(false);
    expect(calls[0]!.form.customer).toBe('cus_pinned');
  });

  it('a failed item call throws and leaves the draft in place (no DELETE)', async () => {
    failOn = (url) => url.includes('/invoiceitems');
    await expect(getPaymentProvider().createInvoice(input)).rejects.toThrow(
      /stripe_.*invoiceitems.*_500/,
    );
    // No finalize, no delete: the draft stays inert so the same-attempt
    // retry replays the create and completes the remaining steps.
    expect(calls.map((c) => c.url)).toEqual([
      'https://api.stripe.com/v1/customers',
      'https://api.stripe.com/v1/invoices',
      'https://api.stripe.com/v1/invoiceitems',
    ]);
  });
});
