// TP-5 — review queue: every pipeline-drafted change (strategy drafts,
// table drafts, watch hits, golden failures) lands here and nothing
// publishes without a human decision.
import { pgTable, uuid, text, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { users } from './users.js';

export const review_queue = pgTable(
  'review_queue',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').notNull(), // table-draft | watch-hit | strategy-refresh | strategy-draft | golden-failure
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    status: text('status').notNull().default('open'), // open | approved | rejected
    created_by: text('created_by').notNull().default('job'),
    decided_by: uuid('decided_by').references(() => users.id),
    decided_at: timestamp('decided_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    status_idx: index('review_queue_status_idx').on(t.status),
    kind_idx: index('review_queue_kind_idx').on(t.kind),
  }),
);

export type ReviewQueueItem = typeof review_queue.$inferSelect;
