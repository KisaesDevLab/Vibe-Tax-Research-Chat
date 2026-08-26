// Phase 6 — model registry.
import { pgTable, text, numeric, boolean, timestamp, uuid } from 'drizzle-orm/pg-core';

export const models = pgTable('models', {
  model_id: text('model_id').primaryKey(),
  display_name: text('display_name').notNull(),
  input_per_mtok: numeric('input_per_mtok', { precision: 10, scale: 4 }).notNull(),
  output_per_mtok: numeric('output_per_mtok', { precision: 10, scale: 4 }).notNull(),
  cache_write_per_mtok: numeric('cache_write_per_mtok', { precision: 10, scale: 4 }).notNull(),
  cache_read_per_mtok: numeric('cache_read_per_mtok', { precision: 10, scale: 4 }).notNull(),
  tokenizer_factor: numeric('tokenizer_factor', { precision: 6, scale: 3 })
    .notNull()
    .default('1.000'),
  web_fetch_unit_cost: numeric('web_fetch_unit_cost', { precision: 10, scale: 4 })
    .notNull()
    .default('0.0100'),
  web_search_unit_cost: numeric('web_search_unit_cost', { precision: 10, scale: 4 })
    .notNull()
    .default('0.0100'),
  web_tools_enabled: boolean('web_tools_enabled').notNull().default(true),
  fetches_per_turn: numeric('fetches_per_turn', { precision: 4, scale: 0 }).notNull().default('12'),
  searches_per_turn: numeric('searches_per_turn', { precision: 4, scale: 0 })
    .notNull()
    .default('10'),
  is_active: boolean('is_active').notNull().default(true),
  retired_at: timestamp('retired_at', { withTimezone: true }),
  notes: text('notes'),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updated_by: uuid('updated_by'),
});

export type Model = typeof models.$inferSelect;
export type NewModel = typeof models.$inferInsert;
