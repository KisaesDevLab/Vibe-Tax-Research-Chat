// Phase 2 — migration runner. Run via `pnpm db:migrate`.
import { config as loadEnv } from 'dotenv';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Look for .env at the workspace root (two levels up from packages/db/src).
loadEnv({ path: path.resolve(__dirname, '../../../.env') });

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');

  const sql = postgres(url, { max: 1 });
  const db = drizzle(sql);

  // eslint-disable-next-line no-console
  console.log('Running migrations…');
  await migrate(db, { migrationsFolder: path.resolve(__dirname, '../drizzle') });
  // eslint-disable-next-line no-console
  console.log('Migrations complete.');

  await sql.end();
  process.exit(0);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Migration failed:', err);
  process.exit(1);
});
