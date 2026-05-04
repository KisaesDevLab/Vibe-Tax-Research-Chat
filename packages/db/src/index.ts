// Phase 2 — db client + schema barrel.
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.js';

let pool: ReturnType<typeof postgres> | undefined;
let db: PostgresJsDatabase<typeof schema> | undefined;

export function getDb(url?: string): PostgresJsDatabase<typeof schema> {
  if (!db) {
    const connStr = url ?? process.env.DATABASE_URL;
    if (!connStr) throw new Error('DATABASE_URL is not set');
    pool = postgres(connStr, { max: 10, idle_timeout: 20 });
    db = drizzle(pool, { schema });
  }
  return db;
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end({ timeout: 5 });
    pool = undefined;
    db = undefined;
  }
}

export * as schema from './schema/index.js';
export type Db = PostgresJsDatabase<typeof schema>;

// Re-export the migration runner so the API entrypoint can invoke it
// inline when MIGRATIONS_AUTO=true. The CLI entrypoint inside migrate.ts
// only fires when `node dist/migrate.js` is the main module, so plain
// imports are side-effect-free.
export { runMigrations } from './migrate.js';
// Re-export the seed runner for the same reason — appliance bootstraps
// need the model registry and default settings populated, not just the
// schema. Idempotent (`onConflictDoNothing`), so safe to run every boot.
export { runSeed } from './seed.js';
