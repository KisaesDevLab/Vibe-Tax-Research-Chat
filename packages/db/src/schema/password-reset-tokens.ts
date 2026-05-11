// Single-use password-reset tokens. Plaintext token lives only in the URL
// emailed to the user; the DB stores SHA-256 of it (same pattern as
// auth_refresh_tokens). claimed_at enforces one-time use; expires_at
// caps the validity window (1h by default per the reset router).
import { pgTable, uuid, text, timestamp, index } from 'drizzle-orm/pg-core';
import { users } from './users.js';

export const password_reset_tokens = pgTable(
  'password_reset_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    user_id: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    token_hash: text('token_hash').notNull().unique(),
    expires_at: timestamp('expires_at', { withTimezone: true }).notNull(),
    claimed_at: timestamp('claimed_at', { withTimezone: true }),
    // 'self_service' (user clicked Forgot password) | 'admin' (admin clicked Send reset email)
    created_via: text('created_via').notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    user_idx: index('pwd_reset_user_idx').on(t.user_id),
    expires_idx: index('pwd_reset_expires_idx').on(t.expires_at),
  }),
);

export type PasswordResetToken = typeof password_reset_tokens.$inferSelect;
export type NewPasswordResetToken = typeof password_reset_tokens.$inferInsert;
