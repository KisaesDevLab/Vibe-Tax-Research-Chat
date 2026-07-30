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
import { getDb } from '@vibe/db';
import { env } from '../../config/env.js';
import { logger } from '../logger.js';

export class PgToolMissingError extends Error {}

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
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(bin, ['-v', 'ON_ERROR_STOP=1', '--quiet', databaseUrl()], {
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let stderr = '';
    proc.stderr.on('data', (c) => {
      stderr += String(c);
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) return resolve();
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
    sql.pipe(proc.stdin);
  });
}
