CREATE TABLE "research_archives" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid,
	"firm_archive" boolean DEFAULT false NOT NULL,
	"source_session_id" uuid,
	"title" text NOT NULL,
	"topic_tags" text[] DEFAULT '{}' NOT NULL,
	"note" text,
	"snapshot" jsonb NOT NULL,
	"snapshot_text" text NOT NULL,
	"sha256" text NOT NULL,
	"archived_by" uuid,
	"archived_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"tombstone" jsonb,
	"plan_id" uuid,
	"strategy_id" text
);
--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "nudge_dismissed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "research_archives" ADD CONSTRAINT "research_archives_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_archives" ADD CONSTRAINT "research_archives_source_session_id_chats_id_fk" FOREIGN KEY ("source_session_id") REFERENCES "public"."chats"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_archives" ADD CONSTRAINT "research_archives_archived_by_users_id_fk" FOREIGN KEY ("archived_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "research_archives_client_idx" ON "research_archives" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "research_archives_source_idx" ON "research_archives" USING btree ("source_session_id");--> statement-breakpoint
-- Hand-appended (drizzle-kit cannot express expression indexes): per-client
-- full-text search over the post-redaction snapshot text.
CREATE INDEX "research_archives_fts_idx" ON "research_archives" USING gin (to_tsvector('english', "snapshot_text"));