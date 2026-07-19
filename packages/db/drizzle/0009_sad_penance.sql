CREATE TABLE "plan_research_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL,
	"strategy_id" text,
	"research_archive_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plan_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL,
	"scenario_id" uuid,
	"year" integer NOT NULL,
	"result" jsonb NOT NULL,
	"table_set_id" uuid NOT NULL,
	"engine_version" text NOT NULL,
	"strategy_versions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plan_scenarios" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL,
	"label" text NOT NULL,
	"selections" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"title" text DEFAULT 'Untitled plan' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"baseline_profile" jsonb NOT NULL,
	"growth_pct" numeric(5, 2) DEFAULT '3' NOT NULL,
	"years" integer DEFAULT 5 NOT NULL,
	"table_set_id" uuid NOT NULL,
	"engine_version" text NOT NULL,
	"fee_plan" jsonb,
	"assigned_to" uuid,
	"reviewer_id" uuid,
	"review_state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "plan_research_links" ADD CONSTRAINT "plan_research_links_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_research_links" ADD CONSTRAINT "plan_research_links_research_archive_id_research_archives_id_fk" FOREIGN KEY ("research_archive_id") REFERENCES "public"."research_archives"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_research_links" ADD CONSTRAINT "plan_research_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_results" ADD CONSTRAINT "plan_results_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_results" ADD CONSTRAINT "plan_results_scenario_id_plan_scenarios_id_fk" FOREIGN KEY ("scenario_id") REFERENCES "public"."plan_scenarios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_results" ADD CONSTRAINT "plan_results_table_set_id_table_sets_id_fk" FOREIGN KEY ("table_set_id") REFERENCES "public"."table_sets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_scenarios" ADD CONSTRAINT "plan_scenarios_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_table_set_id_table_sets_id_fk" FOREIGN KEY ("table_set_id") REFERENCES "public"."table_sets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_assigned_to_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "plan_research_links_plan_idx" ON "plan_research_links" USING btree ("plan_id");--> statement-breakpoint
CREATE UNIQUE INDEX "plan_research_links_uq" ON "plan_research_links" USING btree ("plan_id","strategy_id","research_archive_id");--> statement-breakpoint
CREATE INDEX "plan_results_plan_idx" ON "plan_results" USING btree ("plan_id");--> statement-breakpoint
CREATE INDEX "plan_scenarios_plan_idx" ON "plan_scenarios" USING btree ("plan_id");--> statement-breakpoint
CREATE INDEX "plans_client_idx" ON "plans" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "plans_status_idx" ON "plans" USING btree ("status");--> statement-breakpoint
-- Hand-appended: research_archives.plan_id was created in 0006 as a bare
-- uuid (plans did not exist yet). All values are NULL today, so adding
-- the FK is safe and additive.
ALTER TABLE "research_archives" ADD CONSTRAINT "research_archives_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;
