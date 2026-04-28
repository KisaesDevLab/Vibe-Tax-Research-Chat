// Phase 7-9 + 21 — skills, versions, sync runs, custom skills.
import { pgEnum, pgTable, uuid, text, boolean, jsonb, timestamp, index } from 'drizzle-orm/pg-core';

export const skillSourceEnum = pgEnum('skill_source', ['custom', 'anthropic', 'pack']);
export const skillStatusEnum = pgEnum('skill_status_field', ['stub', 'draft', 'reviewed', 'verified']);
export const skillVersionStatusEnum = pgEnum('skill_version_status', [
  'current',
  'superseded',
  'withdrawn',
]);
export const syncResultEnum = pgEnum('sync_result', ['success', 'partial', 'failed', 'preview']);
export const visibilityEnum = pgEnum('skill_visibility', ['firm', 'role:user', 'role:admin']);

export const skills = pgTable(
  'skills',
  {
    skill_id: text('skill_id').primaryKey(), // anthropic-issued
    source: skillSourceEnum('source').notNull(),
    local_slug: text('local_slug').notNull().unique(),
    display_name: text('display_name').notNull(),
    description: text('description').notNull(),
    category: text('category'),
    current_version: text('current_version').notNull(),
    github_path: text('github_path'),
    github_sha: text('github_sha'),
    status_field: skillStatusEnum('status_field').notNull().default('draft'),
    is_active: boolean('is_active').notNull().default(true),
    is_always_attached: boolean('is_always_attached').notNull().default(false),
    routing_keywords: text('routing_keywords').array().notNull().default([]),
    uploaded_at: timestamp('uploaded_at', { withTimezone: true }),
    retired_at: timestamp('retired_at', { withTimezone: true }),
  },
  (t) => ({
    active_idx: index('skills_active_idx').on(t.is_active),
    slug_idx: index('skills_slug_idx').on(t.local_slug),
  }),
);

export const skill_versions = pgTable('skill_versions', {
  id: uuid('id').primaryKey().defaultRandom(),
  skill_id: text('skill_id')
    .notNull()
    .references(() => skills.skill_id, { onDelete: 'cascade' }),
  upstream_sha: text('upstream_sha').notNull(),
  anthropic_skill_version: text('anthropic_skill_version').notNull(),
  status: skillVersionStatusEnum('status').notNull().default('current'),
  status_field: skillStatusEnum('status_field').notNull().default('draft'),
  changelog_excerpt: text('changelog_excerpt'),
  uploaded_at: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
  uploaded_by: uuid('uploaded_by'),
});

export const skills_sync_runs = pgTable('skills_sync_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  triggered_by: text('triggered_by').notNull(),
  pin_type: text('pin_type').notNull(),
  pin_value: text('pin_value').notNull(),
  resolved_sha: text('resolved_sha'),
  started_at: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finished_at: timestamp('finished_at', { withTimezone: true }),
  result: syncResultEnum('result').notNull().default('preview'),
  changes_summary: jsonb('changes_summary').$type<{
    added: string[];
    updated: string[];
    removed: string[];
    unchanged_count: number;
  }>(),
  applied_at: timestamp('applied_at', { withTimezone: true }),
  applied_by: uuid('applied_by'),
  error_message: text('error_message'),
});

export const custom_skills = pgTable(
  'custom_skills',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull().unique(), // slug, ^[a-z][a-z0-9-]{2,63}$
    display_name: text('display_name').notNull(),
    description: text('description').notNull(),
    category: text('category'),
    body_md: text('body_md').notNull(),
    references: jsonb('references').$type<Array<{ filename: string; content: string }>>().default([]),
    routing_keywords: text('routing_keywords').array().notNull().default([]),
    anthropic_skill_id: text('anthropic_skill_id'),
    anthropic_skill_version: text('anthropic_skill_version'),
    is_always_attached: boolean('is_always_attached').notNull().default(false),
    is_active: boolean('is_active').notNull().default(false),
    visibility: visibilityEnum('visibility').notNull().default('firm'),
    created_by: uuid('created_by').notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    active_idx: index('custom_skills_active_idx').on(t.is_active),
  }),
);

export type Skill = typeof skills.$inferSelect;
export type NewSkill = typeof skills.$inferInsert;
export type SkillVersion = typeof skill_versions.$inferSelect;
export type SyncRun = typeof skills_sync_runs.$inferSelect;
export type CustomSkill = typeof custom_skills.$inferSelect;
