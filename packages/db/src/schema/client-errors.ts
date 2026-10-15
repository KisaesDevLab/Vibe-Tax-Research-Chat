// Browser render failures reported by the SPA's error boundaries, so an admin
// can see "the Compliance panel threw on message X of chat Y" without anyone
// opening DevTools. One row per distinct failure (fingerprint), counted on
// repeat — a chat that crashes on every load is one row, not thousands.
// Identifiers and the error text only; never chat or document content.
import { pgTable, uuid, text, integer, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { users } from './users.js';

export const client_errors = pgTable(
  'client_errors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    fingerprint: text('fingerprint').notNull(),
    // 'panel' (one sidecar panel), 'app' (whole-page boundary), 'window'
    // (uncaught script error outside React).
    kind: text('kind').notNull(),
    // Panel name for kind='panel' (e.g. 'Compliance').
    source: text('source'),
    message: text('message').notNull(),
    stack: text('stack'),
    component_stack: text('component_stack'),
    route: text('route'),
    chat_id: uuid('chat_id'),
    message_id: uuid('message_id'),
    app_version: text('app_version'),
    user_agent: text('user_agent'),
    user_id: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    count: integer('count').notNull().default(1),
    first_seen_at: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    last_seen_at: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    fingerprint_idx: uniqueIndex('client_errors_fingerprint_idx').on(t.fingerprint),
    last_seen_idx: index('client_errors_last_seen_idx').on(t.last_seen_at),
  }),
);

export type ClientError = typeof client_errors.$inferSelect;
