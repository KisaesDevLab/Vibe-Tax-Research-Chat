// TP-10 — engagement state (letter + payment) and the webhook
// idempotency ledger. unique(provider, external_event_id) makes replays
// no-ops.
import { pgTable, uuid, text, jsonb, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { plans } from './plans.js';

export const engagements = pgTable(
  'engagements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    plan_id: uuid('plan_id')
      .notNull()
      .references(() => plans.id),
    letter_status: text('letter_status').notNull().default('none'), // none|sent|signed|declined
    payment_status: text('payment_status').notNull().default('none'), // none|invoiced|paid|failed
    opensign_envelope_id: text('opensign_envelope_id'),
    stripe_invoice_id: text('stripe_invoice_id'),
    // Pinned on first invoice send and reused: re-minting a customer per
    // attempt let orphaned invoice items from a failed attempt get swept
    // into a later invoice.
    stripe_customer_id: text('stripe_customer_id'),
    events: jsonb('events')
      .$type<Array<{ at: string; source: string; kind: string; detail?: string }>>()
      .notNull()
      .default([]),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    plan_uq: uniqueIndex('engagements_plan_uq').on(t.plan_id),
  }),
);

export const webhook_events = pgTable(
  'webhook_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    provider: text('provider').notNull(), // 'opensign' | 'stripe'
    external_event_id: text('external_event_id').notNull(),
    received_at: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    processed_at: timestamp('processed_at', { withTimezone: true }),
  },
  (t) => ({
    provider_event_uq: uniqueIndex('webhook_events_provider_event_uq').on(
      t.provider,
      t.external_event_id,
    ),
    provider_idx: index('webhook_events_provider_idx').on(t.provider),
  }),
);

export type Engagement = typeof engagements.$inferSelect;
