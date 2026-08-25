CREATE TABLE "plan_pending_facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL,
	"message_id" uuid,
	"fact_path" text,
	"text" text NOT NULL,
	"value" jsonb,
	"source" jsonb,
	"method" text DEFAULT 'chat_confirmed' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"promoted_fact_pattern_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "plan_id" uuid;--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "mode" text;--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "strategy_id" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "doc_citations" jsonb DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "plan_pending_facts" ADD CONSTRAINT "plan_pending_facts_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_pending_facts" ADD CONSTRAINT "plan_pending_facts_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_pending_facts" ADD CONSTRAINT "plan_pending_facts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "plan_pending_facts_plan_idx" ON "plan_pending_facts" USING btree ("plan_id","status");--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chats_plan_idx" ON "chats" USING btree ("plan_id");