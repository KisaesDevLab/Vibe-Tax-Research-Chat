// DR v2 — Admin → Backup & restore.
//
// Backups are server-side jobs retained in the backups volume (list /
// download / delete); restores go through the scratch-database engine and
// are observable via the durable journal. Nothing here buffers an archive
// in memory, and nothing here can write the live database — that is the
// engine's swap, or nothing.
import { Router } from 'express';
import { z } from 'zod';
import multer from 'multer';
import { createReadStream } from 'node:fs';
import { mkdir, rm, stat, statfs } from 'node:fs/promises';
import path from 'node:path';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { audit } from '../../lib/audit.js';
import { env } from '../../config/env.js';
import { backupDir, backupTmpDir, dataDirs } from '../../config/paths.js';
import { fingerprint } from '../../lib/backup/archive.js';
import { toolVersion } from '../../lib/backup/pg.js';
import { PgToolMissingError, RestorePrerequisiteError } from '../../lib/backup/errors.js';
import {
  ARCHIVE_NAME_RE,
  BackupBusyError,
  defaultBackupJobConfig,
  deleteArchive,
  listArchives,
  readBackupStatus,
  startBackup,
} from '../../lib/backup/backup-job.js';
import {
  beginRestore,
  defaultEngineConfig,
  dropPreviousGeneration,
  rollbackRestore,
} from '../../lib/backup/engine.js';
import { readJournal, redactJournal, RestoreLockError } from '../../lib/backup/journal.js';

export const adminBackupRouter = Router();
adminBackupRouter.use(requireAuth, requireRole('admin'));

const APP_VERSION = process.env.APP_VERSION ?? 'dev';

// A passphrase short enough to brute-force defeats the point of encrypting
// an archive that carries every credential in the install.
const MIN_PASSPHRASE = 12;

function enginePaths() {
  return { dataDirs: dataDirs(), backupDir: backupDir(), backupTmpDir: backupTmpDir() };
}

// ── status ───────────────────────────────────────────────────────────────

adminBackupRouter.get('/status', async (req, res) => {
  let pgTools: { pg_dump?: string; pg_restore?: string; error?: string } = {};
  try {
    pgTools = {
      pg_dump: await toolVersion('pg_dump'),
      pg_restore: await toolVersion('pg_restore'),
    };
  } catch (err) {
    pgTools = { error: (err as Error).message };
  }
  const dirs: Record<string, boolean> = {};
  for (const [key, dir] of Object.entries(dataDirs())) {
    dirs[key] = await stat(dir)
      .then(() => true)
      .catch(() => false);
  }
  const free = await statfs(backupDir()).catch(() => null);
  res.json({
    appVersion: APP_VERSION,
    pgTools,
    dirs,
    backupDirFreeBytes: free ? free.bavail * free.bsize : null,
    masterKeyFingerprint: fingerprint(env.MASTER_KEY),
    minPassphrase: MIN_PASSPHRASE,
  });
  void req;
});

// ── backup job ───────────────────────────────────────────────────────────

const createSchema = z.object({ passphrase: z.string().min(MIN_PASSPHRASE) });

adminBackupRouter.post('/', async (req, res) => {
  const parsed = createSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      error: 'bad_request',
      message: `A passphrase of at least ${MIN_PASSPHRASE} characters is required.`,
    });
    return;
  }
  try {
    await toolVersion('pg_dump');
  } catch (err) {
    if (err instanceof PgToolMissingError) {
      res.status(503).json({ error: 'pg_tools_missing', message: err.message });
      return;
    }
    throw err;
  }
  try {
    const { id } = await startBackup(
      parsed.data.passphrase,
      defaultBackupJobConfig(req.auth!.user_id, enginePaths()),
    );
    res.status(202).json({ id });
  } catch (err) {
    if (err instanceof BackupBusyError) {
      res.status(409).json({ error: 'busy', message: err.message });
      return;
    }
    throw err;
  }
});

adminBackupRouter.get('/jobs/current', async (_req, res) => {
  res.json((await readBackupStatus(backupDir())) ?? { status: 'idle' });
});

// ── archives ─────────────────────────────────────────────────────────────

adminBackupRouter.get('/archives', async (_req, res) => {
  res.json({ archives: await listArchives(backupDir()) });
});

adminBackupRouter.get('/archives/:name/download', async (req, res) => {
  const name = req.params.name;
  if (!ARCHIVE_NAME_RE.test(name)) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  const file = path.join(backupDir(), name);
  const st = await stat(file).catch(() => null);
  if (!st) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  await audit({
    actor_user_id: req.auth!.user_id,
    action: 'admin.backup.download',
    metadata: { filename: name, bytes: st.size },
    ip: req.ip,
  });
  res.setHeader('content-type', 'application/octet-stream');
  res.setHeader('content-length', String(st.size));
  res.setHeader('content-disposition', `attachment; filename="${name}"`);
  res.setHeader('cache-control', 'no-store');
  createReadStream(file).pipe(res);
});

adminBackupRouter.delete('/archives/:name', async (req, res) => {
  const name = req.params.name;
  if (!(await deleteArchive(backupDir(), name))) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  await audit({
    actor_user_id: req.auth!.user_id,
    action: 'admin.backup.delete_archive',
    metadata: { filename: name },
    ip: req.ip,
  });
  res.json({ ok: true });
});

// ── restore ──────────────────────────────────────────────────────────────

const restoreUpload = multer({
  storage: multer.diskStorage({
    // Same volume as the archives — multi-GB uploads never land on
    // container tmpfs. Created on demand: the volume may be empty on a
    // fresh install.
    destination: (_req, _file, cb) => {
      void mkdir(backupTmpDir(), { recursive: true }).then(
        () => cb(null, backupTmpDir()),
        (err: Error) => cb(err, ''),
      );
    },
    filename: (_req, _file, cb) => cb(null, `upload-${Date.now()}.vtbk`),
  }),
  limits: { fileSize: 40 * 1024 * 1024 * 1024 },
});

const restoreSchema = z.object({
  passphrase: z.string().min(1),
  confirm: z.literal('replace-all-data'),
  /** Restore an archive already in the backups volume instead of an upload. */
  archive: z.string().regex(ARCHIVE_NAME_RE).optional(),
});

adminBackupRouter.post('/restore', restoreUpload.single('file'), async (req, res) => {
  const parsed = restoreSchema.safeParse(req.body ?? {});
  const cleanupUpload = () => rm(req.file?.path ?? '', { force: true }).catch(() => {});
  if (!parsed.success) {
    await cleanupUpload();
    res.status(400).json({
      error: 'bad_request',
      message: 'A passphrase and confirm=replace-all-data are required.',
    });
    return;
  }
  let source;
  if (req.file) {
    source = {
      kind: 'upload' as const,
      file: req.file.path,
      name: req.file.originalname || path.basename(req.file.path),
      deleteAfter: true,
    };
  } else if (parsed.data.archive) {
    const file = path.join(backupDir(), parsed.data.archive);
    if (!(await stat(file).catch(() => null))) {
      res.status(404).json({ error: 'not_found', message: 'No such archive.' });
      return;
    }
    source = { kind: 'archive' as const, file, name: parsed.data.archive, deleteAfter: false };
  } else {
    res.status(400).json({
      error: 'bad_request',
      message: 'Provide a backup file upload or the name of a retained archive.',
    });
    return;
  }

  const backupRunning = (await readBackupStatus(backupDir()))?.status === 'running';
  if (backupRunning) {
    await cleanupUpload();
    res.status(409).json({ error: 'busy', message: 'A backup is currently running.' });
    return;
  }

  try {
    const { id } = await beginRestore(
      source,
      parsed.data.passphrase,
      defaultEngineConfig('admin', req.auth!.user_id, enginePaths()),
    );
    res.status(202).json({ id, status: 'running' });
  } catch (err) {
    await cleanupUpload();
    if (err instanceof RestoreLockError) {
      res.status(409).json({ error: 'restore_in_progress', message: err.message });
      return;
    }
    throw err;
  }
});

adminBackupRouter.get('/restore/status', async (_req, res) => {
  const j = await readJournal(backupDir());
  if (!j) {
    res.json({ status: 'idle' });
    return;
  }
  // The archive master key appears ONLY in the success payload of the run
  // itself (result.keyFromArchive) — status polling gets the redacted view,
  // EXCEPT the succeeded terminal read where the operator needs the key
  // instruction exactly once. Mirror v1: include it on success.
  res.json(j.status === 'succeeded' ? j : redactJournal(j));
});

adminBackupRouter.post('/restore/rollback', async (req, res) => {
  const confirm = (req.body as { confirm?: string } | undefined)?.confirm;
  if (confirm !== 'rollback') {
    res.status(400).json({ error: 'bad_request', message: 'Confirm with confirm=rollback.' });
    return;
  }
  try {
    const j = await rollbackRestore(defaultEngineConfig('admin', req.auth!.user_id, enginePaths()));
    res.json({ ok: true, status: j.status });
  } catch (err) {
    if (err instanceof RestorePrerequisiteError) {
      res.status(409).json({ error: 'no_rollback', message: err.message });
      return;
    }
    throw err;
  }
});

adminBackupRouter.post('/restore/reset', async (req, res) => {
  const j = await readJournal(backupDir());
  if (j && j.status === 'running') {
    res.status(409).json({ error: 'restore_in_progress', message: 'The restore is running.' });
    return;
  }
  if (j) await rm(path.join(backupDir(), 'restore-journal.json'), { force: true }).catch(() => {});
  await audit({
    actor_user_id: req.auth!.user_id,
    action: 'admin.backup.restore_status_reset',
    metadata: { cleared: j?.id ?? null },
    ip: req.ip,
  });
  res.json({ ok: true });
});

adminBackupRouter.delete('/restore/previous', async (req, res) => {
  try {
    await dropPreviousGeneration(defaultEngineConfig('admin', req.auth!.user_id, enginePaths()));
  } catch (err) {
    if (err instanceof RestorePrerequisiteError) {
      res.status(404).json({ error: 'not_found', message: err.message });
      return;
    }
    throw err;
  }
  await audit({
    actor_user_id: req.auth!.user_id,
    action: 'admin.backup.drop_previous',
    metadata: {},
    ip: req.ip,
  });
  res.json({ ok: true });
});
