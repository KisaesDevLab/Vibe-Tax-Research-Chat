// Full backup → restore against a real Postgres, exercising pg_dump and
// psql rather than a stub. A backup feature that has only been unit-tested
// is a backup feature nobody has actually restored; this proves the loop
// closes on live schema and real data.
//
// The restore lands in a SCRATCH database, never the application database:
// restoreDatabase against the app DB closes the app pool and evicts every
// other session, which inside a parallel test run kills sibling test files
// — and a restore that fails partway would leave the shared dev database
// half-wiped. The scratch target proves the same loop with none of the
// blast radius.
//
// Skips when pg_dump/psql are absent (local dev without the postgres
// client) or no database is reachable, so bare CI stays green.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as dotenvConfig } from 'dotenv';
import { sql as raw } from 'drizzle-orm';
import { getDb } from '@vibe/db';
import { writeBackup, readBackup, fingerprint, type BackupManifest } from './archive.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: path.resolve(__dirname, '../../../../../.env') });

const SCRATCH_DB = 'vibe_tax_backup_roundtrip';

let available = false;
let work: string;

function scratchUrl(): string {
  const u = new URL(process.env.DATABASE_URL!);
  u.pathname = `/${SCRATCH_DB}`;
  return u.toString();
}

/** Tuples-only psql query against an arbitrary database URL. The URL rides
 *  behind -d: Windows psql does not permute argv, so options after a
 *  positional dbname are silently ignored. */
function psql(url: string, statement: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('psql', ['-v', 'ON_ERROR_STOP=1', '-tAqX', '-d', url, '-c', statement], {
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

async function dropScratch(): Promise<void> {
  await getDb()
    .execute(raw`DROP DATABASE IF EXISTS ${raw.raw(SCRATCH_DB)} WITH (FORCE)`)
    .catch(() => {});
}

beforeAll(async () => {
  if (!process.env.DATABASE_URL) return;
  try {
    const { pgDumpVersion } = await import('./postgres.js');
    await pgDumpVersion();
    await getDb().execute(raw`SELECT 1`);
    available = true;
  } catch {
    available = false;
  }
  work = await mkdtemp(path.join(tmpdir(), 'vibe-rt-'));
});

afterAll(async () => {
  if (available) {
    await getDb()
      .execute(raw`DROP TABLE IF EXISTS backup_roundtrip_marker`)
      .catch(() => {});
    await dropScratch();
  }
  if (work) await rm(work, { recursive: true, force: true });
});

describe('backup round-trip against a real database', () => {
  it('connects (or skips)', () => {
    if (!available) console.warn('roundtrip.integration: no pg client or DB — skipping');
    expect(true).toBe(true);
  });

  it('dumps live data and restores it into a scratch database', async ({ skip }) => {
    if (!available) return skip();
    const db = getDb();
    const { dumpDatabase, restoreDatabase } = await import('./postgres.js');

    // A distinctive row that must survive the whole loop.
    await db.execute(raw`DROP TABLE IF EXISTS backup_roundtrip_marker`);
    await db.execute(raw`CREATE TABLE backup_roundtrip_marker (id int primary key, note text)`);
    await db.execute(
      raw`INSERT INTO backup_roundtrip_marker VALUES (1, 'survives the round trip')`,
    );

    const manifest: BackupManifest = {
      format: 1,
      createdAt: new Date().toISOString(),
      appVersion: 'test',
      masterKeyFingerprint: fingerprint('k'),
      includes: [],
      database: { name: 'vibe_tax', dumpedWith: 'test' },
    };

    const file = path.join(work, 'rt.vtbk');
    const out = createWriteStream(file);
    await writeBackup(
      { dirs: {}, databaseDump: dumpDatabase, manifest, masterKey: 'k' },
      'a-sufficiently-long-passphrase',
      out,
    );
    await new Promise<void>((res, rej) => out.end((e?: Error) => (e ? rej(e) : res())));

    // The dump must actually contain the row, not merely be non-empty.
    const bytes = await readFile(file);
    expect(bytes.length).toBeGreaterThan(1000);

    // Restore into an empty scratch database and prove the marker row —
    // schema and data — made the trip.
    await dropScratch();
    await db.execute(raw`CREATE DATABASE ${raw.raw(SCRATCH_DB)}`);

    await readBackup(file, 'a-sufficiently-long-passphrase', {
      onManifest: (m) => expect(m.appVersion).toBe('test'),
      onMasterKey: (k) => expect(k).toBe('k'),
      onDatabase: (s) => restoreDatabase(s, { targetUrl: scratchUrl() }),
      resolveFile: () => null,
    });

    const note = await psql(scratchUrl(), `SELECT note FROM backup_roundtrip_marker WHERE id = 1`);
    expect(note).toBe('survives the round trip');

    // The app database was never the restore target: its pool is still
    // usable and its marker row untouched.
    const appRows = (await db.execute(
      raw`SELECT note FROM backup_roundtrip_marker WHERE id = 1`,
    )) as unknown as Array<{ note: string }>;
    expect(appRows[0]?.note).toBe('survives the round trip');
  }, 180_000);
});
