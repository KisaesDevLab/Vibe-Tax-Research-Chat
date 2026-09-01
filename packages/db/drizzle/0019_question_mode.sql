ALTER TABLE "chats" ADD COLUMN "question_mode" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "clarification" jsonb;