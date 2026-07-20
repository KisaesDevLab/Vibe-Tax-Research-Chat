// TP-5 — strategy registry: content is hot-updatable rows; math is
// TypeScript modules compiled into the server image, addressed
// `id@semver` via apply_module_ref. Publishing bumps
// strategies.current_version_id; issued plans keep the version they
// were computed with.
import {
  pgTable,
  uuid,
  text,
  integer,
  jsonb,
  numeric,
  timestamp,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { users } from './users.js';
import { table_sets } from './table-sets.js';

export const strategies = pgTable('strategies', {
  id: text('id').primaryKey(), // kebab-case slug, immutable
  current_version_id: uuid('current_version_id'),
  // Retired strategies disappear from the picker/suggest and the
  // refresh sweep, but plans that already pinned a version keep
  // computing — retirement is a soft removal, never a delete (versions
  // are FK'd by plan history).
  retired_at: timestamp('retired_at', { withTimezone: true }),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const strategy_versions = pgTable(
  'strategy_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    strategy_id: text('strategy_id')
      .notNull()
      .references(() => strategies.id),
    semver: text('semver').notNull(),
    status: text('status').notNull().default('draft'), // draft|in-review|published|deprecated|rejected
    /** Full authored record per docs/strategy-schema.md (advisor/client/engagement…). */
    content: jsonb('content').$type<Record<string, unknown>>().notNull(),
    inputs_schema: jsonb('inputs_schema').$type<Record<string, unknown>>(),
    suggest_rule: jsonb('suggest_rule').$type<Record<string, unknown>>(),
    apply_module_ref: text('apply_module_ref'), // `id@semver` | null (advisory)
    apply_order: integer('apply_order'),
    effective_from: integer('effective_from'),
    effective_to: integer('effective_to'),
    reviewed_by: uuid('reviewed_by').references(() => users.id),
    change_note: text('change_note'),
    created_by: text('created_by').notNull().default('human'), // 'human' | 'pipeline'
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    strategy_semver_uq: uniqueIndex('strategy_versions_strategy_semver_uq').on(
      t.strategy_id,
      t.semver,
    ),
    strategy_idx: index('strategy_versions_strategy_idx').on(t.strategy_id),
  }),
);

export const golden_tests = pgTable(
  'golden_tests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    strategy_version_id: uuid('strategy_version_id')
      .notNull()
      .references(() => strategy_versions.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    profile: jsonb('profile').$type<Record<string, unknown>>().notNull(),
    params: jsonb('params').$type<Record<string, unknown>>().notNull().default({}),
    expected: jsonb('expected').$type<Record<string, number>>().notNull(),
    tolerance: numeric('tolerance', { precision: 10, scale: 2 }).notNull().default('1'),
    pinned_table_set_id: uuid('pinned_table_set_id').references(() => table_sets.id),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    version_idx: index('golden_tests_version_idx').on(t.strategy_version_id),
  }),
);

export type Strategy = typeof strategies.$inferSelect;
export type StrategyVersion = typeof strategy_versions.$inferSelect;
export type GoldenTest = typeof golden_tests.$inferSelect;
