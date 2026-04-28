// Phase 2 — identity tables.
import { pgEnum, pgTable, uuid, text, boolean, numeric, timestamp, index } from 'drizzle-orm/pg-core';

export const roleEnum = pgEnum('user_role', ['admin', 'user', 'viewer']);

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull().unique(),
    password_hash: text('password_hash').notNull(),
    role: roleEnum('role').notNull().default('user'),
    display_name: text('display_name').notNull(),
    is_active: boolean('is_active').notNull().default(true),
    monthly_spend_cap_usd: numeric('monthly_spend_cap_usd', { precision: 10, scale: 2 }),
    can_override_model: boolean('can_override_model').notNull().default(true),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    last_login_at: timestamp('last_login_at', { withTimezone: true }),
    deleted_at: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => ({
    email_idx: index('users_email_idx').on(t.email),
    active_idx: index('users_active_idx').on(t.is_active),
  }),
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
