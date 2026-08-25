CREATE TYPE "public"."client_doc_type" AS ENUM('f1040', 'f1120s', 'f1120', 'f1065', 'k1', 'f990', 'state_return', 'engagement_letter', 'correspondence', 'other');--> statement-breakpoint
CREATE TYPE "public"."client_document_status" AS ENUM('queued', 'processing', 'indexed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."client_ocr_method" AS ENUM('text_layer', 'glm_ocr');--> statement-breakpoint
CREATE TYPE "public"."plan_snapshot_kind" AS ENUM('created', 'review_frozen');--> statement-breakpoint
CREATE TABLE "client_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"sha256" text NOT NULL,
	"filename" text NOT NULL,
	"doc_type" "client_doc_type" DEFAULT 'other' NOT NULL,
	"doc_type_method" text,
	"tax_year" integer,
	"page_count" integer,
	"ocr_method" "client_ocr_method",
	"shield_pass_at" timestamp with time zone,
	"storage_ref" text,
	"status" "client_document_status" DEFAULT 'queued' NOT NULL,
	"error_message" text,
	"extraction_error" text,
	"profile_candidates" jsonb,
	"fact_candidates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"uploaded_by" uuid,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "client_fact_patterns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"schema_version" text NOT NULL,
	"facts" jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_at" timestamp with time zone,
	"change_summary" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"page" integer NOT NULL,
	"chunk_index" integer NOT NULL,
	"text" text NOT NULL,
	"embedding" vector(1024),
	"embedding_model" text,
	"char_start" integer NOT NULL,
	"char_end" integer NOT NULL,
	"token_count" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plan_fact_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL,
	"fact_pattern_id" uuid NOT NULL,
	"fact_pattern_version" integer NOT NULL,
	"snapshot_kind" "plan_snapshot_kind" NOT NULL,
	"facts" jsonb NOT NULL,
	"snapshot_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "client_documents" ADD CONSTRAINT "client_documents_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_documents" ADD CONSTRAINT "client_documents_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_fact_patterns" ADD CONSTRAINT "client_fact_patterns_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_fact_patterns" ADD CONSTRAINT "client_fact_patterns_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_document_id_client_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."client_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_fact_snapshots" ADD CONSTRAINT "plan_fact_snapshots_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_fact_snapshots" ADD CONSTRAINT "plan_fact_snapshots_fact_pattern_id_client_fact_patterns_id_fk" FOREIGN KEY ("fact_pattern_id") REFERENCES "public"."client_fact_patterns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "client_documents_client_idx" ON "client_documents" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "client_documents_status_idx" ON "client_documents" USING btree ("status");--> statement-breakpoint
CREATE INDEX "client_documents_client_sha_idx" ON "client_documents" USING btree ("client_id","sha256");--> statement-breakpoint
CREATE INDEX "client_fact_patterns_client_idx" ON "client_fact_patterns" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "document_chunks_document_idx" ON "document_chunks" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "plan_fact_snapshots_plan_idx" ON "plan_fact_snapshots" USING btree ("plan_id");--> statement-breakpoint
CREATE UNIQUE INDEX "plan_fact_snapshots_plan_kind_uq" ON "plan_fact_snapshots" USING btree ("plan_id","snapshot_kind");--> statement-breakpoint
CREATE UNIQUE INDEX "client_fact_patterns_current_uq" ON "client_fact_patterns" ("client_id") WHERE "superseded_at" IS NULL;--> statement-breakpoint
CREATE INDEX "document_chunks_embedding_hnsw" ON "document_chunks" USING hnsw (embedding vector_cosine_ops);