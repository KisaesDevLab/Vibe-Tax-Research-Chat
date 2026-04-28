CREATE TYPE "public"."user_role" AS ENUM('admin', 'user', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."skill_source" AS ENUM('custom', 'anthropic', 'pack');--> statement-breakpoint
CREATE TYPE "public"."skill_status_field" AS ENUM('stub', 'draft', 'reviewed', 'verified');--> statement-breakpoint
CREATE TYPE "public"."skill_version_status" AS ENUM('current', 'superseded', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."sync_result" AS ENUM('success', 'partial', 'failed', 'preview');--> statement-breakpoint
CREATE TYPE "public"."skill_visibility" AS ENUM('firm', 'role:user', 'role:admin');--> statement-breakpoint
CREATE TYPE "public"."message_role" AS ENUM('user', 'assistant', 'system_note');--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" "user_role" DEFAULT 'user' NOT NULL,
	"display_name" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"monthly_spend_cap_usd" numeric(10, 2),
	"can_override_model" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "auth_refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"rotated_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"user_agent" text,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_refresh_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" uuid,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip" text
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb,
	"is_encrypted" boolean DEFAULT false NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "models" (
	"model_id" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"input_per_mtok" numeric(10, 4) NOT NULL,
	"output_per_mtok" numeric(10, 4) NOT NULL,
	"cache_write_per_mtok" numeric(10, 4) NOT NULL,
	"cache_read_per_mtok" numeric(10, 4) NOT NULL,
	"tokenizer_factor" numeric(6, 3) DEFAULT '1.000' NOT NULL,
	"web_fetch_unit_cost" numeric(10, 4) DEFAULT '0.0100' NOT NULL,
	"web_search_unit_cost" numeric(10, 4) DEFAULT '0.0100' NOT NULL,
	"web_tools_enabled" boolean DEFAULT true NOT NULL,
	"fetches_per_turn" numeric(4, 0) DEFAULT '8' NOT NULL,
	"searches_per_turn" numeric(4, 0) DEFAULT '4' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"retired_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "custom_skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"display_name" text NOT NULL,
	"description" text NOT NULL,
	"category" text,
	"body_md" text NOT NULL,
	"references" jsonb DEFAULT '[]'::jsonb,
	"routing_keywords" text[] DEFAULT '{}' NOT NULL,
	"anthropic_skill_id" text,
	"anthropic_skill_version" text,
	"is_always_attached" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"visibility" "skill_visibility" DEFAULT 'firm' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "custom_skills_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "skill_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"skill_id" text NOT NULL,
	"upstream_sha" text NOT NULL,
	"anthropic_skill_version" text NOT NULL,
	"status" "skill_version_status" DEFAULT 'current' NOT NULL,
	"status_field" "skill_status_field" DEFAULT 'draft' NOT NULL,
	"changelog_excerpt" text,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"uploaded_by" uuid
);
--> statement-breakpoint
CREATE TABLE "skills" (
	"skill_id" text PRIMARY KEY NOT NULL,
	"source" "skill_source" NOT NULL,
	"local_slug" text NOT NULL,
	"display_name" text NOT NULL,
	"description" text NOT NULL,
	"category" text,
	"current_version" text NOT NULL,
	"github_path" text,
	"github_sha" text,
	"status_field" "skill_status_field" DEFAULT 'draft' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"is_always_attached" boolean DEFAULT false NOT NULL,
	"routing_keywords" text[] DEFAULT '{}' NOT NULL,
	"uploaded_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	CONSTRAINT "skills_local_slug_unique" UNIQUE("local_slug")
);
--> statement-breakpoint
CREATE TABLE "skills_sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"triggered_by" text NOT NULL,
	"pin_type" text NOT NULL,
	"pin_value" text NOT NULL,
	"resolved_sha" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"result" "sync_result" DEFAULT 'preview' NOT NULL,
	"changes_summary" jsonb,
	"applied_at" timestamp with time zone,
	"applied_by" uuid,
	"error_message" text
);
--> statement-breakpoint
CREATE TABLE "chats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text DEFAULT 'Untitled chat' NOT NULL,
	"default_model_id" text,
	"pinned_pack_version" text,
	"pii_disclosure_acknowledged" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chat_id" uuid NOT NULL,
	"role" "message_role" NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"model_id" text,
	"stop_reason" text,
	"attached_skill_ids" text[],
	"attached_skill_versions" text[],
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_creation_input_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_input_tokens" integer DEFAULT 0 NOT NULL,
	"web_fetch_calls" integer DEFAULT 0 NOT NULL,
	"web_search_calls" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(10, 6) DEFAULT '0' NOT NULL,
	"authorities" jsonb DEFAULT '[]'::jsonb,
	"compliance_check" jsonb
);
--> statement-breakpoint
CREATE TABLE "primary_source_consultations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"tool_name" text NOT NULL,
	"url" text,
	"query" text,
	"domain" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"response_status" integer,
	"response_excerpt" text,
	"cited_in_authorities" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chat_id" uuid NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"storage_path" text NOT NULL,
	"full_text" text,
	"ocr_applied" boolean DEFAULT false NOT NULL,
	"summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_daily" (
	"day" date NOT NULL,
	"user_id" uuid NOT NULL,
	"model_id" text NOT NULL,
	"message_count" integer DEFAULT 0 NOT NULL,
	"total_tokens" integer DEFAULT 0 NOT NULL,
	"total_cost_usd" numeric(12, 4) DEFAULT '0' NOT NULL,
	CONSTRAINT "usage_daily_day_user_id_model_id_pk" PRIMARY KEY("day","user_id","model_id")
);
--> statement-breakpoint
CREATE TABLE "usage_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"chat_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"model_id" text NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"cache_creation_input_tokens" integer NOT NULL,
	"cache_read_input_tokens" integer NOT NULL,
	"web_fetch_calls" integer DEFAULT 0 NOT NULL,
	"web_search_calls" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(10, 6) NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reference_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"chunk_index" integer NOT NULL,
	"text" text NOT NULL,
	"embedding" text,
	"char_start" integer NOT NULL,
	"char_end" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reference_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"source" text NOT NULL,
	"original_filename" text,
	"mime_type" text,
	"size_bytes" integer,
	"storage_path" text,
	"full_text" text,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"visibility" text DEFAULT 'firm' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "authority_cache" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"cache_key" text NOT NULL,
	"canonical_url" text NOT NULL,
	"raw_text" text,
	"parsed_text" text,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ttl_until" timestamp with time zone NOT NULL,
	"upstream_status" text,
	"upstream_etag" text,
	"upstream_last_modified" text
);
--> statement-breakpoint
ALTER TABLE "auth_refresh_tokens" ADD CONSTRAINT "auth_refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_versions" ADD CONSTRAINT "skill_versions_skill_id_skills_skill_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("skill_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_default_model_id_models_model_id_fk" FOREIGN KEY ("default_model_id") REFERENCES "public"."models"("model_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_model_id_models_model_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."models"("model_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "primary_source_consultations" ADD CONSTRAINT "primary_source_consultations_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_attachments" ADD CONSTRAINT "chat_attachments_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_attachments" ADD CONSTRAINT "chat_attachments_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reference_chunks" ADD CONSTRAINT "reference_chunks_document_id_reference_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."reference_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "users_email_idx" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "users_active_idx" ON "users" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "refresh_user_idx" ON "auth_refresh_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "refresh_expires_idx" ON "auth_refresh_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "audit_actor_time_idx" ON "audit_log" USING btree ("actor_user_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_action_idx" ON "audit_log" USING btree ("action");--> statement-breakpoint
CREATE INDEX "custom_skills_active_idx" ON "custom_skills" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "skills_active_idx" ON "skills" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "skills_slug_idx" ON "skills" USING btree ("local_slug");--> statement-breakpoint
CREATE INDEX "chats_user_idx" ON "chats" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "chats_updated_idx" ON "chats" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "messages_chat_idx" ON "messages" USING btree ("chat_id");--> statement-breakpoint
CREATE INDEX "messages_chat_time_idx" ON "messages" USING btree ("chat_id","created_at");--> statement-breakpoint
CREATE INDEX "psc_message_idx" ON "primary_source_consultations" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "psc_domain_idx" ON "primary_source_consultations" USING btree ("domain");--> statement-breakpoint
CREATE INDEX "attachments_chat_idx" ON "chat_attachments" USING btree ("chat_id");--> statement-breakpoint
CREATE INDEX "usage_events_occurred_idx" ON "usage_events" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "usage_events_user_time_idx" ON "usage_events" USING btree ("user_id","occurred_at");--> statement-breakpoint
CREATE INDEX "authority_cache_source_key_idx" ON "authority_cache" USING btree ("source","cache_key");--> statement-breakpoint
CREATE INDEX "authority_cache_ttl_idx" ON "authority_cache" USING btree ("ttl_until");