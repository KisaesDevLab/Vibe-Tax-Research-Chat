// DR v2 — server-side backup job.
//
// Backups are built INTO the backups volume and retained there; the admin
// downloads a finished archive as a separate streamed read. The v1 design
// piped the archive into the HTTP response, which meant the browser
// buffered the whole thing in memory (multi-GB installs OOM'd the tab) and
// nothing was ever retained on the appliance.
//
// The job runs in-process with durable status in BACKUP_DIR/
// backup-status.json (same pattern as the restore journal): a `.partial`
// suffix marks in-flight archives, a startup sweep clears orphans, and the
// backup/restore locks exclude each other.
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { pendingMigrationCount } from '@vibe/db';
import { env } from '../../config/env.js';
import { logger } from '../logger.js';
import { audit } from '../audit.js';
import { fingerprint, writeBackup } from './archive.js';
import type { ManifestV2 } from './manifest.js';
import { databaseName, databaseUrl, runPgDump, withSnapshot } from './pg.js';
import { readJournal } from './journal.js';

export const ARCHIVE_NAME_RE = /^vibe-tax-backup-[A-Za-z0-9-]+\.vtbk$/;
const STATUS_FILE = 'backup-status.json';

export interface BackupStatus {
  id: string;
  status: 'running' | 'succeeded' | 'failed';
  startedAt: string;
  heartbeatAt: string;
  finishedAt?: string;
  phase: 'snapshot' | 'dump' | 'archive' | 'finalize';
  archive?: { bytesWritten: number; currentEntry: string };
  file?: { name: string; size: number };
  error?: string;
}

export class BackupBusyError extends Error {}

export interface BackupJobConfig {
  backupDir: string;
  backupTmpDir: string;
  dataDirs: Record<string, string>;
  appVersion: string;
  masterKey: string;
  actorUserId: string | null;
  auditFn: typeof audit;
}

export function defaultBackupJobConfig(
  actorUserId: string | null,
  paths: { dataDirs: Record<string, string>; backupDir: string; backupTmpDir: string },
): BackupJobConfig {
  return {
    ...paths,
    appVersion: process.env.APP_VERSION ?? 'dev',
    masterKey: env.MASTER_KEY,
    actorUserId,
    auditFn: audit,
  };
}

function statusPath(dir: string): string {
  return path.join(dir, STATUS_FILE);
}

export async function readBackupStatus(dir: string): Promise<BackupStatus | null> {
  try {
    const s = JSON.parse(await readFile(statusPath(dir), 'utf-8')) as BackupStatus;
    if (s.status === 'running' && Date.now() - Date.parse(s.heartbeatAt) > 60_000) {
      return { ...s, status: 'failed', error: 'The backup was interrupted (process restart).' };
    }
    return s;
  } catch {
    return null;
  }
}

async function writeStatus(dir: string, s: BackupStatus): Promise<void> {
  await writeFile(statusPath(dir), JSON.stringify(s, null, 2), 'utf-8');
}

async function walkStats(root: string): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      // Restore generations inside the data dirs are excluded from
      // archives; the manifest inventory must match.
      if (e.name.startsWith('.dr-')) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) await walk(abs);
      else if (e.isFile()) {
        const st = await stat(abs).catch(() => null);
        if (st) {
          files += 1;
          bytes += st.size;
        }
      }
    }
  };
  await walk(root);
  return { files, bytes };
}

/**
 * Start a backup. Returns the job id immediately; the work continues
 * detached with durable status. Refuses while a backup OR restore runs.
 */
export async function startBackup(
  passphrase: string,
  config: BackupJobConfig,
): Promise<{ id: string }> {
  await mkdir(config.backupDir, { recursive: true });
  await mkdir(config.backupTmpDir, { recursive: true });

  const current = await readBackupStatus(config.backupDir);
  if (current?.status === 'running') throw new BackupBusyError('A backup is already running.');
  const restore = await readJournal(config.backupDir);
  if (restore?.status === 'running') throw new BackupBusyError('A restore is running.');

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const id = `b-${stamp}`;
  const status: BackupStatus = {
    id,
    status: 'running',
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    phase: 'snapshot',
  };
  await writeStatus(config.backupDir, status);

  void runBackup(id, passphrase, config, status).catch((err) =>
    logger.error({ err }, 'backup job crashed outside its failure handler'),
  );
  return { id };
}

async function runBackup(
  id: string,
  passphrase: string,
  config: BackupJobConfig,
  status: BackupStatus,
): Promise<void> {
  const heartbeat = setInterval(() => {
    status.heartbeatAt = new Date().toISOString();
    void writeStatus(config.backupDir, status).catch(() => {});
  }, 5_000);
  heartbeat.unref?.();

  const filename = `vibe-tax-backup-${id.slice(2)}.vtbk`;
  const partial = path.join(config.backupDir, `${filename}.partial`);
  const dumpFile = path.join(config.backupTmpDir, `${id}.dump`);

  try {
    const url = databaseUrl();
    let manifest!: ManifestV2;

    await withSnapshot(url, async (snap) => {
      status.phase = 'dump';
      await writeStatus(config.backupDir, status);
      const { dumpedWith } = await runPgDump({
        url,
        snapshotId: snap.snapshotId,
        outFile: dumpFile,
      });

      const mig = await pendingMigrationCount({ databaseUrl: url }).catch(() => null);
      const dirs: ManifestV2['dirs'] = {};
      for (const [key, dir] of Object.entries(config.dataDirs)) {
        dirs[key] = await walkStats(dir);
      }
      manifest = {
        format: 2,
        createdAt: new Date().toISOString(),
        appVersion: config.appVersion,
        masterKeyFingerprint: fingerprint(config.masterKey),
        database: {
          name: databaseName(),
          serverVersion: snap.serverVersion,
          dumpedWith,
          migrationsApplied: mig?.applied ?? 0,
        },
        tables: snap.tables,
        dirs,
      };
    });

    status.phase = 'archive';
    await writeStatus(config.backupDir, status);
    const dumpStat = await stat(dumpFile);
    const out = createWriteStream(partial);
    let lastWrite = 0;
    await writeBackup(
      {
        dirs: config.dataDirs,
        databaseDumpFile: { path: dumpFile, size: dumpStat.size },
        manifest,
        masterKey: config.masterKey,
      },
      passphrase,
      out,
      (bytesWritten, currentEntry) => {
        const now = Date.now();
        if (now - lastWrite < 500) return;
        lastWrite = now;
        status.archive = { bytesWritten, currentEntry };
        void writeStatus(config.backupDir, status).catch(() => {});
      },
    );
    await new Promise<void>((res, rej) => out.end((e?: Error) => (e ? rej(e) : res())));

    status.phase = 'finalize';
    const final = path.join(config.backupDir, filename);
    await rename(partial, final);
    const finalStat = await stat(final);

    await config
      .auditFn({
        actor_user_id: config.actorUserId,
        action: 'admin.backup.create',
        metadata: {
          filename,
          bytes: finalStat.size,
          app_version: config.appVersion,
          tables: Object.keys(manifest.tables).length,
        },
      })
      .catch((err) => logger.warn({ err }, 'backup audit write failed'));

    status.status = 'succeeded';
    status.finishedAt = new Date().toISOString();
    status.file = { name: filename, size: finalStat.size };
    await writeStatus(config.backupDir, status);
    logger.info({ filename, bytes: finalStat.size }, 'backup archive written');
  } catch (err) {
    logger.error({ err }, 'backup failed');
    status.status = 'failed';
    status.finishedAt = new Date().toISOString();
    status.error = (err as Error).message?.slice(0, 500) ?? 'unknown';
    await writeStatus(config.backupDir, status).catch(() => {});
    await rm(partial, { force: true }).catch(() => {});
  } finally {
    clearInterval(heartbeat);
    await rm(dumpFile, { force: true }).catch(() => {});
  }
}

export interface ArchiveInfo {
  name: string;
  size: number;
  createdAt: string;
}

export async function listArchives(backupDir: string): Promise<ArchiveInfo[]> {
  const entries = await readdir(backupDir).catch(() => [] as string[]);
  const out: ArchiveInfo[] = [];
  for (const name of entries) {
    if (!ARCHIVE_NAME_RE.test(name)) continue;
    const st = await stat(path.join(backupDir, name)).catch(() => null);
    if (st) out.push({ name, size: st.size, createdAt: st.mtime.toISOString() });
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function deleteArchive(backupDir: string, name: string): Promise<boolean> {
  if (!ARCHIVE_NAME_RE.test(name)) return false;
  const target = path.join(backupDir, name);
  const st = await stat(target).catch(() => null);
  if (!st) return false;
  await rm(target, { force: true });
  return true;
}

/** Remove orphaned .partial archives and spool files older than a day —
 *  leftovers of a process that died mid-backup. Called at boot. */
export async function sweepOrphans(backupDir: string, backupTmpDir: string): Promise<void> {
  const dayAgo = Date.now() - 24 * 3600 * 1000;
  for (const dir of [backupDir, backupTmpDir]) {
    const entries = await readdir(dir).catch(() => [] as string[]);
    for (const name of entries) {
      if (!name.endsWith('.partial') && !name.endsWith('.dump') && !name.endsWith('.toc')) continue;
      const abs = path.join(dir, name);
      const st = await stat(abs).catch(() => null);
      if (st && st.mtimeMs < dayAgo) await rm(abs, { force: true }).catch(() => {});
    }
  }
}
