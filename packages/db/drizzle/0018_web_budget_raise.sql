ALTER TABLE "models" ALTER COLUMN "fetches_per_turn" SET DEFAULT '12';--> statement-breakpoint
ALTER TABLE "models" ALTER COLUMN "searches_per_turn" SET DEFAULT '10';--> statement-breakpoint
-- Existing installs carry per-model rows written by an earlier seed, so the new
-- column defaults above only apply to models discovered from here on. Bump the
-- rows that are still sitting on the OLD default pair (8 fetches / 4 searches),
-- matched as a pair so that:
--   - an admin who deliberately tuned either number keeps their value, and
--   - the 0/0 rows (web tools intentionally off, e.g. claude-haiku-4-5) stay off.
UPDATE "models"
   SET "fetches_per_turn" = '12',
       "searches_per_turn" = '10',
       "updated_at" = now()
 WHERE "fetches_per_turn" = 8
   AND "searches_per_turn" = 4;
