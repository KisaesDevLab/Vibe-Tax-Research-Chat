CREATE TABLE "client_errors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fingerprint" text NOT NULL,
	"kind" text NOT NULL,
	"source" text,
	"message" text NOT NULL,
	"stack" text,
	"component_stack" text,
	"route" text,
	"chat_id" uuid,
	"message_id" uuid,
	"app_version" text,
	"user_agent" text,
	"user_id" uuid,
	"count" integer DEFAULT 1 NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "client_errors" ADD CONSTRAINT "client_errors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "client_errors_fingerprint_idx" ON "client_errors" USING btree ("fingerprint");--> statement-breakpoint
CREATE INDEX "client_errors_last_seen_idx" ON "client_errors" USING btree ("last_seen_at");