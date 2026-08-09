// DR v2 — durable restore journal.
//
// The v1 restore kept its state in process memory: an api restart lost it,
// the UI saw one coarse step string, and a hang gave the operator nothing
// to act on. The journal is a JSON file in BACKUP_DIR that records every
// phase transition, byte/TOC progress, the pg_restore stderr tail, and the
// individual swap steps — written atomically (tmp + rename) on every
// change, heartbeated while running, and consulted at boot for crash
// recovery. Its exclusive creation (wx) is ALSO the single-restore lock.
import { open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type PhaseName =
  | 'inspect'
  | 'prepare'
  | 'extract'
  | 'load'
  | 'verify'
  | 'files'
  | 'swap'
  | 'finalize';

export const PHASES: PhaseName[] = [
  'inspect',
  'prepare',
  'extract',
  'load',
  'verify',
  'files',
  'swap',
  'finalize',
];

export type SwapOp =
  | 'db_lock_live'
  | 'db_terminate'
  | 'db_rename_live_to_prev'
  | 'db_rename_scratch_to_live'
  | 'dir_rename_live_to_prev'
  | 'dir_rename_staging_to_live';

export interface SwapStep {
  op: SwapOp;
  /** dir key for dir_ ops. */
  target?: string;
  state: 'pending' | 'done';
  at?: string;
}

export interface RestoreJournal {
  version: 1;
  id: string;
  entry: 'admin' | 'setup' | 'cli';
  actorUserId: string | null;
  source: { kind: 'upload' | 'archive'; name: string; size: number };
  pid: number;
  startedAt: string;
  heartbeatAt: string;
  finishedAt?: string;
  status: 'running' | 'succeeded' | 'failed' | 'interrupted' | 'rolled_back';
  phase: PhaseName;
  phases: Record<
    PhaseName,
    {
      status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
      startedAt?: string;
      finishedAt?: string;
      note?: string;
    }
  >;
  archive?: {
    appVersion: string;
    createdAt: string;
    dumpedWith: string;
    masterKeyFingerprint: string;
    tables: number;
    dirFiles: number;
  };
  scratchDb: string;
  prevDb?: string;
  extract?: { bytesRead: number; bytesTotal: number; lastActivityAt: string };
  load?: {
    tocTotal: number;
    tocDone: number;
    stderrTail: string[];
    lastActivityAt: string;
    pgStatActivity?: unknown;
  };
  verify?: {
    tables: Array<{ name: string; expected: number; actual: number }>;
    adminCount: number;
  };
  swap?: { steps: SwapStep[] };
  dirs: Array<{ key: string; live: string; staging: string; prev: string }>;
  result?: {
    masterKeyMatches: boolean;
    keyFromArchive: string | null;
    filesRestored: number;
  };
  error?: { phase: PhaseName; code: string; message: string; stderrTail?: string[] };
  rollbackAvailable: boolean;
}

export const JOURNAL_FILE = 'restore-journal.json';
/** A running journal whose heartbeat is older than this, from a dead pid,
 *  is treated as interrupted. */
export const HEARTBEAT_STALE_MS = 60_000;
const HEARTBEAT_INTERVAL_MS = 5_000;

export class RestoreLockError extends Error {}

function journalPath(dir: string): string {
  return path.join(dir, JOURNAL_FILE);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function emptyPhases(): RestoreJournal['phases'] {
  return Object.fromEntries(
    PHASES.map((p) => [p, { status: 'pending' as const }]),
  ) as RestoreJournal['phases'];
}

export interface JournalHandle {
  journal: RestoreJournal;
  /** Persist the current journal state atomically. */
  write(): Promise<void>;
  /** Mutate + persist in one call. */
  update(fn: (j: RestoreJournal) => void): Promise<void>;
  /** Stop the heartbeat timer (always call in finally). */
  close(): void;
}

let tmpCounter = 0;

async function writeAtomic(dir: string, journal: RestoreJournal): Promise<void> {
  // Unique tmp name: concurrent writers must never rename each other's
  // half-written file out from under themselves.
  const tmp = `${journalPath(dir)}.${process.pid}.${tmpCounter++}.tmp`;
  const body = JSON.stringify(journal, null, 2);
  await writeFile(tmp, body, 'utf-8');
  // Windows: rename-over-existing throws EPERM while a reader (status
  // endpoint, poll loop) briefly holds the destination open. Retry, then
  // fall back to a direct write — a rare torn read of the status file
  // beats failing the restore itself.
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(tmp, journalPath(dir));
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if ((code === 'EPERM' || code === 'EACCES' || code === 'EBUSY') && attempt < 5) {
        await new Promise((r) => setTimeout(r, 25 * (attempt + 1)));
        continue;
      }
      if (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY') {
        await writeFile(journalPath(dir), body, 'utf-8');
        await rm(tmp, { force: true }).catch(() => {});
        return;
      }
      throw err;
    }
  }
}

/** Serialize all writes through one handle: progress callbacks fire
 *  unawaited while phase transitions await, and interleaved tmp+rename
 *  pairs corrupt each other without a queue. */
function makeWriter(dir: string, journal: RestoreJournal): () => Promise<void> {
  let chain: Promise<void> = Promise.resolve();
  return () => {
    const next = chain.then(() => writeAtomic(dir, journal));
    chain = next.catch(() => {});
    return next;
  };
}

/**
 * Create a fresh journal — exclusive create is the single-restore lock.
 * Refuses while an existing journal is genuinely running (fresh heartbeat
 * or live pid); a stale runner is surfaced as interrupted and replaced.
 */
export async function createJournal(
  dir: string,
  init: Omit<
    RestoreJournal,
    'version' | 'pid' | 'startedAt' | 'heartbeatAt' | 'status' | 'phases' | 'rollbackAvailable'
  >,
  now: () => number = Date.now,
): Promise<JournalHandle> {
  const existing = await readJournal(dir, now);
  if (existing && existing.status === 'running') {
    throw new RestoreLockError('A restore is already running.');
  }

  const journal: RestoreJournal = {
    version: 1,
    pid: process.pid,
    startedAt: new Date(now()).toISOString(),
    heartbeatAt: new Date(now()).toISOString(),
    status: 'running',
    phases: emptyPhases(),
    rollbackAvailable: false,
    ...init,
  };

  // wx create of a lock sentinel; the journal itself is rewritten via
  // tmp+rename which cannot be exclusive. The sentinel is removed when the
  // run reaches a terminal state.
  const lock = journalPath(dir) + '.lock';
  try {
    const fh = await open(lock, 'wx');
    await fh.writeFile(String(process.pid));
    await fh.close();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      // A lock without a running journal is a leftover from a crash the
      // reader below already classified as not-running — reclaim it.
      const holder = Number(await readFile(lock, 'utf-8').catch(() => '0'));
      if (holder && holder !== process.pid && pidAlive(holder)) {
        throw new RestoreLockError('A restore is already running (lock held by a live process).');
      }
      await rm(lock, { force: true });
      const fh = await open(lock, 'wx');
      await fh.writeFile(String(process.pid));
      await fh.close();
    } else {
      throw err;
    }
  }

  const write = makeWriter(dir, journal);
  await write();

  const timer = setInterval(() => {
    journal.heartbeatAt = new Date(now()).toISOString();
    void write().catch(() => {});
  }, HEARTBEAT_INTERVAL_MS);
  timer.unref?.();

  const handle: JournalHandle = {
    journal,
    write,
    update: async (fn) => {
      fn(journal);
      await write();
    },
    close: () => {
      clearInterval(timer);
      void rm(lock, { force: true }).catch(() => {});
    },
  };
  return handle;
}

/** Reopen a journal for crash recovery: heartbeat resumes, lock reclaimed. */
export async function reopenJournal(
  dir: string,
  journal: RestoreJournal,
  now: () => number = Date.now,
): Promise<JournalHandle> {
  journal.pid = process.pid;
  journal.heartbeatAt = new Date(now()).toISOString();
  const write = makeWriter(dir, journal);
  await write();
  const lock = journalPath(dir) + '.lock';
  await rm(lock, { force: true }).catch(() => {});
  await writeFile(lock, String(process.pid), 'utf-8');
  const timer = setInterval(() => {
    journal.heartbeatAt = new Date(now()).toISOString();
    void write().catch(() => {});
  }, HEARTBEAT_INTERVAL_MS);
  timer.unref?.();
  return {
    journal,
    write,
    update: async (fn) => {
      fn(journal);
      await write();
    },
    close: () => {
      clearInterval(timer);
      void rm(lock, { force: true }).catch(() => {});
    },
  };
}

/**
 * Read the journal, classifying a dead runner: status 'running' with a
 * stale heartbeat AND a dead (or foreign-dead) pid comes back as
 * 'interrupted' so status endpoints and recovery see the truth, not the
 * last thing the dead process managed to write.
 */
export async function readJournal(
  dir: string,
  now: () => number = Date.now,
): Promise<RestoreJournal | null> {
  let text: string;
  try {
    text = await readFile(journalPath(dir), 'utf-8');
  } catch {
    return null;
  }
  let journal: RestoreJournal;
  try {
    journal = JSON.parse(text) as RestoreJournal;
  } catch {
    return null;
  }
  if (journal.status === 'running') {
    const stale = now() - Date.parse(journal.heartbeatAt) > HEARTBEAT_STALE_MS;
    const dead = journal.pid !== process.pid && !pidAlive(journal.pid);
    if (stale && dead) {
      return { ...journal, status: 'interrupted' };
    }
    if (stale && journal.pid === process.pid) {
      // Our own pid but no heartbeat — a previous incarnation of this
      // container (pids restart from low numbers in docker). Interrupted.
      return { ...journal, status: 'interrupted' };
    }
  }
  return journal;
}

/** Public, redacted view for status endpoints — never leaks the archive's
 *  master key (which only ever lives in result payloads by explicit
 *  decision at the route layer). */
export function redactJournal(j: RestoreJournal): Omit<RestoreJournal, 'result'> & {
  result?: Omit<NonNullable<RestoreJournal['result']>, 'keyFromArchive'> & {
    keyFromArchive: null;
  };
} {
  if (!j.result) return j as never;
  return {
    ...j,
    result: { ...j.result, keyFromArchive: null },
  };
}
