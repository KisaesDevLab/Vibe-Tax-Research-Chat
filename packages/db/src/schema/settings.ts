// Phase 5 — settings KV (with encryption flag).
import { pgTable, text, jsonb, boolean, timestamp, uuid } from 'drizzle-orm/pg-core';

// JSONB stores any JSON-serializable value (including null for "explicitly unset").
export type SettingValue = Record<string, unknown> | string | number | boolean | null;

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').$type<SettingValue>(),
  is_encrypted: boolean('is_encrypted').notNull().default(false),
  updated_by: uuid('updated_by'),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type Setting = typeof settings.$inferSelect;
export type NewSetting = typeof settings.$inferInsert;

// Canonical setting keys used across the app.
export const SETTING_KEYS = {
  ANTHROPIC_API_KEY: 'anthropic_api_key',
  DEFAULT_MODEL_ID: 'default_model_id',
  SKILLS_REPO_REF: 'skills_repo_ref',
  WEB_RESOURCE_STRATEGY: 'web_resource_strategy',
  COMPLIANCE_BANNER_ENABLED: 'compliance_banner_enabled',
  PII_STRIP_ENABLED: 'pii_strip_enabled',
  HIDE_UNVERIFIED_CITATIONS: 'hide_unverified_citations',
  CHAT_RETENTION_DAYS: 'chat_retention_days',
  SHOW_SKILLS_PANEL: 'show_skills_panel',
  HAIKU_FALLBACK_ROUTING: 'haiku_fallback_routing',
  // Email + password-reset (added with the email-settings feature). The
  // SMTP password / Resend API key are stored as separate encrypted rows
  // so the same encrypt/fingerprint pattern as ANTHROPIC_API_KEY applies.
  EMAIL_CONFIG: 'email_config',
  EMAIL_SMTP_PASSWORD: 'email_smtp_password',
  EMAIL_RESEND_API_KEY: 'email_resend_api_key',
  // Public base URL used to build password-reset links (e.g.
  // `https://192.168.1.79/vibe-tax-research`). DB-backed so admins can
  // change it without redeploying.
  APP_BASE_URL: 'app_base_url',
  // TP-0 — master switch for the Planning + Clients modules
  // (MASTER-BUILD-PLAN.md). Off = research app behaves exactly as before.
  PLANNING_ENABLED: 'planning_enabled',
  // TP-14 — allow Claude to draft plan memos (always draft-labeled;
  // endpoint returns 503 when no key is configured). Off by default.
  PLAN_MEMOS_ENABLED: 'plan_memos_enabled',
} as const;
