#!/usr/bin/env node
// Offline restore — the reliable way to move an install.
//
//   node apps/api/dist/lib/backup/cli.js /path/to/backup.vtbk
//
// Passphrase comes from BACKUP_PASSPHRASE (avoids it landing in shell
// history or `ps` output).
//
// Every restore failure this feature has had came from restoring while the
// API was serving traffic: a reverse proxy killing the request mid-DROP,
// the app's own pool holding locks on the tables being dropped, health
// checks reconnecting the instant they were evicted. Run this with the API
// container stopped and none of those exist — no HTTP, no timeout, no
// competing connections, and the exit code is the real outcome.
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm, rename, stat, mkdir, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readBackup, fingerprint, BackupPassphraseError, BackupFormatError } from './archive.js';
import { restoreDatabase, RestorePrerequisiteError } from './postgres.js';
import type { BackupManifest } from './archive.js';

function dataDirs(): Record<string, string> {
  return {
    attachments: path.resolve(process.env.ATTACHMENTS_DIR ?? './attachments'),
    deliverables: path.resolve(process.env.DELIVERABLES_DIR ?? './storage/deliverables'),
    workspaces: path.resolve(process.env.WORKSPACES_DIR ?? './workspaces'),
  };
}

async function main(): Promise<void> {
  const file = process.argv[2];
  const passphrase = process.env.BACKUP_PASSPHRASE;
  if (!file || !passphrase) {
    console.error('Usage: BACKUP_PASSPHRASE=… node apps/api/dist/lib/backup/cli.js <backup.vtbk>');
    process.exit(2);
  }
  if (!(await stat(file).catch(() => null))) {
    console.error(`No such file: ${file}`);
    process.exit(2);
  }

  const dirs = dataDirs();
  const staging = await mkdtemp(path.join(tmpdir(), 'vibe-restore-cli-'));
  let manifest: BackupManifest | null = null;
  let archiveKey: string | null = null;
  let files = 0;

  try {
    console.log('Reading archive…');
    await readBackup(file, passphrase, {
      onManifest: (m) => {
        manifest = m;
        console.log(
          `Archive from ${m.appVersion}, created ${new Date(m.createdAt).toLocaleString()}`,
        );
      },
      onMasterKey: (k) => {
        archiveKey = k;
      },
      onDatabase: async (sql) => {
        console.log('Loading database (this is the slow part)…');
        await restoreDatabase(sql);
        console.log('Database loaded.');
      },
      resolveFile: (archivePath) => {
        const [top, ...rest] = archivePath.split('/');
        if (!top || !(top in dirs) || rest.length === 0) return null;
        const dest = path.resolve(staging, top, path.join(...rest));
        if (!dest.startsWith(path.resolve(staging, top) + path.sep)) return null;
        files += 1;
        return dest;
      },
    });

    console.log(`Publishing ${files} file(s)…`);
    for (const [key, live] of Object.entries(dirs)) {
      const staged = path.join(staging, key);
      if (!(await stat(staged).catch(() => null))) continue;
      await mkdir(path.dirname(live), { recursive: true }).catch(() => {});
      const old = `${live}.replaced-${Date.now()}`;
      if (await stat(live).catch(() => null)) await rename(live, old).catch(() => {});
      await rename(staged, live).catch(async () => {
        await cp(staged, live, { recursive: true });
      });
      await rm(old, { recursive: true, force: true }).catch(() => {});
    }

    const m = manifest as BackupManifest | null;
    console.log('\nRestore complete.');
    console.log(`  from app version : ${m?.appVersion ?? 'unknown'}`);
    console.log(`  files restored   : ${files}`);

    const envKey = process.env.MASTER_KEY ?? '';
    if (archiveKey && envKey && fingerprint(archiveKey) !== fingerprint(envKey)) {
      console.log("\nWARNING: this server's MASTER_KEY differs from the archive's.");
      console.log('Encrypted settings (Anthropic key, SMTP password) will not decrypt until');
      console.log('MASTER_KEY is set to the value below and the API restarted:\n');
      console.log(`  MASTER_KEY=${archiveKey}\n`);
    }
    console.log('Start the API container again, then log in with the credentials from the');
    console.log("SOURCE server — the restore replaced this install's user accounts.");
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    if (err instanceof BackupPassphraseError || err instanceof BackupFormatError) {
      console.error(`\nRestore aborted: ${err.message}`);
      console.error('Nothing was changed.');
      process.exit(1);
    }
    if (err instanceof RestorePrerequisiteError) {
      console.error(`\nRestore aborted: ${err.message}`);
      process.exit(1);
    }
    console.error('\nRestore failed:', (err as Error).message);
    console.error('The database may be incomplete — do not start the app until it is resolved.');
    process.exit(1);
  });
