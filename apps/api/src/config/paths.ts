// DR v2 — the ONE definition of every filesystem path the app persists data
// in. The backup captures exactly `dataDirs()`; anything writing user data
// outside these directories is not covered by disaster recovery, so new
// features must route their storage through here.
import path from 'node:path';
import { env } from './env.js';

export type DataDirKey = 'attachments' | 'deliverables' | 'workspaces';

/** Absolute paths of the directories that travel with the database. */
export function dataDirs(): Record<DataDirKey, string> {
  return {
    attachments: path.resolve(env.ATTACHMENTS_DIR),
    deliverables: path.resolve(env.DELIVERABLES_DIR),
    workspaces: path.resolve(env.WORKSPACES_DIR),
  };
}

/** Where finished backup archives live (volume-mounted in production). */
export function backupDir(): string {
  return path.resolve(env.BACKUP_DIR);
}

/** Spool space for dumps and restore uploads — same volume as backupDir by
 *  default so large files never land on container tmpfs. */
export function backupTmpDir(): string {
  return path.resolve(env.BACKUP_TMP_DIR);
}
