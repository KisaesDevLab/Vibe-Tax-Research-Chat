// Admin backup / restore — moving an entire install to another server
// without a shell.
//
// The archive is a single passphrase-encrypted file containing the
// database, the uploaded files, the rendered deliverables, the skills
// workspace, and MASTER_KEY. It is therefore the most sensitive artifact
// this app can produce: admin-only, audited on both create and restore,
// and useless to anyone without the passphrase.
import { Router } from 'express';
import { z } from 'zod';
import multer from 'multer';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { audit } from '../../lib/audit.js';
import {
  writeBackup,
  readBackup,
  fingerprint,
  BackupFormatError,
  BackupPassphraseError,
  type BackupManifest,
} from '../../lib/backup/archive.js';
import {
  dumpDatabase,
  databaseName,
  pgDumpVersion,
  PgToolMissingError,
} from '../../lib/backup/postgres.js';
import {
  dataDirs,
  getRestoreState,
  resetRestoreState,
  beginRestore,
  runRestore,
} from '../../lib/backup/restore-job.js';

export const adminBackupRouter = Router();
adminBackupRouter.use(requireAuth, requireRole('admin'));

const APP_VERSION = process.env.APP_VERSION ?? 'dev';

// A passphrase short enough to brute-force defeats the point of encrypting
// an archive that carries every credential in the install.
const MIN_PASSPHRASE = 12;
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

  let dumpedWith: string;
  try {
    dumpedWith = await pgDumpVersion();
  } catch (err) {
    if (err instanceof PgToolMissingError) {
      res.status(503).json({ error: 'pg_tools_missing', message: err.message });
      return;
    }
    throw err;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `vibe-tax-backup-${stamp}.vtbk`;
  const manifest: BackupManifest = {
    format: 1,
    createdAt: new Date().toISOString(),
    appVersion: APP_VERSION,
    masterKeyFingerprint: fingerprint(env.MASTER_KEY),
    includes: Object.keys(dataDirs()),
    database: { name: databaseName(), dumpedWith },
  };

  res.setHeader('content-type', 'application/octet-stream');
  res.setHeader('content-disposition', `attachment; filename="${filename}"`);
  // Length is unknowable up front (the archive is built as it streams), so
  // the response is chunked. Buffering it to learn the size would defeat
  // the point on a multi-gigabyte install.
  res.setHeader('cache-control', 'no-store');

  try {
    await writeBackup(
      {
        dirs: dataDirs(),
        databaseDump: dumpDatabase,
        manifest,
        masterKey: env.MASTER_KEY,
      },
      parsed.data.passphrase,
      res,
    );
    res.end();
    await audit({
      actor_user_id: req.auth!.user_id,
      action: 'admin.backup.create',
      metadata: { filename, includes: manifest.includes, app_version: APP_VERSION },
      ip: req.ip,
    });
    logger.info({ filename }, 'backup archive streamed');
  } catch (err) {
    logger.error({ err }, 'backup failed');
    // Headers are already sent, so the only honest signal left is to break
    // the connection — a truncated download must not look like a good
    // backup. The client checks for the trailing tag on restore anyway.
    res.destroy(err as Error);
  }
});

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, tmpdir()),
    filename: (_req, _file, cb) => cb(null, `vibe-restore-${Date.now()}.vtbk`),
  }),
  // Disk-backed, so the ceiling is disk rather than RAM. 20 GB is well past
  // any realistic single-firm install.
  limits: { fileSize: 20 * 1024 * 1024 * 1024 },
});

const restoreSchema = z.object({
  passphrase: z.string().min(1),
  /** Restoring overwrites everything; make the caller say so explicitly. */
  confirm: z.literal('replace-all-data'),
});

adminBackupRouter.get('/restore/status', (_req, res) => {
  res.json(getRestoreState());
});

/**
 * Clear a stuck status. Deliberately does NOT stop work already in flight
 * — there is no safe way to interrupt a running psql — so it only resets
 * the bookkeeping the UI reads.
 */
adminBackupRouter.post('/restore/reset', async (req, res) => {
  const previous = resetRestoreState();
  await audit({
    actor_user_id: req.auth!.user_id,
    action: 'admin.backup.restore_status_reset',
    metadata: { previous },
    ip: req.ip,
  });
  res.json({ ok: true, previous });
});

adminBackupRouter.post('/restore', upload.single('file'), async (req, res) => {
  const parsed = restoreSchema.safeParse(req.body ?? {});
  const file = req.file;
  if (!file) {
    res.status(400).json({ error: 'bad_request', message: 'No backup file was uploaded.' });
    return;
  }
  const cleanup = () => rm(file.path, { force: true }).catch(() => {});
  if (!parsed.success) {
    await cleanup();
    res.status(400).json({
      error: 'bad_request',
      message: 'A passphrase and confirm="replace-all-data" are required.',
    });
    return;
  }
  if (!beginRestore()) {
    await cleanup();
    res.status(409).json({
      error: 'restore_in_progress',
      message: 'A restore is already running. Wait for it to finish.',
    });
    return;
  }

  // Hand back control immediately; the work continues without the request.
  const actorUserId = req.auth!.user_id;
  const ip = req.ip;
  res.status(202).json({ status: 'running' });
  void runRestore(file.path, parsed.data.passphrase, actorUserId, ip);
});

/** What the UI needs to render the page without attempting a backup. */
adminBackupRouter.get('/status', async (_req, res) => {
  let pgTools: string | null = null;
  let toolError: string | null = null;
  try {
    pgTools = await pgDumpVersion();
  } catch (err) {
    toolError = (err as Error).message;
  }
  const dirs = dataDirs();
  const present: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(dirs)) {
    present[k] = Boolean(await stat(v).catch(() => null));
  }
  res.json({
    appVersion: APP_VERSION,
    database: databaseName(),
    pgTools,
    toolError,
    includes: present,
    masterKeyFingerprint: fingerprint(env.MASTER_KEY),
    minPassphrase: MIN_PASSPHRASE,
  });
});
