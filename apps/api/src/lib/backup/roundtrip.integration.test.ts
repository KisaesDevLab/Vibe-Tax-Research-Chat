// Full backup → restore against a real Postgres, exercising pg_dump and
// psql rather than a stub. A backup feature that has only been unit-tested
// is a backup feature nobody has actually restored; this proves the loop
// closes on live schema and real data.
//
// Skips when pg_dump/psql are absent (local dev without the postgres
// client) or no database is reachable, so bare CI stays green.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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

let available = false;
let work: string;

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
  }
  if (work) await rm(work, { recursive: true, force: true });
});

describe('backup round-trip against a real database', () => {
  it('connects (or skips)', () => {
    if (!available) console.warn('roundtrip.integration: no pg client or DB — skipping');
    expect(true).toBe(true);
  });

  it('dumps live data and restores it after the table is dropped', async ({ skip }) => {
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

    // Destroy the table, then restore from the archive.
    await db.execute(raw`DROP TABLE backup_roundtrip_marker`);
    const gone = await db
      .execute(raw`SELECT to_regclass('public.backup_roundtrip_marker') AS t`)
      .then((r) => (r as unknown as Array<{ t: string | null }>)[0]?.t);
    expect(gone).toBeNull();

    await readBackup(file, 'a-sufficiently-long-passphrase', {
      onManifest: (m) => expect(m.appVersion).toBe('test'),
      onMasterKey: (k) => expect(k).toBe('k'),
      onDatabase: (s) => restoreDatabase(s),
      resolveFile: () => null,
    });

    const rows = (await db.execute(
      raw`SELECT note FROM backup_roundtrip_marker WHERE id = 1`,
    )) as unknown as Array<{ note: string }>;
    expect(rows[0]?.note).toBe('survives the round trip');
  }, 180_000);
});
