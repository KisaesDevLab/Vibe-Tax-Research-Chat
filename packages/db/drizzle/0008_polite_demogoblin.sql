CREATE TABLE "golden_tests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"strategy_version_id" uuid NOT NULL,
	"name" text NOT NULL,
	"profile" jsonb NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"expected" jsonb NOT NULL,
	"tolerance" numeric(10, 2) DEFAULT '1' NOT NULL,
	"pinned_table_set_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "strategies" (
	"id" text PRIMARY KEY NOT NULL,
	"current_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "strategy_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"strategy_id" text NOT NULL,
	"semver" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"content" jsonb NOT NULL,
	"inputs_schema" jsonb,
	"suggest_rule" jsonb,
	"apply_module_ref" text,
	"apply_order" integer,
	"effective_from" integer,
	"effective_to" integer,
	"reviewed_by" uuid,
	"change_note" text,
	"created_by" text DEFAULT 'human' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_by" text DEFAULT 'job' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "golden_tests" ADD CONSTRAINT "golden_tests_strategy_version_id_strategy_versions_id_fk" FOREIGN KEY ("strategy_version_id") REFERENCES "public"."strategy_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "golden_tests" ADD CONSTRAINT "golden_tests_pinned_table_set_id_table_sets_id_fk" FOREIGN KEY ("pinned_table_set_id") REFERENCES "public"."table_sets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_versions" ADD CONSTRAINT "strategy_versions_strategy_id_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."strategies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_versions" ADD CONSTRAINT "strategy_versions_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_queue" ADD CONSTRAINT "review_queue_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "golden_tests_version_idx" ON "golden_tests" USING btree ("strategy_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "strategy_versions_strategy_semver_uq" ON "strategy_versions" USING btree ("strategy_id","semver");--> statement-breakpoint
CREATE INDEX "strategy_versions_strategy_idx" ON "strategy_versions" USING btree ("strategy_id");--> statement-breakpoint
CREATE INDEX "review_queue_status_idx" ON "review_queue" USING btree ("status");--> statement-breakpoint
CREATE INDEX "review_queue_kind_idx" ON "review_queue" USING btree ("kind");