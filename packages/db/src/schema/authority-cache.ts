// v1.5 (Phase 34) — appliance-side authority cache. Schema defined in v1.
import { pgTable, uuid, text, jsonb, timestamp, index } from 'drizzle-orm/pg-core';

export const authority_cache = pgTable(
  'authority_cache',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    source: text('source').notNull(), // 'usc'|'cfr'|'irb'|'fr'|'dawson'|'govinfo'|'state_dor'
    cache_key: text('cache_key').notNull(),
    canonical_url: text('canonical_url').notNull(),
    raw_text: text('raw_text'),
    parsed_text: text('parsed_text'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
    fetched_at: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
    ttl_until: timestamp('ttl_until', { withTimezone: true }).notNull(),
    upstream_status: text('upstream_status'),
    upstream_etag: text('upstream_etag'),
    upstream_last_modified: text('upstream_last_modified'),
  },
  (t) => ({
    source_key_idx: index('authority_cache_source_key_idx').on(t.source, t.cache_key),
    ttl_idx: index('authority_cache_ttl_idx').on(t.ttl_until),
  }),
);

export type AuthorityCacheEntry = typeof authority_cache.$inferSelect;
