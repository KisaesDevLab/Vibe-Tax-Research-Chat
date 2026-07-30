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
  restoreDatabase,
  databaseName,
  pgDumpVersion,
  PgToolMissingError,
} from '../../lib/backup/postgres.js';

export const adminBackupRouter = Router();
adminBackupRouter.use(requireAuth, requireRole('admin'));

const APP_VERSION = process.env.APP_VERSION ?? 'dev';

/** Data directories that travel with the database. */
function dataDirs(): Record<string, string> {
  return {
    attachments: path.resolve(process.env.ATTACHMENTS_DIR ?? './attachments'),
    deliverables: path.resolve(process.env.DELIVERABLES_DIR ?? './storage/deliverables'),
    workspaces: path.resolve(process.env.WORKSPACES_DIR ?? './workspaces'),
  };
}

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

  const dirs = dataDirs();
  // Restore into a staging directory first, then swap: a failure partway
  // through must not leave the live data directories half-overwritten.
  const staging = await mkdtemp(path.join(tmpdir(), 'vibe-restore-'));
  let manifest: BackupManifest | null = null;
  let archiveMasterKey: string | null = null;
  let files = 0;

  try {
    await readBackup(file.path, parsed.data.passphrase, {
      onManifest: (m) => {
        manifest = m;
      },
      onMasterKey: (k) => {
        archiveMasterKey = k;
      },
      onDatabase: (sql) => restoreDatabase(sql),
      resolveFile: (archivePath) => {
        const [top, ...rest] = archivePath.split('/');
        if (!top || !(top in dirs) || rest.length === 0) return null;
        // Contain the write: a crafted archive must not escape staging via
        // "../" segments.
        const rel = path.join(...rest);
        const dest = path.resolve(staging, top, rel);
        if (!dest.startsWith(path.resolve(staging, top) + path.sep)) return null;
        files += 1;
        return dest;
      },
    });

    // Database is in; now publish the files.
    const { rename, mkdir } = await import('node:fs/promises');
    for (const [key, live] of Object.entries(dirs)) {
      const staged = path.join(staging, key);
      if (!(await stat(staged).catch(() => null))) continue;
      await mkdir(path.dirname(live), { recursive: true }).catch(() => {});
      const old = `${live}.replaced-${Date.now()}`;
      if (await stat(live).catch(() => null)) await rename(live, old).catch(() => {});
      await rename(staged, live).catch(async () => {
        // Cross-device rename fails; fall back to a copy.
        const { cp } = await import('node:fs/promises');
        await cp(staged, live, { recursive: true });
      });
      await rm(old, { recursive: true, force: true }).catch(() => {});
    }

    const m = manifest as BackupManifest | null;
    const keyMatches = archiveMasterKey
      ? fingerprint(archiveMasterKey) === fingerprint(env.MASTER_KEY)
      : false;
    await audit({
      actor_user_id: req.auth!.user_id,
      action: 'admin.backup.restore',
      metadata: {
        from_app_version: m?.appVersion ?? null,
        created_at: m?.createdAt ?? null,
        files,
        master_key_matches: keyMatches,
      },
      ip: req.ip,
    });
    logger.warn({ files, keyMatches }, 'restore complete — restart required');

    res.json({
      ok: true,
      restored: {
        createdAt: m?.createdAt ?? null,
        appVersion: m?.appVersion ?? null,
        files,
        database: m?.database.name ?? null,
      },
      masterKey: {
        matches: keyMatches,
        // The whole point of shipping MASTER_KEY inside the archive is that
        // the encrypted settings survive the move; if the destination is
        // running a different key it must be corrected or those rows stay
        // unreadable.
        action: keyMatches
          ? null
          : 'Set MASTER_KEY on this server to the value from the source server, then restart. Until then the stored Anthropic key and SMTP password cannot be decrypted.',
        keyFromArchive: keyMatches ? null : archiveMasterKey,
      },
      restartRequired: true,
    });
  } catch (err) {
    if (err instanceof BackupPassphraseError) {
      res.status(400).json({ error: 'bad_passphrase', message: err.message });
      return;
    }
    if (err instanceof BackupFormatError) {
      res.status(400).json({ error: 'bad_archive', message: err.message });
      return;
    }
    if (err instanceof PgToolMissingError) {
      res.status(503).json({ error: 'pg_tools_missing', message: err.message });
      return;
    }
    logger.error({ err }, 'restore failed');
    res.status(500).json({ error: 'restore_failed', message: (err as Error).message });
  } finally {
    await cleanup();
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
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
