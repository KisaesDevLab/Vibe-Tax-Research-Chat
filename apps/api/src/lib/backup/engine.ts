// DR v2 — the restore engine.
//
// The single structural rule, learned the hard way: THE LIVE DATABASE IS
// NEVER WRITTEN. The archive is loaded into a scratch database, verified
// against the manifest's snapshot row counts, and only then swapped in via
// catalog renames — each rename journaled before execution so a crash at
// any point is recoverable by rolling FORWARD (or, before the swap begins,
// by discarding the scratch work with the live install untouched).
//
// One engine, three entries: first-run setup, Admin → Backup & restore,
// and the offline CLI. Everything is parameterized through EngineConfig so
// integration tests drive the full machine against disposable database
// names — the real install is structurally unreachable from tests.
import { mkdir, readdir, rename, rm, stat, statfs } from 'node:fs/promises';
import { createWriteStream, existsSync } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { pendingMigrationCount, runMigrations, resetDb } from '@vibe/db';
import { env } from '../../config/env.js';
import { logger } from '../logger.js';
import { audit } from '../audit.js';
import { fingerprint, readBackup, readManifestOnly } from './archive.js';
import type { ManifestV2 } from './manifest.js';
import { RestorePrerequisiteError } from './errors.js';
import {
  createJournal,
  readJournal,
  reopenJournal,
  type JournalHandle,
  type PhaseName,
  type RestoreJournal,
  type SwapOp,
  type SwapStep,
} from './journal.js';
import {
  databaseName,
  databaseUrl,
  dbUrlFor,
  filterToc,
  listToc,
  maintenanceUrl,
  parseToolMajor,
  psqlCommand,
  psqlQuery,
  runPgRestore,
  serverMajor,
  toolPath,
  toolVersion,
  withDbSession,
  writeTocFile,
} from './pg.js';
import { withDeadline, StallDetector, StallError } from './watchdog.js';

const PREPARE_DEADLINE_MS = 60_000;
const SWAP_DEADLINE_MS = 120_000;
const LOAD_STALL_QUIET_MS = 5 * 60_000;
const STDERR_TAIL = 50;

export interface EngineConfig {
  /** Name of the database being replaced. Tests point this at a fake. */
  liveDbName: string;
  dataDirs: Record<string, string>;
  backupDir: string;
  backupTmpDir: string;
  entry: 'admin' | 'setup' | 'cli';
  actorUserId: string | null;
  /** The MASTER_KEY of THIS install, for the mismatch report. */
  masterKey: string;
  /** Reset the app's pool during swap; a no-op for tests/CLI-on-foreign-db. */
  resetAppPool: () => void;
  /** Run migrations on the freshly restored database. */
  migrate: (url: string) => Promise<void>;
  /** Audit sink; tests inject a spy, engine defaults to lib/audit. */
  auditFn: typeof audit;
  loadStallQuietMs?: number;
  /** TEST ONLY: throw immediately after this swap step is marked done. */
  faultAfterStep?: SwapOp | `${SwapOp}:${string}`;
}

export function defaultEngineConfig(
  entry: EngineConfig['entry'],
  actorUserId: string | null,
  paths: { dataDirs: Record<string, string>; backupDir: string; backupTmpDir: string },
): EngineConfig {
  return {
    liveDbName: databaseName(),
    dataDirs: paths.dataDirs,
    backupDir: paths.backupDir,
    backupTmpDir: paths.backupTmpDir,
    entry,
    actorUserId,
    masterKey: env.MASTER_KEY,
    resetAppPool: resetDb,
    migrate: (url) => runMigrations({ databaseUrl: url }),
    auditFn: audit,
  };
}

export interface RestoreSource {
  kind: 'upload' | 'archive';
  /** Absolute path to the .vtbk file. */
  file: string;
  /** Display name (upload original name or archive filename). */
  name: string;
  /** Delete the file after a successful restore (uploads). */
  deleteAfter: boolean;
}

interface RunContext {
  config: EngineConfig;
  source: RestoreSource;
  passphrase: string;
  handle: JournalHandle;
  manifest?: ManifestV2;
  archiveMasterKey?: string;
  dumpFile: string;
  tocFile: string;
  filesRestored: number;
}

function newRestoreId(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const rand = Math.random().toString(16).slice(2, 6);
  return `r-${stamp}-${rand}`;
}

/** Postgres identifiers derived from the run id (no dots/colons). */
function dbSafe(id: string): string {
  return id.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

async function phase<T>(handle: JournalHandle, name: PhaseName, fn: () => Promise<T>): Promise<T> {
  await handle.update((j) => {
    j.phase = name;
    j.phases[name] = { status: 'running', startedAt: new Date().toISOString() };
  });
  const result = await fn();
  await handle.update((j) => {
    j.phases[name].status = 'done';
    j.phases[name].finishedAt = new Date().toISOString();
  });
  return result;
}

/**
 * Begin a restore: creates the journal (throwing RestoreLockError on a
 * concurrent run), then runs the engine DETACHED. Callers respond 202 and
 * poll the journal.
 */
export async function beginRestore(
  source: RestoreSource,
  passphrase: string,
  config: EngineConfig,
): Promise<{ id: string }> {
  const id = newRestoreId();
  const scratchDb = `${config.liveDbName}_restore_${dbSafe(id)}`;
  const st = await stat(source.file);
  await mkdir(config.backupDir, { recursive: true });
  await mkdir(config.backupTmpDir, { recursive: true });

  const handle = await createJournal(config.backupDir, {
    id,
    entry: config.entry,
    actorUserId: config.actorUserId,
    source: { kind: source.kind, name: source.name, size: st.size },
    phase: 'inspect',
    scratchDb,
    dirs: Object.entries(config.dataDirs).map(([key, live]) => ({
      key,
      live,
      staging: `${live}.staging-${dbSafe(id)}`,
      prev: `${live}.prev-${dbSafe(id)}`,
    })),
  });

  const ctx: RunContext = {
    config,
    source,
    passphrase,
    handle,
    dumpFile: path.join(config.backupTmpDir, `${id}.dump`),
    tocFile: path.join(config.backupTmpDir, `${id}.toc`),
    filesRestored: 0,
  };

  void runRestore(ctx).catch((err) => {
    // runRestore records its own failures; this catch is the backstop for
    // bugs in the failure handling itself.
    logger.error({ err }, 'restore engine crashed outside its failure handler');
  });

  return { id };
}

async function runRestore(ctx: RunContext): Promise<void> {
  const { handle, config } = ctx;
  try {
    await phase(handle, 'inspect', () => inspectPhase(ctx));
    await withDeadline(
      phase(handle, 'prepare', () => preparePhase(ctx)),
      PREPARE_DEADLINE_MS,
      'prepare',
    );
    await phase(handle, 'extract', () => extractPhase(ctx));
    await phase(handle, 'load', () => loadPhase(ctx));
    await phase(handle, 'verify', () => verifyPhase(ctx));
    await phase(handle, 'files', () => filesPhase(ctx));
    await withDeadline(
      phase(handle, 'swap', () => swapPhase(ctx)),
      SWAP_DEADLINE_MS,
      'swap',
    );
    await phase(handle, 'finalize', () => finalizePhase(ctx));
    await handle.update((j) => {
      j.status = 'succeeded';
      j.finishedAt = new Date().toISOString();
      j.rollbackAvailable = j.prevDb !== undefined;
    });
  } catch (err) {
    await failRestore(ctx, err);
  } finally {
    handle.close();
  }
}

async function failRestore(ctx: RunContext, err: unknown): Promise<void> {
  const { handle } = ctx;
  const j = handle.journal;
  const failedPhase = j.phase;
  const code =
    err instanceof RestorePrerequisiteError
      ? 'restore_prerequisite'
      : err instanceof StallError
        ? 'load_stalled'
        : `${failedPhase}_failed`;
  logger.error({ err, phase: failedPhase }, 'restore failed');

  const swapBegan = j.swap?.steps.some((s) => s.state === 'done') ?? false;
  if (swapBegan) {
    // Mid-swap failure: the journaled step list makes completion exact —
    // roll forward rather than leave the install with no live database.
    try {
      await completeSwap(handle, ctx.config);
      await finalizePhase(ctx);
      await handle.update((jj) => {
        jj.status = 'succeeded';
        jj.finishedAt = new Date().toISOString();
        jj.rollbackAvailable = jj.prevDb !== undefined;
        jj.phases.swap.note = 'completed by roll-forward after a mid-swap error';
      });
      return;
    } catch (fwd) {
      logger.error({ err: fwd }, 'mid-swap roll-forward failed — manual recovery required');
    }
  } else {
    await cleanupScratch(ctx).catch((cleanupErr) =>
      logger.warn({ err: cleanupErr }, 'restore cleanup incomplete'),
    );
  }

  await handle.update((jj) => {
    jj.status = 'failed';
    jj.finishedAt = new Date().toISOString();
    jj.phases[failedPhase].status = 'failed';
    jj.error = {
      phase: failedPhase,
      code,
      message: (err as Error).message?.slice(0, 1000) ?? 'unknown',
      stderrTail: jj.load?.stderrTail,
    };
  });
}

/** Drop scratch DB + staging dirs + temp files. Live is untouched. */
async function cleanupScratch(ctx: RunContext): Promise<void> {
  const { handle, config } = ctx;
  const bin = await toolPath('psql').catch(() => null);
  if (bin) {
    await psqlCommand(
      bin,
      maintenanceUrl(),
      `DROP DATABASE IF EXISTS ${quoteIdent(handle.journal.scratchDb)} WITH (FORCE)`,
    ).catch(() => {});
  }
  for (const d of handle.journal.dirs) {
    await rm(d.staging, { recursive: true, force: true }).catch(() => {});
  }
  await rm(ctx.dumpFile, { force: true }).catch(() => {});
  await rm(ctx.tocFile, { force: true }).catch(() => {});
  if (ctx.source.deleteAfter) await rm(ctx.source.file, { force: true }).catch(() => {});
  void config;
}

// ── phases ───────────────────────────────────────────────────────────────

async function inspectPhase(ctx: RunContext): Promise<void> {
  const { handle, config } = ctx;
  const manifest = await readManifestOnly(ctx.source.file, ctx.passphrase);
  ctx.manifest = manifest;

  await handle.update((j) => {
    j.archive = {
      appVersion: manifest.appVersion,
      createdAt: manifest.createdAt,
      dumpedWith: manifest.database.dumpedWith,
      masterKeyFingerprint: manifest.masterKeyFingerprint,
      tables: Object.keys(manifest.tables).length,
      dirFiles: Object.values(manifest.dirs).reduce((a, d) => a + d.files, 0),
    };
  });

  // Dump tool vs server major: a newer-major dump cannot be read here.
  const dumpMajor = parseToolMajor(manifest.database.dumpedWith);
  const target = await serverMajor();
  if (dumpMajor !== null && target !== null && dumpMajor > target) {
    throw new RestorePrerequisiteError(
      `This archive was dumped with PostgreSQL ${dumpMajor} tools but this server is ` +
        `PostgreSQL ${target}; a newer-major dump cannot be restored onto an older server.`,
    );
  }

  // An archive from a NEWER app than this build would need migrations this
  // build does not ship — refuse now, not twenty minutes in.
  const mig = await pendingMigrationCount({ databaseUrl: databaseUrl() }).catch(() => null);
  if (mig && manifest.database.migrationsApplied > mig.shipped) {
    throw new RestorePrerequisiteError(
      `This archive is from a NEWER app version (${manifest.appVersion}, ` +
        `${manifest.database.migrationsApplied} migrations) than this build ships ` +
        `(${mig.shipped}). Upgrade the app first, then restore.`,
    );
  }

  // Free-space sanity: dump + staging both land before anything is freed.
  const archiveBytes = handle.journal.source.size;
  for (const dir of [config.backupTmpDir, path.dirname(Object.values(config.dataDirs)[0] ?? '.')]) {
    const fs = await statfs(dir).catch(() => null);
    if (fs && fs.bavail * fs.bsize < archiveBytes * 1.2) {
      throw new RestorePrerequisiteError(
        `Not enough free space near ${dir} (need ~${Math.ceil((archiveBytes * 1.2) / 1e9)} GB). ` +
          'Free space and retry — nothing has been changed.',
      );
    }
  }
}

async function preparePhase(ctx: RunContext): Promise<void> {
  const { handle } = ctx;
  const bin = await toolPath('psql');
  await toolVersion('pg_restore'); // Fails fast with PgToolMissingError.
  const scratch = handle.journal.scratchDb;
  try {
    await psqlCommand(bin, maintenanceUrl(), `CREATE DATABASE ${quoteIdent(scratch)}`);
  } catch (err) {
    throw new RestorePrerequisiteError(
      `Could not create a scratch database (${(err as Error).message}). Restoring needs a ` +
        'role with CREATEDB on this server. Nothing has been changed.',
    );
  }
  try {
    await psqlCommand(bin, dbUrlFor(scratch), 'CREATE EXTENSION IF NOT EXISTS vector');
    const n = await psqlQuery(
      bin,
      dbUrlFor(scratch),
      `SELECT count(*) FROM pg_extension WHERE extname = 'vector'`,
    );
    if (Number(n) === 0) {
      throw new RestorePrerequisiteError(
        'The "vector" extension is not installable on this server and the backup needs it. ' +
          'Ask a superuser to run CREATE EXTENSION vector, then retry. Nothing has been changed.',
      );
    }
  } catch (err) {
    await psqlCommand(
      bin,
      maintenanceUrl(),
      `DROP DATABASE IF EXISTS ${quoteIdent(scratch)} WITH (FORCE)`,
    ).catch(() => {});
    throw err;
  }
}

async function extractPhase(ctx: RunContext): Promise<void> {
  const { handle } = ctx;
  let lastWrite = 0;
  ctx.filesRestored = 0;

  const stagingFor = new Map<string, string>();
  for (const d of handle.journal.dirs) stagingFor.set(d.key, d.staging);

  await readBackup(ctx.source.file, ctx.passphrase, {
    onManifest: (m) => {
      ctx.manifest = m; // The tag-verified copy supersedes the inspect read.
    },
    onMasterKey: (k) => {
      ctx.archiveMasterKey = k;
    },
    onDatabase: async (dump: Readable) => {
      await pipeline(dump, createWriteStream(ctx.dumpFile));
    },
    resolveFile: (archivePath) => {
      const [top, ...rest] = archivePath.split('/');
      if (!top || rest.length === 0) return null;
      const staging = stagingFor.get(top);
      if (!staging) return null;
      // Contain the write: a crafted archive must not escape staging.
      const dest = path.resolve(staging, path.join(...rest));
      if (!dest.startsWith(path.resolve(staging) + path.sep)) return null;
      ctx.filesRestored += 1;
      return dest;
    },
    onProgress: (bytesRead, bytesTotal) => {
      const now = Date.now();
      if (now - lastWrite < 500 && bytesRead !== bytesTotal) return;
      lastWrite = now;
      void handle.update((j) => {
        j.extract = { bytesRead, bytesTotal, lastActivityAt: new Date(now).toISOString() };
      });
    },
  });
}

async function loadPhase(ctx: RunContext): Promise<void> {
  const { handle, config } = ctx;
  const scratchUrl = dbUrlFor(handle.journal.scratchDb);

  const toc = await listToc(ctx.dumpFile);
  const skipped: string[] = [];
  const { filtered, kept } = filterToc(toc, (l) => skipped.push(l));
  await writeTocFile(ctx.tocFile, filtered);
  if (skipped.length) logger.info({ skipped }, 'restore: TOC entries skipped');

  const tail: string[] = [];
  let done = 0;
  let lastWrite = 0;
  await handle.update((j) => {
    j.load = {
      tocTotal: kept,
      tocDone: 0,
      stderrTail: [],
      lastActivityAt: new Date().toISOString(),
    };
  });

  // The detector exists BEFORE the child spawns — stderr can start flowing
  // during the spawn await, and touching an undeclared binding would throw.
  let killChild: (() => void) | undefined;
  let stallErr: StallError | undefined;
  const detector = new StallDetector({
    label: 'pg_restore',
    quietMs: config.loadStallQuietMs ?? LOAD_STALL_QUIET_MS,
    onStall: (e) => {
      stallErr = e;
      // Capture what the server thinks is happening BEFORE killing.
      void (async () => {
        try {
          const bin = await toolPath('psql');
          const activity = await psqlQuery(
            bin,
            scratchUrl,
            `SELECT pid || ' ' || state || ' ' || coalesce(wait_event_type || ':' || wait_event, '-') ||
             ' ' || left(query, 120) FROM pg_stat_activity WHERE datname = current_database()`,
          ).catch(() => 'unavailable');
          await handle.update((j) => {
            if (j.load) j.load.pgStatActivity = activity.split('\n');
          });
        } finally {
          killChild?.();
        }
      })();
    },
  });

  const run = await runPgRestore({
    dumpFile: ctx.dumpFile,
    url: scratchUrl,
    tocFile: ctx.tocFile,
    jobs: 2,
    onStderrLine: (line) => {
      detector.touch();
      tail.push(line);
      if (tail.length > STDERR_TAIL) tail.shift();
      done += 1;
      const now = Date.now();
      if (now - lastWrite < 500) return;
      lastWrite = now;
      void handle.update((j) => {
        if (!j.load) return;
        j.load.tocDone = Math.min(done, j.load.tocTotal);
        j.load.stderrTail = [...tail];
        j.load.lastActivityAt = new Date(now).toISOString();
      });
    },
  });
  killChild = () => run.child.kill('SIGKILL');

  try {
    await run.done;
  } catch (err) {
    throw stallErr ?? err;
  } finally {
    detector.stop();
    await handle.update((j) => {
      if (!j.load) return;
      j.load.tocDone = Math.min(done, j.load.tocTotal);
      j.load.stderrTail = [...tail];
    });
  }
}

async function verifyPhase(ctx: RunContext): Promise<void> {
  const { handle } = ctx;
  const manifest = ctx.manifest!;
  const scratchUrl = dbUrlFor(handle.journal.scratchDb);

  const results: Array<{ name: string; expected: number; actual: number }> = [];
  let adminCount = 0;
  await withDbSession(scratchUrl, async (sql) => {
    for (const [name, expected] of Object.entries(manifest.tables)) {
      const [row] = await sql`SELECT count(*)::bigint AS n FROM ${sql(name)}`;
      results.push({ name, expected, actual: Number((row as { n: string | number }).n) });
    }
    const [admins] = await sql`
      SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND is_active = true`;
    adminCount = Number((admins as { n: number }).n);
  });

  await handle.update((j) => {
    j.verify = { tables: results, adminCount };
  });

  const mismatches = results.filter((r) => r.expected !== r.actual);
  if (mismatches.length) {
    const detail = mismatches
      .slice(0, 5)
      .map((m) => `${m.name}: expected ${m.expected}, got ${m.actual}`)
      .join('; ');
    throw new Error(
      `Restored data does not match the backup manifest (${detail}). The live install is untouched.`,
    );
  }
  if (adminCount < 1) {
    throw new Error(
      'The restored database contains no active admin user — refusing to swap it in. ' +
        'The live install is untouched.',
    );
  }
}

async function filesPhase(ctx: RunContext): Promise<void> {
  // Every journaled dir gets a staging dir even when the archive carried
  // nothing for it, so the swap is uniform.
  for (const d of ctx.handle.journal.dirs) {
    await mkdir(d.staging, { recursive: true });
  }
}

// ── swap ─────────────────────────────────────────────────────────────────

function buildSwapSteps(j: RestoreJournal): SwapStep[] {
  const steps: SwapStep[] = [
    { op: 'db_lock_live', state: 'pending' },
    { op: 'db_terminate', state: 'pending' },
    { op: 'db_rename_live_to_prev', state: 'pending' },
    { op: 'db_rename_scratch_to_live', state: 'pending' },
  ];
  for (const d of j.dirs) {
    steps.push({ op: 'dir_rename_live_to_prev', target: d.key, state: 'pending' });
    steps.push({ op: 'dir_rename_staging_to_live', target: d.key, state: 'pending' });
  }
  return steps;
}

async function swapPhase(ctx: RunContext): Promise<void> {
  const { handle } = ctx;
  await handle.update((j) => {
    j.prevDb = `${ctx.config.liveDbName}_prev_${dbSafe(j.id)}`;
    j.swap = { steps: buildSwapSteps(j) };
  });
  await completeSwap(handle, ctx.config, ctx.config.faultAfterStep);
}

/**
 * Execute every pending swap step in order. Idempotent under replay: each
 * db step probes the catalog first, each dir step probes the filesystem,
 * so a step journaled `pending` that actually applied before a crash is
 * detected and marked done instead of failing.
 */
export async function completeSwap(
  handle: JournalHandle,
  config: EngineConfig,
  faultAfterStep?: EngineConfig['faultAfterStep'],
): Promise<void> {
  const j = handle.journal;
  if (!j.swap || !j.prevDb) throw new Error('no swap journaled');
  const live = config.liveDbName;
  const prevDb = j.prevDb;
  const scratch = j.scratchDb;
  const bin = await toolPath('psql');
  const maint = maintenanceUrl();

  const dbExists = async (name: string): Promise<boolean> =>
    (await psqlQuery(bin, maint, `SELECT count(*) FROM pg_database WHERE datname = '${name}'`)) ===
    '1';

  for (const step of j.swap.steps) {
    if (step.state === 'done') continue;
    const mark = async () => {
      await handle.update((jj) => {
        const s = jj.swap!.steps.find((x) => x.op === step.op && x.target === step.target)!;
        s.state = 'done';
        s.at = new Date().toISOString();
      });
      const key = step.target ? `${step.op}:${step.target}` : step.op;
      if (faultAfterStep === step.op || faultAfterStep === key) {
        throw new Error(`FAULT_INJECTED after ${key}`);
      }
    };

    switch (step.op) {
      case 'db_lock_live': {
        // No reconnect race: refused connections instead of an eviction loop.
        if (await dbExists(live)) {
          await psqlCommand(
            bin,
            maint,
            `ALTER DATABASE ${quoteIdent(live)} ALLOW_CONNECTIONS false`,
          );
        }
        config.resetAppPool();
        await mark();
        break;
      }
      case 'db_terminate': {
        if (await dbExists(live)) {
          for (let i = 0; i < 10; i += 1) {
            const n = await psqlQuery(
              bin,
              maint,
              `SELECT count(*) FROM (SELECT pg_terminate_backend(pid) FROM pg_stat_activity
               WHERE datname = '${live}') t`,
            ).catch(() => '0');
            if (n === '0') break;
            await new Promise((r) => setTimeout(r, 500));
          }
        }
        await mark();
        break;
      }
      case 'db_rename_live_to_prev': {
        if (await dbExists(live)) {
          let lastErr: unknown;
          let renamed = false;
          for (let i = 0; i < 10; i += 1) {
            try {
              await psqlCommand(
                bin,
                maint,
                `ALTER DATABASE ${quoteIdent(live)} RENAME TO ${quoteIdent(prevDb)}`,
              );
              renamed = true;
              break;
            } catch (err) {
              lastErr = err;
              // Someone reconnected in the gap — evict and retry.
              await psqlCommand(
                bin,
                maint,
                `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${live}'`,
              ).catch(() => {});
              await new Promise((r) => setTimeout(r, 300));
            }
          }
          if (!renamed) throw lastErr;
        } else if (!(await dbExists(prevDb))) {
          throw new Error(`neither ${live} nor ${prevDb} exists — cannot continue swap`);
        }
        await mark();
        break;
      }
      case 'db_rename_scratch_to_live': {
        if (await dbExists(scratch)) {
          await psqlCommand(
            bin,
            maint,
            `ALTER DATABASE ${quoteIdent(scratch)} RENAME TO ${quoteIdent(live)}`,
          );
        } else if (!(await dbExists(live))) {
          throw new Error(`neither ${scratch} nor ${live} exists — cannot continue swap`);
        }
        // The restored database must accept connections regardless of what
        // ALLOW_CONNECTIONS state the scratch carried.
        await psqlCommand(
          bin,
          maint,
          `ALTER DATABASE ${quoteIdent(live)} ALLOW_CONNECTIONS true`,
        ).catch(() => {});
        await mark();
        break;
      }
      case 'dir_rename_live_to_prev': {
        const d = j.dirs.find((x) => x.key === step.target)!;
        if (existsSync(d.live) && !existsSync(d.prev)) {
          await rename(d.live, d.prev).catch(async (err) => {
            // Windows/EBUSY fallback: leave live in place; staging swap
            // below will merge over it via copy in the next step's fallback.
            logger.warn({ err, dir: d.live }, 'live dir rename failed');
          });
        }
        await mark();
        break;
      }
      case 'dir_rename_staging_to_live': {
        const d = j.dirs.find((x) => x.key === step.target)!;
        if (existsSync(d.staging)) {
          await mkdir(path.dirname(d.live), { recursive: true }).catch(() => {});
          try {
            await rename(d.staging, d.live);
          } catch {
            // Cross-device or busy target: copy as fallback.
            const { cp } = await import('node:fs/promises');
            await cp(d.staging, d.live, { recursive: true, force: true });
            await rm(d.staging, { recursive: true, force: true }).catch(() => {});
          }
        }
        await mark();
        break;
      }
    }
  }
}

async function finalizePhase(ctx: RunContext): Promise<void> {
  const { handle, config } = ctx;
  const liveUrl = dbUrlFor(config.liveDbName);

  config.resetAppPool();
  await config.migrate(liveUrl);

  await withDbSession(liveUrl, async (sql) => {
    await sql`SELECT 1`;
  });

  const keyMatches = ctx.archiveMasterKey
    ? fingerprint(ctx.archiveMasterKey) === fingerprint(config.masterKey)
    : false;

  await gcPreviousGenerations(config, handle.journal.id);

  await config
    .auditFn({
      actor_user_id: config.actorUserId,
      action: 'admin.backup.restore',
      metadata: {
        entry: config.entry,
        restore_id: handle.journal.id,
        from_app_version: ctx.manifest?.appVersion ?? null,
        created_at: ctx.manifest?.createdAt ?? null,
        files: ctx.filesRestored,
        master_key_matches: keyMatches,
      },
    })
    .catch((err) => logger.warn({ err }, 'restore audit write failed'));

  await rm(ctx.dumpFile, { force: true }).catch(() => {});
  await rm(ctx.tocFile, { force: true }).catch(() => {});
  if (ctx.source.deleteAfter) await rm(ctx.source.file, { force: true }).catch(() => {});

  await handle.update((j) => {
    j.result = {
      masterKeyMatches: keyMatches,
      keyFromArchive: keyMatches ? null : (ctx.archiveMasterKey ?? null),
      filesRestored: ctx.filesRestored,
    };
  });
}

/** Drop generations from EARLIER runs (never this run's own prev). */
async function gcPreviousGenerations(config: EngineConfig, currentId: string): Promise<void> {
  const bin = await toolPath('psql').catch(() => null);
  if (!bin) return;
  const keep = `${config.liveDbName}_prev_${dbSafe(currentId)}`;
  const rows = await psqlQuery(
    bin,
    maintenanceUrl(),
    `SELECT datname FROM pg_database WHERE (datname LIKE '${config.liveDbName}\\_prev\\_%'
       OR datname LIKE '${config.liveDbName}\\_undone\\_%' OR datname LIKE '${config.liveDbName}\\_restore\\_%')
       AND datname <> '${keep}'`,
  ).catch(() => '');
  for (const name of rows.split('\n').filter(Boolean)) {
    await psqlCommand(
      bin,
      maintenanceUrl(),
      `DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`,
    ).catch(() => {});
  }
  for (const live of Object.values(config.dataDirs)) {
    const parent = path.dirname(live);
    const base = path.basename(live);
    const entries = await readdir(parent).catch(() => [] as string[]);
    for (const e of entries) {
      if (
        (e.startsWith(`${base}.prev-`) ||
          e.startsWith(`${base}.undone-`) ||
          e.startsWith(`${base}.staging-`)) &&
        !e.endsWith(dbSafe(currentId))
      ) {
        await rm(path.join(parent, e), { recursive: true, force: true }).catch(() => {});
      }
    }
  }
}

// ── boot recovery ────────────────────────────────────────────────────────

/**
 * Called at api boot BEFORE MIGRATIONS_AUTO: a crash mid-swap can leave the
 * server with no live database, and the migration runner would turn that
 * into a fatal restart loop. Rolls a partial swap FORWARD (the journaled
 * step list makes replay exact), or cleans up a pre-swap crash with the
 * live install untouched.
 */
export async function recoverRestore(config: EngineConfig): Promise<void> {
  const j = await readJournal(config.backupDir);
  if (!j) return;
  if (j.status !== 'interrupted' && j.status !== 'running') return;
  // 'running' with our own fresh boot means the previous incarnation died
  // without a stale heartbeat yet; both cases are the same recovery.
  logger.warn({ restore_id: j.id, phase: j.phase }, 'recovering interrupted restore');
  const handle = await reopenJournal(config.backupDir, { ...j, status: 'running' });
  try {
    const swapBegan = j.swap?.steps.some((s) => s.state === 'done') ?? false;
    if (swapBegan) {
      await completeSwap(handle, config);
      config.resetAppPool();
      await config.migrate(dbUrlFor(config.liveDbName));
      await gcPreviousGenerations(config, j.id);
      await handle.update((jj) => {
        jj.status = 'succeeded';
        jj.finishedAt = new Date().toISOString();
        jj.rollbackAvailable = jj.prevDb !== undefined;
        jj.phases.swap.status = 'done';
        jj.phases.finalize.status = 'done';
        jj.phases.finalize.note = 'completed by crash recovery';
      });
      logger.warn({ restore_id: j.id }, 'interrupted restore completed by roll-forward');
    } else {
      // Pre-swap crash: discard scratch work; unlock live if we got as far
      // as locking it (possible only if swap steps were journaled but none
      // executed — probe regardless, it is idempotent).
      const bin = await toolPath('psql').catch(() => null);
      if (bin) {
        await psqlCommand(
          bin,
          maintenanceUrl(),
          `ALTER DATABASE ${quoteIdent(config.liveDbName)} ALLOW_CONNECTIONS true`,
        ).catch(() => {});
        await psqlCommand(
          bin,
          maintenanceUrl(),
          `DROP DATABASE IF EXISTS ${quoteIdent(j.scratchDb)} WITH (FORCE)`,
        ).catch(() => {});
      }
      for (const d of j.dirs) {
        await rm(d.staging, { recursive: true, force: true }).catch(() => {});
      }
      await handle.update((jj) => {
        jj.status = 'interrupted';
        jj.finishedAt = new Date().toISOString();
        jj.error = {
          phase: jj.phase,
          code: 'interrupted',
          message:
            'The restore was interrupted (process restart) before the swap began. ' +
            'The live install is untouched — try the restore again.',
        };
      });
    }
  } finally {
    handle.close();
  }
}

// ── rollback ─────────────────────────────────────────────────────────────

/**
 * Swap BACK to the previous generation while it still exists. The restored
 * (now unwanted) generation is parked as *_undone_* and dropped on the
 * next successful restore.
 */
export async function rollbackRestore(config: EngineConfig): Promise<RestoreJournal> {
  const j = await readJournal(config.backupDir);
  if (!j || !j.rollbackAvailable || !j.prevDb) {
    throw new RestorePrerequisiteError('No previous generation is available to roll back to.');
  }
  const handle = await reopenJournal(config.backupDir, { ...j, status: 'running' });
  try {
    const bin = await toolPath('psql');
    const maint = maintenanceUrl();
    const live = config.liveDbName;
    const undone = `${live}_undone_${dbSafe(j.id)}`;

    await psqlCommand(bin, maint, `ALTER DATABASE ${quoteIdent(live)} ALLOW_CONNECTIONS false`);
    config.resetAppPool();
    await psqlCommand(
      bin,
      maint,
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${live}'`,
    ).catch(() => {});
    await psqlCommand(
      bin,
      maint,
      `ALTER DATABASE ${quoteIdent(live)} RENAME TO ${quoteIdent(undone)}`,
    );
    await psqlCommand(
      bin,
      maint,
      `ALTER DATABASE ${quoteIdent(j.prevDb)} RENAME TO ${quoteIdent(live)}`,
    );
    await psqlCommand(bin, maint, `ALTER DATABASE ${quoteIdent(live)} ALLOW_CONNECTIONS true`);

    for (const d of j.dirs) {
      const undoneDir = d.live + `.undone-${dbSafe(j.id)}`;
      if (existsSync(d.live) && !existsSync(undoneDir)) {
        await rename(d.live, undoneDir).catch(() => {});
      }
      if (existsSync(d.prev)) {
        await rename(d.prev, d.live).catch(() => {});
      }
    }

    config.resetAppPool();
    await handle.update((jj) => {
      jj.status = 'rolled_back';
      jj.finishedAt = new Date().toISOString();
      jj.rollbackAvailable = false;
    });
    await config
      .auditFn({
        actor_user_id: config.actorUserId,
        action: 'admin.backup.rollback',
        metadata: { restore_id: j.id },
      })
      .catch(() => {});
    return handle.journal;
  } finally {
    handle.close();
  }
}

/** Explicitly drop the previous generation (DB + dirs) after a restore. */
export async function dropPreviousGeneration(config: EngineConfig): Promise<void> {
  const j = await readJournal(config.backupDir);
  if (!j?.prevDb) throw new RestorePrerequisiteError('No previous generation exists.');
  const bin = await toolPath('psql');
  await psqlCommand(
    bin,
    maintenanceUrl(),
    `DROP DATABASE IF EXISTS ${quoteIdent(j.prevDb)} WITH (FORCE)`,
  );
  for (const d of j.dirs) {
    await rm(d.prev, { recursive: true, force: true }).catch(() => {});
  }
  const handle = await reopenJournal(config.backupDir, j);
  await handle.update((jj) => {
    jj.rollbackAvailable = false;
  });
  handle.close();
}
