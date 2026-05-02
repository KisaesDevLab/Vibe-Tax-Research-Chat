// Phase 2 — migration runner. Run via `pnpm db:migrate` (CLI) or call
// `runMigrations()` from a long-lived process (the API entrypoint, when
// MIGRATIONS_AUTO=true). Splitting into a function lets the appliance
// bootstrapper avoid a separate `docker compose exec` step.
import { config as loadEnv } from 'dotenv';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import path from 'node:path';
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

export async function runMigrations(opts?: { databaseUrl?: string }): Promise<void> {
  const url = opts?.databaseUrl ?? process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');

  const sql = postgres(url, { max: 1 });
  const db = drizzle(sql);
  try {
    await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
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
