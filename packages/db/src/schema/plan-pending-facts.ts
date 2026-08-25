// TP-8a — "Confirm as fact" pending list. Chat-confirmed statements park
// here per plan until "Promote to client" writes them into a new
// client_fact_patterns version (which stamps promoted_fact_pattern_id — a
// bare uuid on purpose: no FK, so this table stays decoupled from the
// fact-pattern lifecycle and a deleted version never blocks anything).
import { pgTable, uuid, text, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { plans } from './plans.js';
import { messages } from './messages.js';
import { users } from './users.js';

export const plan_pending_facts = pgTable(
  'plan_pending_facts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    plan_id: uuid('plan_id')
      .notNull()
      .references(() => plans.id, { onDelete: 'cascade' }),
    message_id: uuid('message_id').references(() => messages.id, { onDelete: 'set null' }),
    fact_path: text('fact_path'), // nullable — staff may leave unpathed
    text: text('text').notNull(), // the confirmed statement
    value: jsonb('value').$type<unknown>(),
    source: jsonb('source').$type<{
      documentId: string;
      page: number;
      span?: [number, number];
    } | null>(),
    method: text('method').notNull().default('chat_confirmed'),
    status: text('status').notNull().default('pending'), // pending | promoted | dismissed
    promoted_fact_pattern_id: uuid('promoted_fact_pattern_id'),
    created_by: uuid('created_by').references(() => users.id),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    plan_status_idx: index('plan_pending_facts_plan_idx').on(t.plan_id, t.status),
  }),
);

export type PlanPendingFact = typeof plan_pending_facts.$inferSelect;
export type NewPlanPendingFact = typeof plan_pending_facts.$inferInsert;
