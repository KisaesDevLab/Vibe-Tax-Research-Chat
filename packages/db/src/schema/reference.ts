// v1.5 (Phase 32) — RAG reference library.
//
// reference_documents holds the originals (firm-uploaded PDFs/DOCX/MD/HTML/TXT
// research memos), reference_chunks holds the segmented + embedded form
// retrieved at chat time. Embeddings are 1024-dim to match Voyage AI
// `voyage-3-large` (the default provider) and BGE-M3 (the alt for
// air-gapped customers running their own embeddings).
//
// The `vector` type and the HNSW cosine index require the `vector`
// extension (pgvector). The standalone postgres image was switched from
// `postgres:16-alpine` to `pgvector/pgvector:pg16` in compose; the
// appliance manifest declares `postgresExtensions: ["vector"]` so the
// shared parent Postgres has it too.
import {
  pgTable,
  pgEnum,
  uuid,
  text,
  integer,
  jsonb,
  timestamp,
  vector,
  index,
} from 'drizzle-orm/pg-core';

// queued      — uploaded, awaiting ingest worker
// processing  — chunking + embedding in flight
// indexed     — chunks + embeddings persisted, retrievable
// failed      — ingest worker hit an error; see error_message
export const referenceStatusEnum = pgEnum('reference_status', [
  'queued',
  'processing',
  'indexed',
  'failed',
]);

export const reference_documents = pgTable(
  'reference_documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    title: text('title').notNull(),
    source: text('source').notNull(), // 'upload' | 'url'
    source_url: text('source_url'),
    original_filename: text('original_filename'),
    mime_type: text('mime_type'),
    size_bytes: integer('size_bytes'),
    storage_path: text('storage_path'),
    full_text: text('full_text'),
    sha256: text('sha256'), // for dedup; null until ingest computes it
    token_count: integer('token_count'),
    tags: text('tags').array().notNull().default([]),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    visibility: text('visibility').notNull().default('firm'),
    status: referenceStatusEnum('status').notNull().default('queued'),
    error_message: text('error_message'),
    created_by: uuid('created_by'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    processed_at: timestamp('processed_at', { withTimezone: true }),
  },
  (t) => ({
    sha_idx: index('reference_documents_sha_idx').on(t.sha256),
    status_idx: index('reference_documents_status_idx').on(t.status),
  }),
);

export const reference_chunks = pgTable(
  'reference_chunks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    document_id: uuid('document_id')
      .notNull()
      .references(() => reference_documents.id, { onDelete: 'cascade' }),
    chunk_index: integer('chunk_index').notNull(),
    text: text('text').notNull(),
    // 1024-dim cosine-similarity vector. HNSW index built in the migration
    // because drizzle-kit doesn't currently express HNSW operator classes
    // in a way that round-trips cleanly through generate.
    embedding: vector('embedding', { dimensions: 1024 }),
    embedding_model: text('embedding_model'), // 'voyage-3-large' | 'bge-m3' | …
    char_start: integer('char_start').notNull(),
    char_end: integer('char_end').notNull(),
    token_count: integer('token_count'),
    page_number: integer('page_number'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    document_idx: index('reference_chunks_document_idx').on(t.document_id),
  }),
);

export type ReferenceDocument = typeof reference_documents.$inferSelect;
export type NewReferenceDocument = typeof reference_documents.$inferInsert;
export type ReferenceChunk = typeof reference_chunks.$inferSelect;
export type NewReferenceChunk = typeof reference_chunks.$inferInsert;
