// TP-3a — client-owned versioned fact patterns, client source documents with
// per-page Shield-redacted chunks, and plan fact snapshots.
//
// Versioning: one client_fact_patterns row per version; the current version
// is the row with superseded_at IS NULL, enforced by a hand-written partial
// unique index in the migration (drizzle-kit doesn't round-trip partial
// indexes). `version` is monotonic per client (MAX+1 inside the write
// transaction); a client merge can leave duplicate historical numbers, so
// history UIs order by created_at.
//
// document_chunks text is POST-Shield (lib/pii redaction) — raw document text
// never lands in the database. Chunks are page-bounded so every retrieval
// excerpt carries a real page number. The HNSW cosine index is hand-written
// in the migration (0002 precedent).
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
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import type { FactCandidate, FactPattern } from '@vibe/shared';
import { clients } from './clients.js';
import { users } from './users.js';
import { plans } from './plans.js';

export const clientDocTypeEnum = pgEnum('client_doc_type', [
  'f1040',
  'f1120s',
  'f1120',
  'f1065',
  'k1',
  'f990',
  'state_return',
  'engagement_letter',
  'correspondence',
  'other',
]);

// Deliberately NOT reusing reference_status: the two pipelines evolve
// independently and a shared enum would couple their migrations.
export const clientDocumentStatusEnum = pgEnum('client_document_status', [
  'queued',
  'processing',
  'indexed',
  'failed',
]);

export const clientOcrMethodEnum = pgEnum('client_ocr_method', ['text_layer', 'glm_ocr']);

export const planSnapshotKindEnum = pgEnum('plan_snapshot_kind', ['created', 'review_frozen']);

export const client_fact_patterns = pgTable(
  'client_fact_patterns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    client_id: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    schema_version: text('schema_version').notNull(),
    facts: jsonb('facts').$type<FactPattern>().notNull(),
    created_by: uuid('created_by').references(() => users.id),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    superseded_at: timestamp('superseded_at', { withTimezone: true }),
    change_summary: text('change_summary').notNull(),
  },
  (t) => ({
    client_idx: index('client_fact_patterns_client_idx').on(t.client_id),
    // + hand-written in the migration:
    //   CREATE UNIQUE INDEX client_fact_patterns_current_uq
    //     ON client_fact_patterns (client_id) WHERE superseded_at IS NULL;
  }),
);

export const client_documents = pgTable(
  'client_documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    client_id: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    sha256: text('sha256').notNull(),
    filename: text('filename').notNull(), // sanitized, never PII
    doc_type: clientDocTypeEnum('doc_type').notNull().default('other'),
    doc_type_method: text('doc_type_method'), // 'heuristic' | 'llm' | 'manual'
    tax_year: integer('tax_year'),
    page_count: integer('page_count'),
    ocr_method: clientOcrMethodEnum('ocr_method'), // null until ingest
    shield_pass_at: timestamp('shield_pass_at', { withTimezone: true }),
    storage_ref: text('storage_ref'),
    status: clientDocumentStatusEnum('status').notNull().default('queued'),
    error_message: text('error_message'),
    // LLM fact extraction failed/skipped while chunks still indexed fine.
    extraction_error: text('extraction_error'),
    // Anchor-path engine-profile candidates (plan-scoped uploads only) —
    // the IntakeResult stored verbatim for audit/re-display.
    profile_candidates: jsonb('profile_candidates').$type<Record<string, unknown> | null>(),
    // Accept/reject state is embedded per candidate; the resolve endpoint
    // rewrites the column whole inside its transaction.
    fact_candidates: jsonb('fact_candidates').$type<FactCandidate[]>().notNull().default([]),
    uploaded_by: uuid('uploaded_by').references(() => users.id),
    uploaded_at: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    client_idx: index('client_documents_client_idx').on(t.client_id),
    status_idx: index('client_documents_status_idx').on(t.status),
    sha_idx: index('client_documents_client_sha_idx').on(t.client_id, t.sha256),
  }),
);

export const document_chunks = pgTable(
  'document_chunks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    document_id: uuid('document_id')
      .notNull()
      .references(() => client_documents.id, { onDelete: 'cascade' }),
    page: integer('page').notNull(), // 1-based; chunks never span pages
    chunk_index: integer('chunk_index').notNull(), // global within the document
    text: text('text').notNull(), // POST-Shield redacted
    // HNSW cosine index hand-written in the migration.
    embedding: vector('embedding', { dimensions: 1024 }),
    embedding_model: text('embedding_model'),
    char_start: integer('char_start').notNull(), // page-relative offsets
    char_end: integer('char_end').notNull(),
    token_count: integer('token_count'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    document_idx: index('document_chunks_document_idx').on(t.document_id),
  }),
);

export const plan_fact_snapshots = pgTable(
  'plan_fact_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    plan_id: uuid('plan_id')
      .notNull()
      .references(() => plans.id, { onDelete: 'cascade' }),
    // NO ACTION on purpose: client delete is already refused while plans
    // exist, so a snapshot can never dangle; keeping the FK strict makes a
    // future rule change fail loudly instead of silently orphaning.
    fact_pattern_id: uuid('fact_pattern_id')
      .notNull()
      .references(() => client_fact_patterns.id),
    fact_pattern_version: integer('fact_pattern_version').notNull(),
    snapshot_kind: planSnapshotKindEnum('snapshot_kind').notNull(),
    // Denormalized copy — the snapshot survives later client-side edits.
    facts: jsonb('facts').$type<FactPattern>().notNull(),
    snapshot_at: timestamp('snapshot_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    plan_idx: index('plan_fact_snapshots_plan_idx').on(t.plan_id),
    // `created` upserts on re-accept until freeze; one row per kind.
    kind_uq: uniqueIndex('plan_fact_snapshots_plan_kind_uq').on(t.plan_id, t.snapshot_kind),
  }),
);

export type ClientFactPattern = typeof client_fact_patterns.$inferSelect;
export type NewClientFactPattern = typeof client_fact_patterns.$inferInsert;
export type ClientDocument = typeof client_documents.$inferSelect;
export type NewClientDocument = typeof client_documents.$inferInsert;
export type DocumentChunk = typeof document_chunks.$inferSelect;
export type NewDocumentChunk = typeof document_chunks.$inferInsert;
export type PlanFactSnapshot = typeof plan_fact_snapshots.$inferSelect;
export type NewPlanFactSnapshot = typeof plan_fact_snapshots.$inferInsert;
