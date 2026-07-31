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
export async function restoreDatabase(sql: Readable): Promise<void> {
  const version = await toolVersion('psql'); // Fails fast when absent.
  const bin = await toolPath('psql');
  logger.info({ psql: version, bin }, 'restoring database from backup');

  // Best effort: if this role CAN create the extension, do it before the
  // filtered dump lands (which no longer carries CREATE EXTENSION). When
  // the role lacks the privilege this is a no-op and the destination is
  // expected to already have the extension — it could not run the app
  // otherwise.
  await getDb()
    .execute(raw`CREATE EXTENSION IF NOT EXISTS vector`)
    .catch((err) =>
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
  const ext = (await getDb().execute(
    raw`SELECT count(*)::int AS n FROM pg_extension WHERE extname = 'vector'`,
  )) as unknown as Array<{ n: number }>;
  if ((ext[0]?.n ?? 0) === 0) {
    throw new RestorePrerequisiteError(
      'This database is missing the "vector" extension, which the backup needs and this ' +
        'role cannot create. Ask a superuser to run: CREATE EXTENSION vector; on the ' +
        'destination database, then restore again. Nothing has been changed.',
    );
  }

  // Evict every other connection to this database first. The app's own
  // pool keeps querying (health checks, the operator's browser session),
  // and psql cannot DROP TABLE users while another session holds a lock on
  // it — it waits. That wait is what pushed a restore past the reverse
  // proxy's timeout, killing the connection after the DROPs had run and
  // before the CREATEs, leaving the database unusable. Terminated
  // connections simply reconnect afterwards.
  await getDb()
    .execute(
      raw`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid()`,
    )
    .catch((err) =>
      logger.warn(
        { err: (err as Error).message },
        'could not evict other database connections; restore may block on locks',
      ),
    );

  // Evicting once is not enough on its own: the app's pool reconnects in
  // milliseconds and re-locks the very tables psql is about to drop. Close
  // our own pool too, so nothing on this side reacquires a lock while the
  // load runs. It reconnects lazily afterwards.
  await closeDb().catch(() => {});

  const skipped: string[] = [];
  const filtered = sql.pipe(stripSuperuserOnly((line) => skipped.push(line)));
  await new Promise<void>((resolve, reject) => {
    // lock_timeout turns "wait forever behind another session's lock" into
    // a real error. Without it a blocked DROP simply hangs, the operator
    // sees a spinner, and the only evidence is a half-dropped database
    // after they give up and restart. 60s is far longer than any healthy
    // lock wait here.
    const proc = spawn(bin, ['-v', 'ON_ERROR_STOP=1', '--quiet', databaseUrl()], {
      stdio: ['pipe', 'ignore', 'pipe'],
      env: { ...process.env, PGOPTIONS: '-c lock_timeout=60s -c statement_timeout=0' },
    });
    let stderr = '';
    proc.stderr.on('data', (c) => {
      stderr += String(c);
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) {
        if (skipped.length) logger.info({ skipped }, 'restore skipped superuser-only statements');
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
