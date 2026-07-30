// Phase 2 — migration runner. Run via `pnpm db:migrate` (CLI) or call
// `runMigrations()` from a long-lived process (the API entrypoint, when
// MIGRATIONS_AUTO=true). Splitting into a function lets the appliance
// bootstrapper avoid a separate `docker compose exec` step.
import { config as loadEnv } from 'dotenv';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Workspace-root .env is two levels up from packages/db/src in source,
// or two levels up from packages/db/dist in the runtime image. Both paths
// resolve to the same project root.
loadEnv({ path: path.resolve(__dirname, '../../../.env') });

// Migrations live next to the package source: packages/db/drizzle/. From
// either `src/` or `dist/`, the relative path is one level up.
const MIGRATIONS_DIR = path.resolve(__dirname, '../drizzle');

/**
 * How many migrations this build ships versus how many the database has
 * applied. A running appliance whose schema is behind its image fails in
 * confusing ways — every deliverable render died with `relation
 * "plan_memos" does not exist` when 0015 was missing — so the API logs
 * this loudly at startup instead of waiting for a user to hit it.
 *
 * Returns null when the check itself cannot run (no journal, unreachable
 * DB); callers treat that as "unknown", never as "up to date".
 */
export async function pendingMigrationCount(opts?: {
  databaseUrl?: string;
}): Promise<{ shipped: number; applied: number; pending: number } | null> {
  const url = opts?.databaseUrl ?? process.env.DATABASE_URL;
  if (!url) return null;
  let shipped: number;
  try {
    const journal = JSON.parse(
      await readFile(path.join(MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf-8'),
    ) as { entries?: unknown[] };
    shipped = journal.entries?.length ?? 0;
  } catch {
    return null;
  }
  const sql = postgres(url, { max: 1 });
  try {
    const rows = await sql<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`;
    const applied = rows[0]?.n ?? 0;
    return { shipped, applied, pending: Math.max(0, shipped - applied) };
  } catch {
    // No drizzle schema yet = nothing applied; that is still actionable.
    return { shipped, applied: 0, pending: shipped };
  } finally {
    await sql.end({ timeout: 2 });
  }
}

/**
 * Session-scoped advisory lock so two processes starting at once cannot
 * run the migrator concurrently. The API image migrates on boot by
 * default, so "two containers restart together" is the normal case, not
 * an edge case: without this they race on the same DDL and one dies.
 * The loser here simply waits, then finds every migration already applied
 * and no-ops. Arbitrary but stable key — it only has to be unique within
 * this database.
 */
const MIGRATION_LOCK_KEY = 827_412_345_678;

export async function runMigrations(opts?: { databaseUrl?: string }): Promise<void> {
  const url = opts?.databaseUrl ?? process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');

  // max: 1 keeps the lock and the migration on the same session — an
  // advisory lock taken on a different connection would not protect it.
  const sql = postgres(url, { max: 1 });
  const db = drizzle(sql);
  try {
    await sql`SELECT pg_advisory_lock(${MIGRATION_LOCK_KEY})`;
    try {
      await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
    } finally {
      await sql`SELECT pg_advisory_unlock(${MIGRATION_LOCK_KEY})`.catch(() => {});
    }
  } finally {
    await sql.end();
  }
}

// CLI entrypoint. `node dist/migrate.js` or `pnpm db:migrate` runs this;
// importing the module from another package only sees `runMigrations`.
// `pathToFileURL` handles Windows path separators (`C:\\…`) and percent-
// encoding so the comparison works on every platform — manual
// `new URL("file://" + path)` does not.
const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  console.log('Running migrations…');
  runMigrations()
    .then(() => {
      console.log('Migrations complete.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('Migration failed:', err);
      process.exit(1);
    });
}
