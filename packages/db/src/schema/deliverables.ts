// TP-9 — rendered plan deliverables + signed delivery links. Artifacts
// are content-addressed (sha256 = storage filename) and registered on
// the client's Documents tab. Links are HMAC tokens; the row stores only
// sha256(token) so a DB leak can't mint download URLs.
import { pgTable, uuid, text, boolean, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { plans } from './plans.js';
import { users } from './users.js';

export const deliverables = pgTable(
  'deliverables',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    plan_id: uuid('plan_id')
      .notNull()
      .references(() => plans.id),
    kind: text('kind').notNull(), // advisor-pdf | client-pdf | handout | pitch-deck | slideshow
    status: text('status').notNull().default('queued'), // queued | rendering | ready | failed
    rendered_at: timestamp('rendered_at', { withTimezone: true }),
    sha256: text('sha256'),
    storage_ref: text('storage_ref'),
    delivered_via: text('delivered_via'), // portal | signed-link | staff-manual
    reveal_strategies: boolean('reveal_strategies').notNull().default(true),
    error: text('error'),
    created_by: uuid('created_by').references(() => users.id),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    plan_idx: index('deliverables_plan_idx').on(t.plan_id),
  }),
);

export const deliverable_links = pgTable(
  'deliverable_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deliverable_id: uuid('deliverable_id')
      .notNull()
      .references(() => deliverables.id, { onDelete: 'cascade' }),
    token_hash: text('token_hash').notNull(),
    expires_at: timestamp('expires_at', { withTimezone: true }).notNull(),
    revoked_at: timestamp('revoked_at', { withTimezone: true }),
    last_downloaded_at: timestamp('last_downloaded_at', { withTimezone: true }),
    created_by: uuid('created_by').references(() => users.id),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    token_uq: uniqueIndex('deliverable_links_token_uq').on(t.token_hash),
    deliverable_idx: index('deliverable_links_deliverable_idx').on(t.deliverable_id),
  }),
);

export type Deliverable = typeof deliverables.$inferSelect;
export type DeliverableLink = typeof deliverable_links.$inferSelect;
