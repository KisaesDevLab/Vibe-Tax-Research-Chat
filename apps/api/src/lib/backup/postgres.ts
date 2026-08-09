// pg_dump / psql wrappers for the backup feature.
//
// Shelling out to the real client rather than hand-rolling SQL export is
// deliberate: sequences, extensions (pgvector), constraint ordering, and
// COPY escaping are exactly the things a home-grown dumper gets subtly
// wrong, and the failure only shows up when a restore is the last copy of
// the data. The runtime image installs the postgresql 16 AND 17 clients so
// the major can be matched to the server — see toolPath() for why that
// matters more than it sounds.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { PassThrough, Readable } from 'node:stream';
import { sql as raw } from 'drizzle-orm';
import { getDb, closeDb } from '@vibe/db';
import { env } from '../../config/env.js';
import { logger } from '../logger.js';
import { stripSuperuserOnly } from './sql-filter.js';

export class PgToolMissingError extends Error {}
/** Thrown before any destructive statement runs. */
export class RestorePrerequisiteError extends Error {}

/**
 * Resolve pg_dump/psql matching the SERVER's major version.
 *
 * Mixing majors is not merely untidy, it silently breaks restores:
 * pg_dump 17 always writes `SET transaction_timeout = 0` into the dump
 * header, PostgreSQL 16 rejects that parameter, and psql with
 * ON_ERROR_STOP aborts on line 13 — the backup looks fine and only fails
 * when it is restored. The image installs both clients under
 * /usr/libexec/postgresql<major>/, so pick the right one at runtime and
 * fall back to whatever is on PATH.
 */
let cachedMajor: number | null | undefined;

async function serverMajor(): Promise<number | null> {
  if (cachedMajor !== undefined) return cachedMajor;
  try {
    const rows = (await getDb().execute(raw`SHOW server_version_num`)) as unknown as Array<{
      server_version_num: string;
    }>;
    const num = Number(rows[0]?.server_version_num ?? 0);
    cachedMajor = num > 0 ? Math.floor(num / 10000) : null;
  } catch {
    cachedMajor = null;
  }
  return cachedMajor;
}

async function toolPath(tool: 'pg_dump' | 'psql'): Promise<string> {
  const major = await serverMajor();
  if (major) {
    const versioned = `/usr/libexec/postgresql${major}/${tool}`;
    if (existsSync(versioned)) return versioned;
  }
  return tool;
}

/** Resolve the database URL the app itself is using. */
function databaseUrl(): string {
  return env.DATABASE_URL;
}

export function databaseName(): string {
  try {
    return new URL(databaseUrl()).pathname.replace(/^\//, '') || 'postgres';
  } catch {
    return 'postgres';
  }
}

async function toolVersion(tool: 'pg_dump' | 'psql'): Promise<string> {
  const bin = await toolPath(tool);
  return new Promise((resolve, reject) => {
    const p = spawn(bin, ['--version']);
    let out = '';
    p.stdout.on('data', (c) => (out += String(c)));
    p.on('error', () =>
      reject(
        new PgToolMissingError(
          `${tool} is not installed in this container — backup and restore need the postgresql client.`,
        ),
      ),
    );
    p.on('close', (code) =>
      code === 0 ? resolve(out.trim()) : reject(new PgToolMissingError(`${tool} exited ${code}`)),
    );
  });
}

export const pgDumpVersion = () => toolVersion('pg_dump');

/**
 * Stream a full SQL dump of the application database.
 *
 * --clean --if-exists makes the dump self-sufficient on restore (it drops
 * what it is about to recreate), and --no-owner --no-privileges lets it
 * load as whatever role the destination happens to use, which will not be
 * the same role on a different server.
 */
export function dumpDatabase(): Readable {
  const out = new PassThrough();
  void (async () => {
    const bin = await toolPath('pg_dump');
    const proc = spawn(
      bin,
      ['--clean', '--if-exists', '--no-owner', '--no-privileges', databaseUrl()],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stderr = '';
    proc.stderr.on('data', (c) => {
      stderr += String(c);
    });
    proc.on('error', (err) => out.destroy(err));
    proc.on('close', (code) => {
      if (code !== 0) {
        logger.error({ code, stderr: stderr.slice(0, 2000) }, 'pg_dump failed');
        out.destroy(new Error(`pg_dump exited ${code}: ${stderr.slice(0, 500)}`));
      }
    });
    proc.stdout.pipe(out);
  })().catch((err) => out.destroy(err as Error));
  return out;
}

/**
 * Load a SQL dump into the application database.
 *
 * ON_ERROR_STOP=1 turns the first failing statement into a non-zero exit
 * instead of psql cheerfully continuing and leaving a half-restored
 * database that looks like a success.
 */
/** Identifies the restore's own psql session so the eviction loop spares it. */
const RESTORE_APP_NAME = 'vibe-tax-restore';

/** Run one statement in its own psql process; never touches the app pool.
 *  The URL rides behind -d: Windows psql does not permute argv, so any
 *  option after a positional dbname is silently IGNORED — `psql <url> -c
 *  <sql>` connects and then does nothing, exit 0. */
function psqlCommand(bin: string, url: string, statement: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, ['-v', 'ON_ERROR_STOP=1', '-tAqX', '-d', url, '-c', statement], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    proc.stderr.on('data', (c) => (stderr += String(c)));
    proc.on('error', reject);
    proc.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`psql exited ${code}: ${stderr.slice(0, 300)}`)),
    );
  });
}

/** Like psqlCommand, but returns the statement's (tuples-only) stdout. */
function psqlQuery(bin: string, url: string, statement: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, ['-v', 'ON_ERROR_STOP=1', '-tAqX', '-d', url, '-c', statement], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let stderr = '';
    proc.stdout.on('data', (c) => (out += String(c)));
    proc.stderr.on('data', (c) => (stderr += String(c)));
    proc.on('error', reject);
    proc.on('close', (code) =>
      code === 0
        ? resolve(out.trim())
        : reject(new Error(`psql exited ${code}: ${stderr.slice(0, 300)}`)),
    );
  });
}

export async function restoreDatabase(
  sql: Readable,
  opts: {
    /**
     * Load into this database instead of the application's own. When set to
     * a different database, the app's connection pool is left alone and no
     * sessions are evicted — a failed restore can never take the running
     * app's database with it.
     */
    targetUrl?: string;
  } = {},
): Promise<void> {
  const url = opts.targetUrl ?? databaseUrl();
  const restoringAppDb = url === databaseUrl();
  const version = await toolVersion('psql'); // Fails fast when absent.
  const bin = await toolPath('psql');
  logger.info({ psql: version, bin, appDb: restoringAppDb }, 'restoring database from backup');

  // Best effort: if this role CAN create the extension, do it before the
  // filtered dump lands (which no longer carries CREATE EXTENSION). When
  // the role lacks the privilege this is a no-op and the destination is
  // expected to already have the extension — it could not run the app
  // otherwise. Runs through psql so it works against any target database,
  // not just the one behind the app pool.
  await psqlCommand(bin, url, 'CREATE EXTENSION IF NOT EXISTS vector').catch((err) =>
    logger.info(
      { err: (err as Error).message },
      'vector extension not created by restore (expected on a non-superuser role)',
    ),
  );

  // Preflight BEFORE psql runs. The dump starts with DROP statements, so a
  // failure partway through leaves the destination partially wiped — the
  // one outcome a restore must never produce. pgvector cannot be installed
  // without superuser, so if it is still missing after the attempt above,
  // stop now while the database is untouched.
  const ext = await psqlQuery(
    bin,
    url,
    `SELECT count(*) FROM pg_extension WHERE extname = 'vector'`,
  ).catch(() => '0');
  if (Number(ext) === 0) {
    throw new RestorePrerequisiteError(
      'This database is missing the "vector" extension, which the backup needs and this ' +
        'role cannot create. Ask a superuser to run: CREATE EXTENSION vector; on the ' +
        'destination database, then restore again. Nothing has been changed.',
    );
  }

  if (restoringAppDb) {
    // Close our OWN pool first, then evict the rest with a separate psql
    // process.
    //
    // Doing it the other way round deadlocks: pg_terminate_backend issued
    // THROUGH the app's pool kills that pool's own sibling connections, and
    // the closeDb() that follows then waits forever for connections that
    // will never drain. The restore hung there with psql never spawned and
    // no error to show for it. Bounded, because a pool that refuses to close
    // must not be able to block a restore either.
    logger.info('restore: closing application connection pool');
    await Promise.race([closeDb().catch(() => {}), new Promise((r) => setTimeout(r, 5000))]);
    logger.info('restore: pool closed; evicting remaining sessions');

    await psqlCommand(
      bin,
      url,
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname = current_database() AND pid <> pg_backend_pid()`,
    ).catch((err) =>
      logger.warn(
        { err: (err as Error).message },
        'could not evict other database connections; restore may block on locks',
      ),
    );
  }

  logger.info('restore: sessions evicted; starting psql load');
  const skipped: string[] = [];
  const filtered = sql.pipe(stripSuperuserOnly((line) => skipped.push(line)));
  await new Promise<void>((resolve, reject) => {
    // lock_timeout turns "wait forever behind another session's lock" into
    // a real error. Without it a blocked DROP simply hangs, the operator
    // sees a spinner, and the only evidence is a half-dropped database
    // after they give up and restart. 60s is far longer than any healthy
    // lock wait here.
    const proc = spawn(bin, ['-v', 'ON_ERROR_STOP=1', '--quiet', url], {
      stdio: ['pipe', 'ignore', 'pipe'],
      env: {
        ...process.env,
        // Tagged so the eviction loop below can kill every session EXCEPT
        // this one.
        PGAPPNAME: RESTORE_APP_NAME,
        PGOPTIONS: '-c lock_timeout=60s -c statement_timeout=0',
      },
    });

    // Evicting once before the load is not enough: the app reconnects
    // within seconds (health checks, background jobs) and takes locks on
    // the very tables being dropped. Keep evicting for as long as the load
    // runs, excluding the restore's own connection by application_name.
    // Only when restoring the app's own database — a scratch target has no
    // competing sessions to evict.
    const evictor = restoringAppDb
      ? setInterval(() => {
          void psqlCommand(
            bin,
            url,
            `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
             WHERE datname = current_database()
               AND pid <> pg_backend_pid()
               AND coalesce(application_name, '') <> '${RESTORE_APP_NAME}'`,
          ).catch(() => {});
        }, 2000)
      : null;
    const stopEvictor = () => {
      if (evictor) clearInterval(evictor);
    };
    proc.on('close', stopEvictor);
    proc.on('error', stopEvictor);
    let stderr = '';
    proc.stderr.on('data', (c) => {
      stderr += String(c);
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) {
        logger.info({ skipped: skipped.length }, 'restore: psql load finished cleanly');
        return resolve();
      }
      reject(new Error(`psql exited ${code}: ${stderr.slice(0, 1000)}`));
    });
    // When psql aborts early (ON_ERROR_STOP on a bad statement) it closes
    // stdin while we are still writing, and the resulting EPIPE would
    // otherwise surface as an uncaught error that buries the real cause.
    // Swallow the pipe error and let the close handler report psql's own
    // stderr, which is the message an operator can act on.
    proc.stdin.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code !== 'EPIPE') reject(err);
    });
    sql.on('error', reject);
    filtered.on('error', reject);
    filtered.pipe(proc.stdin);
  });
}
