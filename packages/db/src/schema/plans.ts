// TP-6 — plans, scenarios, results, and the plan↔research bridge. The
// 0009 schema is designed to the full TP-8 workflow spec up front:
// review_state carries the partner checklist ticks; plan_results are
// pinned to {table_set, engine_version, strategy_versions} and become
// immutable once the plan is ≥ presented (app-enforced in TP-8, DB
// trigger in TP-15).
import {
  pgTable,
  uuid,
  text,
  integer,
  jsonb,
  numeric,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import type { BaselineProfile, StrategySelection, YearResult } from '@vibe/shared';
import { clients } from './clients.js';
import { users } from './users.js';
import { table_sets } from './table-sets.js';
import { research_archives } from './research-archives.js';

export const plans = pgTable(
  'plans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    client_id: uuid('client_id')
      .notNull()
      .references(() => clients.id),
    title: text('title').notNull().default('Untitled plan'),
    status: text('status').notNull().default('draft'),
    baseline_profile: jsonb('baseline_profile').$type<BaselineProfile>().notNull(),
    growth_pct: numeric('growth_pct', { precision: 5, scale: 2 }).notNull().default('3'),
    years: integer('years').notNull().default(5),
    table_set_id: uuid('table_set_id')
      .notNull()
      .references(() => table_sets.id),
    engine_version: text('engine_version').notNull(),
    fee_plan: jsonb('fee_plan').$type<{ flatFee?: number; note?: string }>(),
    assigned_to: uuid('assigned_to').references(() => users.id),
    reviewer_id: uuid('reviewer_id').references(() => users.id),
    review_state: jsonb('review_state').$type<Record<string, boolean>>().notNull().default({}),
    created_by: uuid('created_by').references(() => users.id),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    client_idx: index('plans_client_idx').on(t.client_id),
    status_idx: index('plans_status_idx').on(t.status),
  }),
);

export const plan_scenarios = pgTable(
  'plan_scenarios',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    plan_id: uuid('plan_id')
      .notNull()
      .references(() => plans.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    selections: jsonb('selections').$type<StrategySelection[]>().notNull().default([]),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    plan_idx: index('plan_scenarios_plan_idx').on(t.plan_id),
  }),
);

export const plan_results = pgTable(
  'plan_results',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    plan_id: uuid('plan_id')
      .notNull()
      .references(() => plans.id, { onDelete: 'cascade' }),
    // null scenario = the baseline row.
    scenario_id: uuid('scenario_id').references(() => plan_scenarios.id, {
      onDelete: 'cascade',
    }),
    year: integer('year').notNull(),
    result: jsonb('result').$type<YearResult>().notNull(),
    table_set_id: uuid('table_set_id')
      .notNull()
      .references(() => table_sets.id),
    engine_version: text('engine_version').notNull(),
    strategy_versions: jsonb('strategy_versions')
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    computed_at: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    plan_idx: index('plan_results_plan_idx').on(t.plan_id),
  }),
);

export const plan_research_links = pgTable(
  'plan_research_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    plan_id: uuid('plan_id')
      .notNull()
      .references(() => plans.id, { onDelete: 'cascade' }),
    strategy_id: text('strategy_id'),
    research_archive_id: uuid('research_archive_id')
      .notNull()
      .references(() => research_archives.id),
    created_by: uuid('created_by').references(() => users.id),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    plan_idx: index('plan_research_links_plan_idx').on(t.plan_id),
    uq: uniqueIndex('plan_research_links_uq').on(t.plan_id, t.strategy_id, t.research_archive_id),
  }),
);

export type Plan = typeof plans.$inferSelect;
export type PlanScenario = typeof plan_scenarios.$inferSelect;
export type PlanResult = typeof plan_results.$inferSelect;
export type PlanResearchLink = typeof plan_research_links.$inferSelect;
