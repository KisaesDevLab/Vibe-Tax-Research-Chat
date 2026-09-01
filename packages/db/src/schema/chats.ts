// Phase 13 — chats.
import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  index,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { users } from './users.js';
import { models } from './models.js';
import { clients } from './clients.js';
// Lazy circular reference (research-archives precedent): plans.ts sits in
// this module graph, so the FK target is deferred via AnyPgColumn.
import { plans } from './plans.js';

export const chats = pgTable(
  'chats',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    user_id: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull().default('Untitled chat'),
    default_model_id: text('default_model_id').references(() => models.model_id),
    pinned_pack_version: text('pinned_pack_version'),
    pii_disclosure_acknowledged: boolean('pii_disclosure_acknowledged').notNull().default(false),
    // Phase 32 — per-chat toggle for the firm reference library. Default
    // on so existing chats automatically benefit from any references the
    // firm admin has uploaded; researchers can flip it off per chat
    // (e.g., when authoring a memo that should rely solely on primary
    // authority).
    use_reference_library: boolean('use_reference_library').notNull().default(true),
    // Question mode — when on, the system prompt carries the interview
    // instruction (lib/anthropic/question-mode.ts): the model asks one
    // question per turn until it reaches 95% confidence, summarizes, and
    // waits for the researcher's signal before doing any research. Off by
    // default; researchers flip it per chat from the header chip.
    question_mode: boolean('question_mode').notNull().default(false),
    // TP-2 — soft link to a client (set from the active-client chip when
    // the chat is created, or promoted at archive time). SET NULL so a
    // client delete never takes chats with it.
    client_id: uuid('client_id').references(() => clients.id, { onDelete: 'set null' }),
    // TP-8a — plan-scoped chat mode. mode 'plan' switches the message
    // pipeline to the fact-snapshot + client-document-retrieval context;
    // strategy_id records the strategy under discussion for the preamble
    // and archive prefill. SET NULL: a plan delete demotes the chat to an
    // ordinary client chat rather than deleting it.
    plan_id: uuid('plan_id').references((): AnyPgColumn => plans.id, { onDelete: 'set null' }),
    mode: text('mode'), // null | 'plan'
    strategy_id: text('strategy_id'),
    archived_at: timestamp('archived_at', { withTimezone: true }),
    // TP-11 — "file to a client?" nudge dismissal for ≥90-day unfiled chats.
    nudge_dismissed_at: timestamp('nudge_dismissed_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    user_idx: index('chats_user_idx').on(t.user_id),
    updated_idx: index('chats_updated_idx').on(t.updated_at),
    client_idx: index('chats_client_idx').on(t.client_id),
    plan_idx: index('chats_plan_idx').on(t.plan_id),
  }),
);

export type Chat = typeof chats.$inferSelect;
export type NewChat = typeof chats.$inferInsert;
