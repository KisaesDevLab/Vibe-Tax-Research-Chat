// SSO (Vibe Auth) — the three tables @kisaesdevlab/vibe-auth's query-backed
// stores expect, plus our own auth_sessions_oidc.
//
// auth_identities / auth_settings / auth_revocations mirror the package's
// shipped fragment (packages/client/src/sql/drizzle.ts) column-for-column and
// index-name-for-index-name, so the package's `$1` SQL keeps working. The one
// deliberate difference: user_id is a real uuid FK onto users (the package
// ships TEXT so it fits int keys too) — Postgres coerces the package's text
// params, and a deleted user takes their identity links with them.
//
// auth_sessions_oidc is ours. Sessions are stateless JWTs, so the identity
// behind an SSO login (issuer, subject, IdP session id, ID token for
// RP-initiated logout) is parked here keyed by the `sid` claim the SSO-born
// access token carries. The same row briefly holds the one-time hand-off code
// (sha256) the callback lands on the SPA with; POST /api/auth/sso/exchange
// claims it atomically and mints the ordinary access + refresh pair.
import {
  boolean,
  bigserial,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './users.js';

export const auth_identities = pgTable(
  'auth_identities',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    user_id: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    issuer: text('issuer').notNull(),
    subject: text('subject').notNull(),
    email: text('email'),
    email_verified: boolean('email_verified').notNull().default(false),
    last_login_at: timestamp('last_login_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    issuer_subject_uq: uniqueIndex('auth_identities_issuer_subject_uq').on(t.issuer, t.subject),
    user_idx: index('auth_identities_user_id_idx').on(t.user_id),
  }),
);

// Settings → Authentication values (mode, issuer, wrapped client secret, role map…).
export const auth_settings = pgTable('auth_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').$type<Record<string, unknown>>().notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// Revocation list (D16). Keys: "u:<user_id>" or "s:<sid>". Tokens issued at or
// before revoked_at are rejected until revoked_until.
export const auth_revocations = pgTable(
  'auth_revocations',
  {
    subject_key: text('subject_key').primaryKey(),
    revoked_at: timestamp('revoked_at', { withTimezone: true }).notNull().defaultNow(),
    revoked_until: timestamp('revoked_until', { withTimezone: true }).notNull(),
  },
  (t) => ({
    until_idx: index('auth_revocations_until_idx').on(t.revoked_until),
  }),
);

export const auth_sessions_oidc = pgTable(
  'auth_sessions_oidc',
  {
    sid: text('sid').primaryKey(),
    user_id: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    issuer: text('issuer').notNull(),
    subject: text('subject').notNull(),
    oidc_sid: text('oidc_sid'),
    id_token: text('id_token'),
    // One-time hand-off: sha256 of the code on the post-login fragment.
    handoff_hash: text('handoff_hash').unique(),
    handoff_expires_at: timestamp('handoff_expires_at', { withTimezone: true }),
    handoff_claimed_at: timestamp('handoff_claimed_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    user_idx: index('auth_sessions_oidc_user_id_idx').on(t.user_id),
    issuer_subject_idx: index('auth_sessions_oidc_issuer_subject_idx').on(t.issuer, t.subject),
    oidc_sid_idx: index('auth_sessions_oidc_oidc_sid_idx').on(t.oidc_sid),
  }),
);

export type AuthIdentity = typeof auth_identities.$inferSelect;
export type AuthSessionOidc = typeof auth_sessions_oidc.$inferSelect;
