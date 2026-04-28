// v1.5 (Phase 32) — RAG reference library. Schema defined now so the table
// exists from the start; the ingestion + embedding pipeline lands in v1.5.
import { pgTable, uuid, text, integer, jsonb, timestamp } from 'drizzle-orm/pg-core';

export const reference_documents = pgTable('reference_documents', {
  id: uuid('id').primaryKey().defaultRandom(),
  title: text('title').notNull(),
  source: text('source').notNull(), // 'upload' | 'url'
  original_filename: text('original_filename'),
  mime_type: text('mime_type'),
  size_bytes: integer('size_bytes'),
  storage_path: text('storage_path'),
  full_text: text('full_text'),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
  visibility: text('visibility').notNull().default('firm'),
  created_by: uuid('created_by'),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// NOTE: pgvector column added in Phase 32 migration. Stored as text in v1 schema
// to avoid the pgvector extension dependency until the RAG pipeline ships.
export const reference_chunks = pgTable('reference_chunks', {
  id: uuid('id').primaryKey().defaultRandom(),
  document_id: uuid('document_id')
    .notNull()
    .references(() => reference_documents.id, { onDelete: 'cascade' }),
  chunk_index: integer('chunk_index').notNull(),
  text: text('text').notNull(),
  embedding: text('embedding'), // jsonb-encoded vector(1024) until pgvector lands
  char_start: integer('char_start').notNull(),
  char_end: integer('char_end').notNull(),
});

export type ReferenceDocument = typeof reference_documents.$inferSelect;
export type ReferenceChunk = typeof reference_chunks.$inferSelect;
