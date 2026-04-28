// Phase 23 — chat attachments.
import { pgTable, uuid, text, integer, boolean, timestamp, index } from 'drizzle-orm/pg-core';
import { chats } from './chats.js';
import { users } from './users.js';

export const chat_attachments = pgTable(
  'chat_attachments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    chat_id: uuid('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    uploaded_by: uuid('uploaded_by')
      .notNull()
      .references(() => users.id, { onDelete: 'set null' }),
    filename: text('filename').notNull(),
    mime_type: text('mime_type').notNull(),
    size_bytes: integer('size_bytes').notNull(),
    storage_path: text('storage_path').notNull(),
    full_text: text('full_text'),
    ocr_applied: boolean('ocr_applied').notNull().default(false),
    summary: text('summary'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    chat_idx: index('attachments_chat_idx').on(t.chat_id),
  }),
);

export type ChatAttachment = typeof chat_attachments.$inferSelect;
