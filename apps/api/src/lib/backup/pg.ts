// DR v2 — PostgreSQL tool wrappers for backup and restore.
//
// Shelling out to the real client tools rather than hand-rolling SQL
// export is deliberate: sequences, extensions (pgvector), constraint
// ordering, and COPY escaping are exactly the things a home-grown dumper
// gets subtly wrong, and the failure only shows up when a restore is the
// last copy of the data. The runtime image installs the postgresql 16 AND
// 17 clients so the major can be matched to the server.
//
// Two hard-won lessons live here:
//  - Windows psql does not permute argv: any option after a positional
//    dbname is silently IGNORED with exit 0, so the URL always rides
//    behind -d.
//  - Extension statements are skipped via pg_restore TOC entry filtering
//    (-L), never by pattern-matching SQL text.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import postgres from 'postgres';
import { sql as raw } from 'drizzle-orm';
import { getDb } from '@vibe/db';
import { env } from '../../config/env.js';
import { logger } from '../logger.js';
import { PgToolMissingError } from './errors.js';

export type PgTool = 'pg_dump' | 'pg_restore' | 'psql';

/**
 * Resolve a client tool matching the SERVER's major version.
 *
 * Mixing majors silently breaks restores: a 17-authored dump cannot be
 * read by 16-era tools, and the failure only appears at restore time. The
 * image installs both clients under /usr/libexec/postgresql<major>/; pick
 * the right one at runtime and fall back to whatever is on PATH.
 */
let cachedMajor: number | null | undefined;

export async function serverMajor(): Promise<number | null> {
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

export async function toolPath(tool: PgTool): Promise<string> {
  const major = await serverMajor();
  if (major) {
    const versioned = `/usr/libexec/postgresql${major}/${tool}`;
    if (existsSync(versioned)) return versioned;
  }
  return tool;
}

export async function toolVersion(tool: PgTool): Promise<string> {
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

/** "pg_dump (PostgreSQL) 16.11" -> 16; null when unparseable. */
export function parseToolMajor(versionLine: string): number | null {
  const m = /\(PostgreSQL\)\s+(\d+)/.exec(versionLine);
  return m ? Number(m[1]) : null;
}

/** The database URL the app itself is using. */
export function databaseUrl(): string {
  return env.DATABASE_URL;
}

export function databaseName(): string {
  try {
    return new URL(databaseUrl()).pathname.replace(/^\//, '') || 'postgres';
  } catch {
    return 'postgres';
  }
}

/** Same server, different database. */
export function dbUrlFor(dbName: string): string {
  const u = new URL(databaseUrl());
  u.pathname = `/${dbName}`;
  return u.toString();
}

/** The server's maintenance database — where CREATE/ALTER DATABASE runs. */
export function maintenanceUrl(): string {
  return dbUrlFor('postgres');
}

/** Run one statement in its own psql process; never touches the app pool.
 *  The URL rides behind -d (Windows psql argv lesson). */
export function psqlCommand(bin: string, url: string, statement: string): Promise<void> {
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
export function psqlQuery(bin: string, url: string, statement: string): Promise<string> {
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

// ── snapshot session ─────────────────────────────────────────────────────

export interface SnapshotInfo {
  snapshotId: string;
  serverVersion: string;
  /** public-schema table -> exact row count at this snapshot. */
  tables: Record<string, number>;
}

/**
 * Open a REPEATABLE READ transaction, export its snapshot, count every
 * public table inside it, and hold the transaction open while `fn` runs —
 * pg_dump is launched with --snapshot=<id> so the manifest's row counts
 * and the dump describe EXACTLY the same instant. No count drift, ever.
 */
export async function withSnapshot<T>(
  url: string,
  fn: (info: SnapshotInfo) => Promise<T>,
): Promise<T> {
  const sql = postgres(url, { max: 1 });
  try {
    return (await sql.begin('isolation level repeatable read', async (tx) => {
      const [snap] = await tx`SELECT pg_export_snapshot() AS id`;
      const [ver] = await tx`SHOW server_version`;
      const tabs = await tx`
        SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`;
      const tables: Record<string, number> = {};
      for (const t of tabs) {
        const name = (t as { tablename: string }).tablename;
        const [row] = await tx`SELECT count(*)::bigint AS n FROM ${tx(name)}`;
        tables[name] = Number((row as { n: string | number }).n);
      }
      return await fn({
        snapshotId: (snap as { id: string }).id,
        serverVersion: String((ver as Record<string, string>).server_version),
        tables,
      });
    })) as T;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** Short-lived direct session against an arbitrary database on the server
 *  (verify phase, scratch-db checks). Never the app pool. */
export async function withDbSession<T>(
  url: string,
  fn: (sql: postgres.Sql) => Promise<T>,
): Promise<T> {
  const sql = postgres(url, { max: 1 });
  try {
    return await fn(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

// ── dump / restore ───────────────────────────────────────────────────────

/**
 * The schemas that ARE the application's database state: app tables live in
 * `public`, migration bookkeeping in `drizzle`. The dump is allowlisted to
 * these rather than dumping the whole database because shared servers carry
 * extension schemas the app role cannot read — PostGIS's tiger geocoder in
 * particular marks its config tables with pg_extension_config_dump, so an
 * unscoped pg_dump tries to COPY tiger.geocode_settings and dies with
 * "permission denied for schema tiger". Extension objects are recreated on
 * restore (CREATE EXTENSION in the prepare phase + TOC filtering), so
 * nothing outside these schemas belongs in the archive. A schema pattern
 * that matches nothing is fine (no --strict-names), so `drizzle` being
 * absent on a fresh database does not fail the dump.
 *
 * If a migration ever adds a third schema, it MUST be added here or its
 * data is silently not backed up.
 */
export const DUMP_SCHEMAS = ['public', 'drizzle'] as const;

export function pgDumpArgs(opts: { url: string; snapshotId: string; outFile: string }): string[] {
  return [
    '-Fc',
    '--no-owner',
    '--no-privileges',
    ...DUMP_SCHEMAS.flatMap((s) => ['-n', s]),
    `--snapshot=${opts.snapshotId}`,
    '-f',
    opts.outFile,
    '-d',
    opts.url,
  ];
}

export async function runPgDump(opts: {
  url: string;
  snapshotId: string;
  outFile: string;
}): Promise<{ dumpedWith: string }> {
  const dumpedWith = await toolVersion('pg_dump');
  const bin = await toolPath('pg_dump');
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(bin, pgDumpArgs(opts), { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (c) => (stderr += String(c)));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) return resolve();
      logger.error({ code, stderr: stderr.slice(0, 2000) }, 'pg_dump failed');
      reject(new Error(`pg_dump exited ${code}: ${stderr.slice(0, 500)}`));
    });
  });
  return { dumpedWith };
}

/** `pg_restore -l` — the archive's table of contents, one entry per line. */
export async function listToc(dumpFile: string): Promise<string> {
  const bin = await toolPath('pg_restore');
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, ['-l', dumpFile], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let stderr = '';
    proc.stdout.on('data', (c) => (out += String(c)));
    proc.stderr.on('data', (c) => (stderr += String(c)));
    proc.on('error', () =>
      reject(new PgToolMissingError('pg_restore is not installed in this container.')),
    );
    proc.on('close', (code) =>
      code === 0
        ? resolve(out)
        : reject(new Error(`pg_restore -l exited ${code}: ${stderr.slice(0, 300)}`)),
    );
  });
}

/**
 * Drop extension management from a TOC listing. Entry lines look like
 *   `16; 3079 2 EXTENSION - vector`
 *   `17; 0 0 COMMENT - EXTENSION vector`
 * Creating an untrusted extension needs superuser; the destination must
 * already have it (the restore's prepare phase created it), so these
 * entries are noise that would fail a scoped role.
 *
 * The `public` SCHEMA entry (and its COMMENT) is dropped for the same
 * reason: because the dump names its schemas with -n, pg_dump emits
 * CREATE SCHEMA public — which every scratch database already has, and
 * under --exit-on-error "schema public already exists" is fatal. Other
 * schemas (drizzle) must be kept: the scratch database does NOT have them.
 * Comment lines (';'-prefixed) pass through untouched — pg_restore needs
 * them intact.
 */
const SKIPPED_TOC_ENTRY =
  /^\s*\d+;\s+\d+\s+\d+\s+(EXTENSION|COMMENT\s+-\s+EXTENSION|SCHEMA\s+(-\s+)?public|COMMENT\s+-\s+SCHEMA\s+public)\b/;

export function filterToc(
  toc: string,
  onSkip?: (line: string) => void,
): {
  filtered: string;
  kept: number;
} {
  const out: string[] = [];
  let kept = 0;
  for (const line of toc.split('\n')) {
    if (SKIPPED_TOC_ENTRY.test(line)) {
      onSkip?.(line.trim());
      continue;
    }
    if (/^\s*\d+;/.test(line)) kept += 1;
    out.push(line);
  }
  return { filtered: out.join('\n'), kept };
}

export interface PgRestoreRun {
  child: ChildProcess;
  done: Promise<void>;
}

/**
 * Load a custom-format dump into `url` with a filtered TOC. Returns the
 * child (the caller's stall detector may kill it) plus a completion
 * promise. Every stderr line (one per TOC entry with --verbose) flows to
 * `onStderrLine` — that is both the progress signal and the evidence
 * trail on failure.
 */
export async function runPgRestore(opts: {
  dumpFile: string;
  url: string;
  tocFile: string;
  jobs?: number;
  onStderrLine?: (line: string) => void;
}): Promise<PgRestoreRun> {
  const bin = await toolPath('pg_restore');
  const child = spawn(
    bin,
    [
      '--verbose',
      '--no-owner',
      '--no-privileges',
      '--exit-on-error',
      '-L',
      opts.tocFile,
      '-j',
      String(opts.jobs ?? 2),
      '-d',
      opts.url,
      opts.dumpFile,
    ],
    {
      stdio: ['ignore', 'ignore', 'pipe'],
      // The scratch database has no competing sessions, but a lock wait
      // must still become an error rather than an invisible hang.
      env: { ...process.env, PGOPTIONS: '-c lock_timeout=60s' },
    },
  );
  const rl = createInterface({ input: child.stderr! });
  rl.on('line', (line) => opts.onStderrLine?.(line));
  const done = new Promise<void>((resolve, reject) => {
    let spawnErr: Error | undefined;
    child.on('error', (err) => {
      spawnErr = err;
    });
    child.on('close', (code, signal) => {
      if (code === 0) return resolve();
      if (spawnErr) return reject(spawnErr);
      reject(
        new Error(
          signal
            ? `pg_restore killed with ${signal}`
            : `pg_restore exited ${code} — see stderr tail in the journal`,
        ),
      );
    });
  });
  return { child, done };
}

/** Persist a filtered TOC next to the dump for pg_restore -L. */
export async function writeTocFile(pathname: string, filtered: string): Promise<void> {
  await writeFile(pathname, filtered, 'utf-8');
}
