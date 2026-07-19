// TP-2 — client records, the spine of the planning module. Local-only in
// this slice (per QUESTIONS.md): T&B provenance columns arrive later as an
// additive migration. merged_into_id ships now because archival retention
// (TP-11) depends on merge semantics.
import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  index,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { users } from './users.js';

export interface ClientContact {
  name?: string;
  email?: string;
  phone?: string;
  role?: string;
}

export const clients = pgTable(
  'clients',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    entity_type: text('entity_type').notNull().default('individual'),
    contacts: jsonb('contacts').$type<ClientContact[]>().notNull().default([]),
    // Set when this record has been merged into another client. Merged
    // rows are hidden from pickers/lists but never deleted — links that
    // predate the merge keep resolving.
    merged_into_id: uuid('merged_into_id').references((): AnyPgColumn => clients.id),
    created_by: uuid('created_by').references(() => users.id),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    name_idx: index('clients_name_idx').on(t.name),
    merged_idx: index('clients_merged_idx').on(t.merged_into_id),
  }),
);

export type Client = typeof clients.$inferSelect;
export type NewClient = typeof clients.$inferInsert;
