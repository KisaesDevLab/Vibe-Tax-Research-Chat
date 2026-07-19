// TP-4 — versioned table sets. Plans pin a table_set id at compute time;
// republishing content never touches an issued plan. Payload shape lives
// in @vibe/shared (TableSetPayload) so engine/api/web agree.
import { pgTable, uuid, integer, text, jsonb, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import type { TableSetPayload, TableSetSourceNote } from '@vibe/shared';
import { users } from './users.js';

export const table_sets = pgTable(
  'table_sets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tax_year: integer('tax_year').notNull(),
    version: integer('version').notNull(),
    status: text('status').notNull().default('draft'), // 'draft' | 'published'
    payload: jsonb('payload').$type<TableSetPayload>().notNull(),
    source_notes: jsonb('source_notes').$type<TableSetSourceNote[]>().notNull().default([]),
    published_by: uuid('published_by').references(() => users.id),
    published_at: timestamp('published_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    year_version_uq: uniqueIndex('table_sets_year_version_uq').on(t.tax_year, t.version),
  }),
);

export type TableSet = typeof table_sets.$inferSelect;
export type NewTableSet = typeof table_sets.$inferInsert;
