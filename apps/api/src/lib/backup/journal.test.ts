// DR v2 — journal durability, locking, and staleness classification.
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createJournal,
  readJournal,
  redactJournal,
  emptyPhases,
  RestoreLockError,
  JOURNAL_FILE,
  HEARTBEAT_STALE_MS,
  type RestoreJournal,
} from './journal.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'vibe-journal-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const INIT = {
  id: 'r-test-0001',
  entry: 'admin' as const,
  actorUserId: 'u1',
  source: { kind: 'upload' as const, name: 'b.vtbk', size: 123 },
  phase: 'inspect' as const,
  scratchDb: 'vibe_tax_restore_r_test_0001',
  dirs: [],
};

describe('journal lifecycle', () => {
  it('creates, persists atomically, and reads back', async () => {
    const h = await createJournal(dir, INIT);
    try {
      await h.update((j) => {
        j.phase = 'load';
        j.phases.load = { status: 'running', startedAt: 'now' };
      });
      const back = await readJournal(dir);
      expect(back?.phase).toBe('load');
      expect(back?.status).toBe('running');
      // On-disk JSON is the whole document, not a partial write.
      const raw = JSON.parse(await readFile(path.join(dir, JOURNAL_FILE), 'utf-8'));
      expect(raw.id).toBe('r-test-0001');
    } finally {
      h.close();
    }
  });

  it('refuses a second concurrent restore', async () => {
    const h = await createJournal(dir, INIT);
    try {
      await expect(createJournal(dir, { ...INIT, id: 'r-test-0002' })).rejects.toBeInstanceOf(
        RestoreLockError,
      );
    } finally {
      h.close();
    }
  });

  it('allows a new restore after the previous reached a terminal state', async () => {
    const h = await createJournal(dir, INIT);
    await h.update((j) => {
      j.status = 'failed';
      j.finishedAt = 'now';
    });
    h.close();
    const h2 = await createJournal(dir, { ...INIT, id: 'r-test-0003' });
    expect(h2.journal.id).toBe('r-test-0003');
    h2.close();
  });

  it('classifies a dead runner with a stale heartbeat as interrupted', async () => {
    const dead: RestoreJournal = {
      ...INIT,
      version: 1,
      pid: 999_999_1, // no such pid
      startedAt: new Date(0).toISOString(),
      heartbeatAt: new Date(0).toISOString(),
      status: 'running',
      phase: 'load',
      phases: emptyPhases(),
      rollbackAvailable: false,
    };
    await writeFile(path.join(dir, JOURNAL_FILE), JSON.stringify(dead));
    const back = await readJournal(dir, () => HEARTBEAT_STALE_MS + 60_000);
    expect(back?.status).toBe('interrupted');
    // And the lock from the dead run does not block a fresh restore.
    const h = await createJournal(dir, { ...INIT, id: 'r-after-crash' });
    expect(h.journal.id).toBe('r-after-crash');
    h.close();
  });

  it('a LIVE runner with a fresh heartbeat stays running', async () => {
    const alive: RestoreJournal = {
      ...INIT,
      version: 1,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      status: 'running',
      phase: 'load',
      phases: emptyPhases(),
      rollbackAvailable: false,
    };
    await writeFile(path.join(dir, JOURNAL_FILE), JSON.stringify(alive));
    const back = await readJournal(dir);
    expect(back?.status).toBe('running');
  });

  it('redacts the archive master key from status views', () => {
    const j: RestoreJournal = {
      ...INIT,
      version: 1,
      pid: 1,
      startedAt: 'x',
      heartbeatAt: 'x',
      status: 'succeeded',
      phase: 'finalize',
      phases: emptyPhases(),
      rollbackAvailable: true,
      result: { masterKeyMatches: false, keyFromArchive: 'SECRET', filesRestored: 3 },
    };
    const redacted = redactJournal(j);
    expect(JSON.stringify(redacted)).not.toContain('SECRET');
    expect(redacted.result?.masterKeyMatches).toBe(false);
  });
});
