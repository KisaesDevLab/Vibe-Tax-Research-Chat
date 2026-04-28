// Phase 3 — refresh tokens.
import { pgTable, uuid, text, timestamp, index } from 'drizzle-orm/pg-core';
import { users } from './users.js';

export const auth_refresh_tokens = pgTable(
  'auth_refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    user_id: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    token_hash: text('token_hash').notNull().unique(),
    expires_at: timestamp('expires_at', { withTimezone: true }).notNull(),
    rotated_at: timestamp('rotated_at', { withTimezone: true }),
    revoked_at: timestamp('revoked_at', { withTimezone: true }),
    user_agent: text('user_agent'),
    ip: text('ip'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    user_idx: index('refresh_user_idx').on(t.user_id),
    expires_idx: index('refresh_expires_idx').on(t.expires_at),
  }),
);

export type RefreshToken = typeof auth_refresh_tokens.$inferSelect;
export type NewRefreshToken = typeof auth_refresh_tokens.$inferInsert;
