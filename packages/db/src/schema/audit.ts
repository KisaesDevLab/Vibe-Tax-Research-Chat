// Phase 3 — audit log.
import { pgTable, uuid, text, jsonb, timestamp, index } from 'drizzle-orm/pg-core';

export const audit_log = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    actor_user_id: uuid('actor_user_id'),
    action: text('action').notNull(), // e.g., 'auth.login.success', 'admin.user.create'
    target_type: text('target_type'), // 'user' | 'setting' | 'skill' | ...
    target_id: text('target_id'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
    occurred_at: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    ip: text('ip'),
  },
  (t) => ({
    actor_time_idx: index('audit_actor_time_idx').on(t.actor_user_id, t.occurred_at),
    action_idx: index('audit_action_idx').on(t.action),
  }),
);

export type AuditEntry = typeof audit_log.$inferSelect;
export type NewAuditEntry = typeof audit_log.$inferInsert;
