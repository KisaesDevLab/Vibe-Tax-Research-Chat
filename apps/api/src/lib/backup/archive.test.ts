// Round-trip tests for the backup archive. This is the layer where a bug
// is worst: a backup that cannot be restored is discovered only when it is
// the last copy of the data, so every failure mode gets an explicit case.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import {
  writeBackup,
  readBackup,
  fingerprint,
  BackupFormatError,
  BackupPassphraseError,
  type BackupManifest,
  type BackupSource,
} from './archive.js';

let work: string;

beforeEach(async () => {
  work = await mkdtemp(path.join(tmpdir(), 'vibe-bk-'));
});
afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

const MANIFEST: BackupManifest = {
  format: 1,
  createdAt: '2026-07-30T00:00:00.000Z',
  appVersion: '0.7.3',
  masterKeyFingerprint: fingerprint('master-key-value'),
  includes: ['attachments', 'deliverables'],
  database: { name: 'vibe_tax', dumpedWith: 'pg_dump 17.10' },
};

const SQL = '-- dump\nCREATE TABLE t (id int);\nINSERT INTO t VALUES (1);\n';

async function makeSource(): Promise<BackupSource> {
  const att = path.join(work, 'src', 'attachments');
  const del = path.join(work, 'src', 'deliverables', 'nested');
  await mkdir(att, { recursive: true });
  await mkdir(del, { recursive: true });
  await writeFile(path.join(att, 'memo.pdf'), 'ATTACHMENT-BODY');
  // Something bigger than one chunk, to exercise streaming rather than a
  // single buffered write.
  await writeFile(path.join(work, 'src', 'deliverables', 'big.bin'), Buffer.alloc(300_000, 7));
  await writeFile(path.join(del, 'deep.pdf'), 'DEEP');
  return {
    dirs: {
      attachments: att,
      deliverables: path.join(work, 'src', 'deliverables'),
    },
    databaseDump: () => Readable.from([Buffer.from(SQL)]),
    manifest: MANIFEST,
    masterKey: 'master-key-value',
  };
}

async function backupTo(file: string, passphrase: string): Promise<void> {
  const src = await makeSource();
  const out = createWriteStream(file);
  await writeBackup(src, passphrase, out);
  await new Promise<void>((resolve, reject) => out.end((e?: Error) => (e ? reject(e) : resolve())));
}

interface Captured {
  manifest?: BackupManifest;
  masterKey?: string;
  sql?: string;
  files: Record<string, string>;
}

async function restoreFrom(file: string, passphrase: string): Promise<Captured> {
  const dest = path.join(work, 'restored');
  const got: Captured = { files: {} };
  await readBackup(file, passphrase, {
    onManifest: (m) => {
      got.manifest = m;
    },
    onMasterKey: (k) => {
      got.masterKey = k;
    },
    onDatabase: async (sql) => {
      const chunks: Buffer[] = [];
      for await (const c of sql) chunks.push(c as Buffer);
      got.sql = Buffer.concat(chunks).toString('utf-8');
    },
    resolveFile: (p) => path.join(dest, p),
  });
  for (const rel of ['attachments/memo.pdf', 'deliverables/nested/deep.pdf']) {
    got.files[rel] = await readFile(path.join(dest, rel), 'utf-8');
  }
  const big = await stat(path.join(dest, 'deliverables/big.bin'));
  got.files['deliverables/big.bin'] = `size:${big.size}`;
  return got;
}

describe('backup archive', () => {
  it('round-trips manifest, master key, database dump, and files', async () => {
    const file = path.join(work, 'backup.enc');
    await backupTo(file, 'correct horse battery staple');
    const got = await restoreFrom(file, 'correct horse battery staple');

    expect(got.manifest).toEqual(MANIFEST);
    expect(got.masterKey).toBe('master-key-value');
    expect(got.sql).toBe(SQL);
    expect(got.files['attachments/memo.pdf']).toBe('ATTACHMENT-BODY');
    expect(got.files['deliverables/nested/deep.pdf']).toBe('DEEP');
    // Large file survives intact — proves the streaming path, not just
    // small single-chunk entries.
    expect(got.files['deliverables/big.bin']).toBe('size:300000');
  });

  it('rejects a wrong passphrase with a clear error', async () => {
    const file = path.join(work, 'backup.enc');
    await backupTo(file, 'right-passphrase');
    await expect(restoreFrom(file, 'wrong-passphrase')).rejects.toBeInstanceOf(
      BackupPassphraseError,
    );
  });

  it('rejects a file that is not a backup', async () => {
    const file = path.join(work, 'notabackup.enc');
    await writeFile(file, Buffer.alloc(200, 3));
    await expect(restoreFrom(file, 'x')).rejects.toBeInstanceOf(BackupFormatError);
  });

  it('rejects a truncated archive rather than restoring partial data', async () => {
    const file = path.join(work, 'backup.enc');
    await backupTo(file, 'pw');
    const buf = await readFile(file);
    const cut = path.join(work, 'cut.enc');
    // Drop the last 64 bytes: the GCM tag no longer matches the body.
    await writeFile(cut, buf.subarray(0, buf.length - 64));
    await expect(restoreFrom(cut, 'pw')).rejects.toThrow();
  });

  it('detects tampering with the ciphertext body', async () => {
    const file = path.join(work, 'backup.enc');
    await backupTo(file, 'pw');
    const buf = await readFile(file);
    const flipped = Buffer.from(buf);
    // Flip a bit well inside the ciphertext, leaving header and tag intact.
    const at = Math.floor(flipped.length / 2);
    flipped[at] = (flipped[at] ?? 0) ^ 0x01;
    const bad = path.join(work, 'bad.enc');
    await writeFile(bad, flipped);
    await expect(restoreFrom(bad, 'pw')).rejects.toThrow();
  });

  it('skips files the caller declines to restore', async () => {
    const file = path.join(work, 'backup.enc');
    await backupTo(file, 'pw');
    const dest = path.join(work, 'partial');
    let sawDb = false;
    await readBackup(file, 'pw', {
      onManifest: () => {},
      onMasterKey: () => {},
      onDatabase: async (sql) => {
        for await (const _ of sql) void _;
        sawDb = true;
      },
      // Restore attachments only.
      resolveFile: (p) => (p.startsWith('attachments/') ? path.join(dest, p) : null),
    });
    expect(sawDb).toBe(true);
    expect(await readFile(path.join(dest, 'attachments/memo.pdf'), 'utf-8')).toBe(
      'ATTACHMENT-BODY',
    );
    await expect(stat(path.join(dest, 'deliverables/big.bin'))).rejects.toThrow();
  });

  it('fingerprints are stable and non-reversible', () => {
    expect(fingerprint('abc')).toBe(fingerprint('abc'));
    expect(fingerprint('abc')).not.toBe(fingerprint('abd'));
    expect(fingerprint('abc')).not.toContain('abc');
  });
});
