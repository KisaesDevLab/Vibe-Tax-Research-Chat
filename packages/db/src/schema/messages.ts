// Phase 14 + 15 + 17 + 18 + 19 — messages and primary-source consultations.
import { pgEnum, pgTable, uuid, text, integer, numeric, jsonb, timestamp, boolean, index } from 'drizzle-orm/pg-core';
import { chats } from './chats.js';
import { models } from './models.js';

export const messageRoleEnum = pgEnum('message_role', ['user', 'assistant', 'system_note']);

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    chat_id: uuid('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    role: messageRoleEnum('role').notNull(),
    content: text('content').notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),

    // assistant-only fields
    model_id: text('model_id').references(() => models.model_id),
    stop_reason: text('stop_reason'),
    attached_skill_ids: text('attached_skill_ids').array(),
    attached_skill_versions: text('attached_skill_versions').array(),

    input_tokens: integer('input_tokens').notNull().default(0),
    output_tokens: integer('output_tokens').notNull().default(0),
    cache_creation_input_tokens: integer('cache_creation_input_tokens').notNull().default(0),
    cache_read_input_tokens: integer('cache_read_input_tokens').notNull().default(0),
    web_fetch_calls: integer('web_fetch_calls').notNull().default(0),
    web_search_calls: integer('web_search_calls').notNull().default(0),
    cost_usd: numeric('cost_usd', { precision: 10, scale: 6 }).notNull().default('0'),

    authorities: jsonb('authorities').$type<unknown[]>().default([]),
    compliance_check: jsonb('compliance_check').$type<Record<string, unknown>>(),
  },
  (t) => ({
    chat_idx: index('messages_chat_idx').on(t.chat_id),
    chat_time_idx: index('messages_chat_time_idx').on(t.chat_id, t.created_at),
  }),
);

export const primary_source_consultations = pgTable(
  'primary_source_consultations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    message_id: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    tool_name: text('tool_name').notNull(), // 'web_fetch' | 'web_search' | 'mcp:<name>'
    url: text('url'),
    query: text('query'),
    domain: text('domain'),
    fetched_at: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
    response_status: integer('response_status'),
    response_excerpt: text('response_excerpt'), // first 2KB
    cited_in_authorities: boolean('cited_in_authorities').notNull().default(false),
  },
  (t) => ({
    message_idx: index('psc_message_idx').on(t.message_id),
    domain_idx: index('psc_domain_idx').on(t.domain),
  }),
);

export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
export type Consultation = typeof primary_source_consultations.$inferSelect;
export type NewConsultation = typeof primary_source_consultations.$inferInsert;
