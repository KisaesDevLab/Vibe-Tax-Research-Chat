#!/usr/bin/env node
// DR v2 — offline backup/restore CLI. Same engine as the admin UI and the
// first-run wizard; exists for the cases where the app itself is the
// problem (container wedged, operator prefers a shell, automation).
//
//   vibe-backup list
//   vibe-backup inspect <file|name>
//   vibe-backup restore <file|name>     (BACKUP_PASSPHRASE from env)
//   vibe-backup rollback
//   vibe-backup recover
//
// Run inside the api container (or a one-off container on the same
// network/env):
//   docker compose exec api node apps/api/dist/lib/backup/cli.js list
//
// The passphrase comes from BACKUP_PASSPHRASE, never argv — argv leaks
// into `ps`, shell history, and container inspect output.
import path from 'node:path';
import { stat } from 'node:fs/promises';
import { backupDir, backupTmpDir, dataDirs } from '../../config/paths.js';
import { readManifestOnly } from './archive.js';
import { BackupFormatError, BackupPassphraseError, RestorePrerequisiteError } from './errors.js';
import { ARCHIVE_NAME_RE, listArchives } from './backup-job.js';
import { beginRestore, defaultEngineConfig, recoverRestore, rollbackRestore } from './engine.js';
import { readJournal } from './journal.js';

function enginePaths() {
  return { dataDirs: dataDirs(), backupDir: backupDir(), backupTmpDir: backupTmpDir() };
}

function usage(): never {
  console.error(
    'Usage: vibe-backup <list | inspect <file|name> | restore <file|name> | rollback | recover>\n' +
      '  restore/inspect read the passphrase from BACKUP_PASSPHRASE.',
  );
  process.exit(2);
}

function requirePassphrase(): string {
  const p = process.env.BACKUP_PASSPHRASE ?? '';
  if (!p) {
    console.error('BACKUP_PASSPHRASE is not set.');
    process.exit(2);
  }
  return p;
}

/** A bare archive name resolves inside BACKUP_DIR; a path is used as-is. */
async function resolveArchive(arg: string): Promise<string> {
  const candidate = ARCHIVE_NAME_RE.test(arg) ? path.join(backupDir(), arg) : path.resolve(arg);
  await stat(candidate).catch(() => {
    console.error(`No such file: ${candidate}`);
    process.exit(2);
  });
  return candidate;
}

async function cmdList(): Promise<number> {
  const archives = await listArchives(backupDir());
  if (!archives.length) {
    console.log(`No archives in ${backupDir()}.`);
    return 0;
  }
  for (const a of archives) {
    console.log(`${a.createdAt}  ${String(a.size).padStart(12)}  ${a.name}`);
  }
  return 0;
}

async function cmdInspect(arg: string): Promise<number> {
  const file = await resolveArchive(arg);
  const m = await readManifestOnly(file, requirePassphrase());
  console.log(JSON.stringify(m, null, 2));
  return 0;
}

async function cmdRestore(arg: string): Promise<number> {
  const file = await resolveArchive(arg);
  const passphrase = requirePassphrase();
  console.log(`Restoring ${file} …`);
  await beginRestore(
    { kind: 'archive', file, name: path.basename(file), deleteAfter: false },
    passphrase,
    defaultEngineConfig('cli', null, enginePaths()),
  );
  // Follow the journal until terminal, echoing phase transitions.
  let lastPhase = '';
  for (;;) {
    const j = await readJournal(backupDir());
    if (!j) break;
    if (j.phase !== lastPhase) {
      lastPhase = j.phase;
      console.log(`  phase: ${j.phase}`);
    }
    if (j.status !== 'running') {
      if (j.status === 'succeeded') {
        console.log('Restore complete. Restart the app container.');
        if (j.result && !j.result.masterKeyMatches) {
          console.log(
            'MASTER_KEY MISMATCH: set MASTER_KEY on this server to the value from the source ' +
              'server (printed below), then restart. Until then the stored Anthropic key and ' +
              'SMTP password cannot be decrypted.',
          );
          console.log(`MASTER_KEY from archive: ${j.result.keyFromArchive ?? '(unavailable)'}`);
        }
        return 0;
      }
      console.error(`Restore ${j.status}: [${j.error?.phase}] ${j.error?.message ?? ''}`);
      if (j.error?.stderrTail?.length) {
        console.error('--- pg_restore stderr tail ---');
        for (const line of j.error.stderrTail) console.error(line);
      }
      return 1;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  console.error('Restore journal vanished — check the server logs.');
  return 1;
}

async function cmdRollback(): Promise<number> {
  const j = await rollbackRestore(defaultEngineConfig('cli', null, enginePaths()));
  console.log(`Rolled back to the previous generation (restore ${j.id}). Restart the app.`);
  return 0;
}

async function cmdRecover(): Promise<number> {
  await recoverRestore(defaultEngineConfig('cli', null, enginePaths()));
  const j = await readJournal(backupDir());
  console.log(`Journal status: ${j?.status ?? 'none'}`);
  return 0;
}

async function main(): Promise<number> {
  const [cmd, arg] = process.argv.slice(2);
  try {
    switch (cmd) {
      case 'list':
        return await cmdList();
      case 'inspect':
        return arg ? await cmdInspect(arg) : usage();
      case 'restore':
        return arg ? await cmdRestore(arg) : usage();
      case 'rollback':
        return await cmdRollback();
      case 'recover':
        return await cmdRecover();
      default:
        usage();
    }
  } catch (err) {
    if (err instanceof BackupPassphraseError || err instanceof BackupFormatError) {
      console.error(`${err.message} Nothing was changed.`);
      return 1;
    }
    if (err instanceof RestorePrerequisiteError) {
      console.error(err.message);
      return 1;
    }
    console.error((err as Error).message);
    return 1;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
