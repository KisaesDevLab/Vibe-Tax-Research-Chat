CREATE TABLE "auth_identities" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"issuer" text NOT NULL,
	"subject" text NOT NULL,
	"email" text,
	"email_verified" boolean DEFAULT false NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_revocations" (
	"subject_key" text PRIMARY KEY NOT NULL,
	"revoked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_until" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_sessions_oidc" (
	"sid" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"issuer" text NOT NULL,
	"subject" text NOT NULL,
	"oidc_sid" text,
	"id_token" text,
	"handoff_hash" text,
	"handoff_expires_at" timestamp with time zone,
	"handoff_claimed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_sessions_oidc_handoff_hash_unique" UNIQUE("handoff_hash")
);
--> statement-breakpoint
CREATE TABLE "auth_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "auth_refresh_tokens" ADD COLUMN "sid" text;--> statement-breakpoint
ALTER TABLE "auth_identities" ADD CONSTRAINT "auth_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_sessions_oidc" ADD CONSTRAINT "auth_sessions_oidc_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_identities_issuer_subject_uq" ON "auth_identities" USING btree ("issuer","subject");--> statement-breakpoint
CREATE INDEX "auth_identities_user_id_idx" ON "auth_identities" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_revocations_until_idx" ON "auth_revocations" USING btree ("revoked_until");--> statement-breakpoint
CREATE INDEX "auth_sessions_oidc_user_id_idx" ON "auth_sessions_oidc" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_sessions_oidc_issuer_subject_idx" ON "auth_sessions_oidc" USING btree ("issuer","subject");--> statement-breakpoint
CREATE INDEX "auth_sessions_oidc_oidc_sid_idx" ON "auth_sessions_oidc" USING btree ("oidc_sid");--> statement-breakpoint
CREATE INDEX "refresh_sid_idx" ON "auth_refresh_tokens" USING btree ("sid");