// Phase 13 — chats.
import { pgTable, uuid, text, boolean, timestamp, index } from 'drizzle-orm/pg-core';
import { users } from './users.js';
import { models } from './models.js';

export const chats = pgTable(
  'chats',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    user_id: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull().default('Untitled chat'),
    default_model_id: text('default_model_id').references(() => models.model_id),
    pinned_pack_version: text('pinned_pack_version'),
    pii_disclosure_acknowledged: boolean('pii_disclosure_acknowledged').notNull().default(false),
    // Phase 32 — per-chat toggle for the firm reference library. Default
    // on so existing chats automatically benefit from any references the
    // firm admin has uploaded; researchers can flip it off per chat
    // (e.g., when authoring a memo that should rely solely on primary
    // authority).
    use_reference_library: boolean('use_reference_library').notNull().default(true),
    archived_at: timestamp('archived_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    user_idx: index('chats_user_idx').on(t.user_id),
    updated_idx: index('chats_updated_idx').on(t.updated_at),
  }),
);

export type Chat = typeof chats.$inferSelect;
export type NewChat = typeof chats.$inferInsert;
