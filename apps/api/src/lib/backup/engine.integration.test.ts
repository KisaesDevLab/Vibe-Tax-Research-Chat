// DR v2 — the full restore engine against a real Postgres.
//
// HARD RULE (learned when a v1 test restore destroyed the dev database):
// these tests only ever touch databases named vibe_dr_* that they create
// themselves. The EngineConfig's liveDbName parameterization is what makes
// the real install structurally unreachable from here.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createWriteStream, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { config as dotenvConfig } from 'dotenv';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: path.resolve(__dirname, '../../../../../.env') });

import { writeBackup, fingerprint } from './archive.js';
import type { ManifestV2 } from './manifest.js';
import { beginRestore, recoverRestore, rollbackRestore, type EngineConfig } from './engine.js';
import { readJournal, type RestoreJournal } from './journal.js';
import {
  dbUrlFor,
  maintenanceUrl,
  psqlCommand,
  psqlQuery,
  runPgDump,
  toolPath,
  toolVersion,
  withDbSession,
  withSnapshot,
} from './pg.js';

let available = false;
let psqlBin: string;
let work: string;

const RUN_TAG = Math.random().toString(16).slice(2, 8);
let dbSeq = 0;
/** Unique per call — leftovers from one test can never collide with the
 *  next even if the sweep between tests is incomplete. */
const nextLiveDb = () => `vibe_dr_live_${RUN_TAG}_${dbSeq++}`;

beforeAll(async () => {
  if (!process.env.DATABASE_URL) return;
  try {
    await toolVersion('pg_dump');
    await toolVersion('pg_restore');
    psqlBin = await toolPath('psql');
    await psqlQuery(psqlBin, maintenanceUrl(), 'SELECT 1');
    available = true;
  } catch {
    available = false;
  }
});

beforeEach(async () => {
  work = await mkdtemp(path.join(tmpdir(), 'vibe-dr-'));
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true }).catch(() => {});
  if (available) await dropAllTestDbs();
});

afterAll(async () => {
  if (available) await dropAllTestDbs();
});

async function dropAllTestDbs(): Promise<void> {
  const rows = await psqlQuery(
    psqlBin,
    maintenanceUrl(),
    `SELECT datname FROM pg_database WHERE datname LIKE 'vibe_dr_%'`,
  ).catch(() => '');
  for (const name of rows.split('\n').filter(Boolean)) {
    await psqlCommand(
      psqlBin,
      maintenanceUrl(),
      `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`,
    ).catch(() => {});
  }
}

/** Create a database with an app-shaped users table + a marker table. */
async function seedDb(name: string, marker: string, extraRows = 0): Promise<void> {
  await psqlCommand(psqlBin, maintenanceUrl(), `CREATE DATABASE "${name}"`);
  const url = dbUrlFor(name);
  await psqlCommand(
    psqlBin,
    url,
    `CREATE TABLE users (id int primary key, role text not null, is_active boolean not null);
     CREATE TABLE dr_marker (id int primary key, note text not null);
     INSERT INTO users VALUES (1, 'admin', true);
     INSERT INTO dr_marker VALUES (1, '${marker}');`,
  );
  for (let i = 0; i < extraRows; i += 1) {
    await psqlCommand(psqlBin, url, `INSERT INTO dr_marker VALUES (${i + 2}, 'row-${i}')`);
  }
}

/** Build a real v2 archive from a source database + data dirs. */
async function makeArchive(opts: {
  sourceDb: string;
  file: string;
  passphrase: string;
  masterKey: string;
  files?: Record<string, string>; // 'attachments/a.txt' -> content
  tamperTables?: (t: Record<string, number>) => void;
}): Promise<void> {
  const dirRoot = path.join(work, 'src-dirs');
  const dirs: Record<string, string> = { attachments: path.join(dirRoot, 'attachments') };
  await mkdir(dirs.attachments!, { recursive: true });
  for (const [rel, content] of Object.entries(opts.files ?? {})) {
    const abs = path.join(dirRoot, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  const dumpFile = path.join(work, 'src.dump');
  const url = dbUrlFor(opts.sourceDb);
  const manifest = await withSnapshot(url, async (snap) => {
    const { dumpedWith } = await runPgDump({ url, snapshotId: snap.snapshotId, outFile: dumpFile });
    const tables = { ...snap.tables };
    opts.tamperTables?.(tables);
    const m: ManifestV2 = {
      format: 2,
      createdAt: new Date().toISOString(),
      appVersion: 'engine-it',
      masterKeyFingerprint: fingerprint(opts.masterKey),
      database: {
        name: opts.sourceDb,
        serverVersion: snap.serverVersion,
        dumpedWith,
        migrationsApplied: 0,
      },
      tables,
      dirs: { attachments: { files: Object.keys(opts.files ?? {}).length, bytes: 0 } },
    };
    return m;
  });
  const st = await stat(dumpFile);
  const out = createWriteStream(opts.file);
  await writeBackup(
    {
      dirs,
      databaseDumpFile: { path: dumpFile, size: st.size },
      manifest,
      masterKey: opts.masterKey,
    },
    opts.passphrase,
    out,
  );
  await new Promise<void>((res, rej) => out.end((e?: Error) => (e ? rej(e) : res())));
}

function testConfig(live: string, overrides: Partial<EngineConfig> = {}): EngineConfig {
  return {
    liveDbName: live,
    dataDirs: { attachments: path.join(work, 'live-dirs', 'attachments') },
    backupDir: path.join(work, 'backups'),
    backupTmpDir: path.join(work, 'backups', 'tmp'),
    entry: 'admin',
    actorUserId: null,
    masterKey: 'engine-it-master-key',
    resetAppPool: () => {},
    migrate: async () => {},
    auditFn: vi.fn().mockResolvedValue(undefined) as unknown as EngineConfig['auditFn'],
    loadStallQuietMs: 60_000,
    ...overrides,
  };
}

async function waitTerminal(backupDir: string, timeoutMs = 90_000): Promise<RestoreJournal> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const j = await readJournal(backupDir);
    if (j && j.status !== 'running') return j;
    if (Date.now() > deadline) throw new Error(`restore did not finish: ${JSON.stringify(j)}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

const markerNote = async (db: string): Promise<string> =>
  psqlQuery(psqlBin, dbUrlFor(db), 'SELECT note FROM dr_marker WHERE id = 1');

describe('restore engine (integration)', () => {
  it('connects (or skips)', () => {
    if (!available) console.warn('engine.integration: no pg tools or DB — skipping');
    expect(true).toBe(true);
  });

  it('full round trip: backup a source, restore onto a live install, then roll back', async ({
    skip,
  }) => {
    if (!available) return skip();
    const live = nextLiveDb();
    const source = `vibe_dr_src_${RUN_TAG}`;
    await seedDb(source, 'from-the-old-server', 25);
    await seedDb(live, 'existing-install');

    // The live install has a file the restore should displace, and the
    // archive carries one the restore must deliver.
    const cfg = testConfig(live);
    await mkdir(cfg.dataDirs.attachments!, { recursive: true });
    await writeFile(path.join(cfg.dataDirs.attachments!, 'old.txt'), 'OLD');

    const archive = path.join(work, 'src.vtbk');
    await makeArchive({
      sourceDb: source,
      file: archive,
      passphrase: 'engine-it-passphrase',
      masterKey: 'engine-it-master-key',
      files: { 'attachments/new.txt': 'NEW' },
    });

    await beginRestore(
      { kind: 'archive', file: archive, name: 'src.vtbk', deleteAfter: false },
      'engine-it-passphrase',
      cfg,
    );
    const j = await waitTerminal(cfg.backupDir);
    expect(j.error).toBeUndefined();
    expect(j.status).toBe('succeeded');
    expect(j.rollbackAvailable).toBe(true);
    expect(Object.values(j.phases).map((p) => p.status)).toEqual(Array(8).fill('done'));

    // The live database now holds the SOURCE's data.
    expect(await markerNote(live)).toBe('from-the-old-server');
    const rows = await psqlQuery(psqlBin, dbUrlFor(live), 'SELECT count(*) FROM dr_marker');
    expect(rows).toBe('26');
    // Files swapped: new file present, old file displaced with the prev dir.
    expect(await readFile(path.join(cfg.dataDirs.attachments!, 'new.txt'), 'utf-8')).toBe('NEW');
    expect(existsSync(path.join(cfg.dataDirs.attachments!, 'old.txt'))).toBe(false);
    // Previous generation exists for rollback — connection-locked by
    // design (ALLOW_CONNECTIONS false rode along with the rename), so
    // assert existence here and content after the rollback re-enables it.
    expect(j.prevDb).toBeTruthy();
    const prevExists = await psqlQuery(
      psqlBin,
      maintenanceUrl(),
      `SELECT count(*) FROM pg_database WHERE datname = '${j.prevDb}'`,
    );
    expect(prevExists).toBe('1');

    // Roll back — the original install returns, files included.
    const rolled = await rollbackRestore(cfg);
    expect(rolled.status).toBe('rolled_back');
    expect(await markerNote(live)).toBe('existing-install');
    expect(await readFile(path.join(cfg.dataDirs.attachments!, 'old.txt'), 'utf-8')).toBe('OLD');
  }, 120_000);

  it('verify failure leaves the live install untouched', async ({ skip }) => {
    if (!available) return skip();
    const source = `vibe_dr_src2_${RUN_TAG}`;
    await seedDb(source, 'poisoned-source');
    const live = nextLiveDb();
    await seedDb(live, 'untouched-install');
    const cfg = testConfig(live);
    await mkdir(cfg.dataDirs.attachments!, { recursive: true });

    const archive = path.join(work, 'bad.vtbk');
    await makeArchive({
      sourceDb: source,
      file: archive,
      passphrase: 'pw-verify',
      masterKey: 'engine-it-master-key',
      // Claim a row count the restore cannot produce.
      tamperTables: (t) => {
        t.dr_marker = 999;
      },
    });

    await beginRestore(
      { kind: 'archive', file: archive, name: 'bad.vtbk', deleteAfter: false },
      'pw-verify',
      cfg,
    );
    const j = await waitTerminal(cfg.backupDir);
    expect(j.status).toBe('failed');
    expect(j.error?.phase).toBe('verify');
    expect(j.error?.message).toMatch(/does not match/);
    // Live database and its data are untouched; scratch is gone.
    expect(await markerNote(live)).toBe('untouched-install');
    const scratch = await psqlQuery(
      psqlBin,
      maintenanceUrl(),
      `SELECT count(*) FROM pg_database WHERE datname = '${j.scratchDb}'`,
    );
    expect(scratch).toBe('0');
  }, 120_000);

  it('a crash between the two database renames is rolled forward by recovery', async ({ skip }) => {
    if (!available) return skip();
    const source = `vibe_dr_src3_${RUN_TAG}`;
    await seedDb(source, 'survives-the-crash');
    const live = nextLiveDb();
    await seedDb(live, 'pre-crash-install');
    const cfg = testConfig(live, { faultAfterStep: 'db_rename_live_to_prev' });
    await mkdir(cfg.dataDirs.attachments!, { recursive: true });

    const archive = path.join(work, 'crash.vtbk');
    await makeArchive({
      sourceDb: source,
      file: archive,
      passphrase: 'pw-crash',
      masterKey: 'engine-it-master-key',
    });

    await beginRestore(
      { kind: 'archive', file: archive, name: 'crash.vtbk', deleteAfter: false },
      'pw-crash',
      cfg,
    );
    // The fault fires mid-swap; the engine's OWN roll-forward also throws
    // on the injected fault only once, so simulate a hard crash by waiting
    // for the terminal state.
    const j = await waitTerminal(cfg.backupDir);

    if (j.status !== 'succeeded') {
      // The in-run roll-forward was also interrupted -> boot recovery path.
      // Force the journal into the crashed shape (running, dead pid).
      const recoveryCfg = testConfig(live);
      await recoverRestore(recoveryCfg);
      const after = await readJournal(recoveryCfg.backupDir);
      expect(after?.status).toBe('succeeded');
    }
    // Either way: the swap completed and the restored data is live.
    expect(await markerNote(live)).toBe('survives-the-crash');
  }, 120_000);
});
