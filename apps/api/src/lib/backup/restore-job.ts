// Background restore job — shared by Admin → Backup & restore and the
// first-run wizard.
//
// One implementation, two entry points. A restore is destructive and hard
// to get right; a second copy for the setup flow would drift from this one
// exactly where it matters least visibly.
import { mkdtemp, rm, stat, rename, mkdir, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { env } from '../../config/env.js';
import { logger } from '../logger.js';
import { audit } from '../audit.js';
import {
  readBackup,
  fingerprint,
  BackupFormatError,
  BackupPassphraseError,
  type BackupManifest,
} from './archive.js';
import { restoreDatabase, PgToolMissingError, RestorePrerequisiteError } from './postgres.js';

/** Data directories that travel with the database. */
export function dataDirs(): Record<string, string> {
  return {
    attachments: path.resolve(process.env.ATTACHMENTS_DIR ?? './attachments'),
    deliverables: path.resolve(process.env.DELIVERABLES_DIR ?? './storage/deliverables'),
    workspaces: path.resolve(process.env.WORKSPACES_DIR ?? './workspaces'),
  };
}

/**
 * A restore runs in the BACKGROUND, not inside the request.
 *
 * Restoring can take minutes, and a reverse proxy will not hold a request
 * open that long: Cloudflare cut one at 125s, after psql had executed the
 * dump's DROP statements and before the CREATEs, leaving the database
 * unusable and the operator locked out. Nothing about the work needs the
 * connection — the archive is already on disk by then — so the request
 * returns immediately and the UI polls for the outcome.
 *
 * One restore at a time, tracked in memory: a second concurrent restore
 * would fight the first over the same tables, and the state is only
 * meaningful for the life of the process anyway (a restart means the
 * restore died with it, which the UI surfaces as an unknown outcome).
 */
type RestoreState =
  | { status: 'idle' }
  | { status: 'running'; startedAt: string; step: string }
  | { status: 'succeeded'; finishedAt: string; result: unknown }
  | { status: 'failed'; finishedAt: string; error: string; code: string; harmless: boolean };

let restoreState: RestoreState = { status: 'idle' };

/**
 * A restore that dies without unwinding — the process is killed, psql is
 * OOM'd — leaves the in-memory state stuck on `running`, which disables
 * the button forever with no way back short of restarting the container.
 * Treat a run older than this as finished-with-unknown-outcome so the
 * operator is told what to check rather than simply blocked.
 */
const RESTORE_STALE_MS = 60 * 60 * 1000;

function currentRestoreState(): RestoreState {
  if (
    restoreState.status === 'running' &&
    Date.now() - Date.parse(restoreState.startedAt) > RESTORE_STALE_MS
  ) {
    restoreState = {
      status: 'failed',
      finishedAt: new Date().toISOString(),
      error:
        'The restore has been running for over an hour with no result. It was probably interrupted. Check the database before using the app, and check the server logs.',
      code: 'stale',
      harmless: false,
    };
  }
  return restoreState;
}

export function getRestoreState(): RestoreState {
  return currentRestoreState();
}

export function resetRestoreState(): RestoreState['status'] {
  const previous = restoreState.status;
  restoreState = { status: 'idle' };
  return previous;
}

export function beginRestore(): boolean {
  if (currentRestoreState().status === 'running') return false;
  restoreState = {
    status: 'running',
    startedAt: new Date().toISOString(),
    step: 'reading archive',
  };
  return true;
}

export async function runRestore(
  filePath: string,
  passphrase: string,
  /** Null during first-run setup: the accounts arrive with the archive, so
   *  there is no authenticated actor to attribute the restore to yet. */
  actorUserId: string | null,
  ip: string | undefined,
): Promise<void> {
  const cleanup = () => rm(filePath, { force: true }).catch(() => {});
  const file = { path: filePath };
  const req = { auth: { user_id: actorUserId }, ip } as {
    auth: { user_id: string | null };
    ip: string | undefined;
  };
  const step = (step: string) => {
    if (restoreState.status === 'running') restoreState = { ...restoreState, step };
    logger.info({ step }, 'restore progress');
  };

  const res = {
    // The response is long gone; record the outcome for /restore/status
    // instead of writing to a socket nobody is holding.
    status(code: number) {
      return {
        json(body: Record<string, unknown>) {
          restoreState = {
            status: 'failed',
            finishedAt: new Date().toISOString(),
            error: String(body.message ?? body.error ?? 'restore failed'),
            code: String(body.error ?? 'restore_failed'),
            // 409 is raised by the preflight, before anything destructive.
            harmless: code === 409,
          };
        },
      };
    },
    json(body: Record<string, unknown>) {
      restoreState = { status: 'succeeded', finishedAt: new Date().toISOString(), result: body };
    },
  };

  const dirs = dataDirs();
  // Restore into a staging directory first, then swap: a failure partway
  // through must not leave the live data directories half-overwritten.
  const staging = await mkdtemp(path.join(tmpdir(), 'vibe-restore-'));
  let manifest: BackupManifest | null = null;
  let archiveMasterKey: string | null = null;
  let files = 0;

  try {
    await readBackup(file.path, passphrase, {
      onManifest: (m) => {
        manifest = m;
        step(`archive opened (from ${m.appVersion}, ${new Date(m.createdAt).toLocaleString()})`);
      },
      onMasterKey: (k) => {
        archiveMasterKey = k;
      },
      onDatabase: (sql) => {
        step('loading database — this is the slow part');
        return restoreDatabase(sql);
      },
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

    step('database loaded; writing files');
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
    if (err instanceof RestorePrerequisiteError) {
      // Raised before anything destructive ran, so the operator can fix the
      // prerequisite and retry without having lost the current install.
      res.status(409).json({ error: 'restore_prerequisite', message: err.message });
      return;
    }
    logger.error({ err }, 'restore failed');
    res.status(500).json({ error: 'restore_failed', message: (err as Error).message });
  } finally {
    await cleanup();
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    if (restoreState.status === 'running') {
      restoreState = {
        status: 'failed',
        finishedAt: new Date().toISOString(),
        error: 'The restore ended without reporting a result.',
        code: 'unknown',
        harmless: false,
      };
    }
  }
}
