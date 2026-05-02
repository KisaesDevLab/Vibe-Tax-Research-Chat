-- Phase 32 (v1.5) — RAG firm reference library.
--
-- Enables pgvector and switches reference_chunks.embedding from the v1
-- text-stored placeholder to a real `vector(1024)` column. Adds ingest
-- bookkeeping fields on reference_documents (status, sha256, tags,
-- token_count, processed_at, error_message) and chunk-level metadata
-- (embedding_model, token_count, page_number).
--
-- Standalone uses pgvector/pgvector:pg16 (compose). The appliance
-- declares "vector" in .appliance/manifest.json -> postgresExtensions so
-- the parent's shared Postgres has it provisioned. The CREATE EXTENSION
-- is idempotent — safe to re-run.

CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint

CREATE TYPE "public"."reference_status" AS ENUM('queued', 'processing', 'indexed', 'failed');--> statement-breakpoint

-- The v1 schema declared `embedding text` as a placeholder. There is no
-- production data yet (the ingest pipeline didn't ship in v1), so a clean
-- DROP + ADD is simpler than an in-place text→vector cast (which would
-- require a USING expression that parses the text as a vector literal).
ALTER TABLE "reference_chunks" DROP COLUMN IF EXISTS "embedding";--> statement-breakpoint
ALTER TABLE "reference_chunks" ADD COLUMN "embedding" vector(1024);--> statement-breakpoint

ALTER TABLE "reference_documents" ALTER COLUMN "metadata" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "reference_chunks" ADD COLUMN "embedding_model" text;--> statement-breakpoint
ALTER TABLE "reference_chunks" ADD COLUMN "token_count" integer;--> statement-breakpoint
ALTER TABLE "reference_chunks" ADD COLUMN "page_number" integer;--> statement-breakpoint
ALTER TABLE "reference_chunks" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "reference_documents" ADD COLUMN "source_url" text;--> statement-breakpoint
ALTER TABLE "reference_documents" ADD COLUMN "sha256" text;--> statement-breakpoint
ALTER TABLE "reference_documents" ADD COLUMN "token_count" integer;--> statement-breakpoint
ALTER TABLE "reference_documents" ADD COLUMN "tags" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "reference_documents" ADD COLUMN "status" "reference_status" DEFAULT 'queued' NOT NULL;--> statement-breakpoint
ALTER TABLE "reference_documents" ADD COLUMN "error_message" text;--> statement-breakpoint
ALTER TABLE "reference_documents" ADD COLUMN "processed_at" timestamp with time zone;--> statement-breakpoint

CREATE INDEX "reference_chunks_document_idx" ON "reference_chunks" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "reference_documents_sha_idx" ON "reference_documents" USING btree ("sha256");--> statement-breakpoint
CREATE INDEX "reference_documents_status_idx" ON "reference_documents" USING btree ("status");--> statement-breakpoint

-- HNSW index for cosine similarity over voyage-3-large / BGE-M3 embeddings.
-- m=16 / ef_construction=64 are pgvector defaults; tune later if recall
-- on the firm's reference corpus disappoints.
CREATE INDEX "reference_chunks_embedding_hnsw" ON "reference_chunks" USING hnsw (embedding vector_cosine_ops);
