// Phase 24 — usage analytics.
import { pgTable, uuid, text, integer, numeric, date, timestamp, index, primaryKey } from 'drizzle-orm/pg-core';

export const usage_events = pgTable(
  'usage_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    user_id: uuid('user_id').notNull(),
    chat_id: uuid('chat_id').notNull(),
    message_id: uuid('message_id').notNull(),
    model_id: text('model_id').notNull(),
    input_tokens: integer('input_tokens').notNull(),
    output_tokens: integer('output_tokens').notNull(),
    cache_creation_input_tokens: integer('cache_creation_input_tokens').notNull(),
    cache_read_input_tokens: integer('cache_read_input_tokens').notNull(),
    web_fetch_calls: integer('web_fetch_calls').notNull().default(0),
    web_search_calls: integer('web_search_calls').notNull().default(0),
    cost_usd: numeric('cost_usd', { precision: 10, scale: 6 }).notNull(),
    occurred_at: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    occurred_idx: index('usage_events_occurred_idx').on(t.occurred_at),
    user_time_idx: index('usage_events_user_time_idx').on(t.user_id, t.occurred_at),
  }),
);

export const usage_daily = pgTable(
  'usage_daily',
  {
    day: date('day').notNull(),
    user_id: uuid('user_id').notNull(),
    model_id: text('model_id').notNull(),
    message_count: integer('message_count').notNull().default(0),
    total_tokens: integer('total_tokens').notNull().default(0),
    total_cost_usd: numeric('total_cost_usd', { precision: 12, scale: 4 }).notNull().default('0'),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.day, t.user_id, t.model_id] }),
  }),
);

export type UsageEvent = typeof usage_events.$inferSelect;
export type NewUsageEvent = typeof usage_events.$inferInsert;
