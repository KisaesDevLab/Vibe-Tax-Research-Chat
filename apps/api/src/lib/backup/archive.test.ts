// Round-trip tests for the backup archive (format 2). This is the layer
// where a bug is worst: a backup that cannot be restored is discovered only
// when it is the last copy of the data, so every failure mode gets an
// explicit case.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  writeBackup,
  readBackup,
  readManifestOnly,
  fingerprint,
  BackupFormatError,
  BackupPassphraseError,
  MAGIC,
  HEADER_LEN,
  type BackupSource,
} from './archive.js';
import { parseManifest, type ManifestV2 } from './manifest.js';

let work: string;

beforeEach(async () => {
  work = await mkdtemp(path.join(tmpdir(), 'vibe-bk-'));
});
afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

const MANIFEST: ManifestV2 = {
  format: 2,
  createdAt: '2026-08-09T00:00:00.000Z',
  appVersion: 'v0.10.0',
  masterKeyFingerprint: fingerprint('master-key-value'),
  database: {
    name: 'vibe_tax',
    serverVersion: '16.11',
    dumpedWith: 'pg_dump (PostgreSQL) 16.11',
    migrationsApplied: 12,
  },
  tables: { users: 3, chats: 41 },
  dirs: {
    attachments: { files: 1, bytes: 15 },
    deliverables: { files: 2, bytes: 300_004 },
  },
};

const DUMP = Buffer.from('PGDMP-fake-custom-format-bytes\x00\x01\x02\x03');

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
  const dumpPath = path.join(work, 'src', 'db.dump');
  await writeFile(dumpPath, DUMP);
  return {
    dirs: {
      attachments: att,
      deliverables: path.join(work, 'src', 'deliverables'),
    },
    databaseDumpFile: { path: dumpPath, size: DUMP.length },
    manifest: MANIFEST,
    masterKey: 'master-key-value',
  };
}

async function backupTo(
  file: string,
  passphrase: string,
  onProgress?: (bytes: number, entry: string) => void,
): Promise<void> {
  const src = await makeSource();
  const out = createWriteStream(file);
  await writeBackup(src, passphrase, out, onProgress);
  await new Promise<void>((resolve, reject) => out.end((e?: Error) => (e ? reject(e) : resolve())));
}

interface Captured {
  manifest?: ManifestV2;
  masterKey?: string;
  dump?: Buffer;
  files: Record<string, string>;
  progress: Array<[number, number]>;
}

async function restoreFrom(file: string, passphrase: string): Promise<Captured> {
  const dest = path.join(work, 'restored');
  const got: Captured = { files: {}, progress: [] };
  await readBackup(file, passphrase, {
    onManifest: (m) => {
      got.manifest = m;
    },
    onMasterKey: (k) => {
      got.masterKey = k;
    },
    onDatabase: async (dump) => {
      const chunks: Buffer[] = [];
      for await (const c of dump) chunks.push(c as Buffer);
      got.dump = Buffer.concat(chunks);
    },
    resolveFile: (p) => path.join(dest, p),
    onProgress: (read, total) => {
      got.progress.push([read, total]);
    },
  });
  for (const rel of ['attachments/memo.pdf', 'deliverables/nested/deep.pdf']) {
    got.files[rel] = await readFile(path.join(dest, rel), 'utf-8');
  }
  const big = await stat(path.join(dest, 'deliverables/big.bin'));
  got.files['deliverables/big.bin'] = `size:${big.size}`;
  return got;
}

describe('backup archive v2', () => {
  it('round-trips manifest, master key, custom-format dump, and files', async () => {
    const file = path.join(work, 'backup.vtbk');
    const writes: string[] = [];
    await backupTo(file, 'correct horse battery staple', (_b, entry) => writes.push(entry));
    const got = await restoreFrom(file, 'correct horse battery staple');

    expect(got.manifest).toEqual(MANIFEST);
    expect(got.masterKey).toBe('master-key-value');
    expect(got.dump).toEqual(DUMP);
    expect(got.files['attachments/memo.pdf']).toBe('ATTACHMENT-BODY');
    expect(got.files['deliverables/nested/deep.pdf']).toBe('DEEP');
    // Large file survives intact — proves the streaming path, not just
    // small single-chunk entries.
    expect(got.files['deliverables/big.bin']).toBe('size:300000');
    // Progress hooks fired on both sides, with a sane total.
    expect(writes).toContain('database.dump');
    expect(got.progress.length).toBeGreaterThan(0);
    const [read, total] = got.progress[got.progress.length - 1]!;
    expect(read).toBe(total);
  });

  it('readManifestOnly returns the manifest without touching anything else', async () => {
    const file = path.join(work, 'backup.vtbk');
    await backupTo(file, 'pw-for-inspect');
    const manifest = await readManifestOnly(file, 'pw-for-inspect');
    expect(manifest).toEqual(MANIFEST);
    await expect(readManifestOnly(file, 'wrong')).rejects.toBeInstanceOf(BackupPassphraseError);
  });

  it('rejects a format-1 archive with the older-release message', async () => {
    const file = path.join(work, 'v1.vtbk');
    // Synthesize a v1 header: magic | ver=1 | salt+iv junk | some body.
    const header = Buffer.concat([MAGIC, Buffer.from([1]), Buffer.alloc(28, 9)]);
    await writeFile(file, Buffer.concat([header, Buffer.alloc(256, 5)]));
    await expect(restoreFrom(file, 'x')).rejects.toThrow(/older release/);
    await expect(readManifestOnly(file, 'x')).rejects.toThrow(/older release/);
  });

  it('rejects an unknown future version', async () => {
    const file = path.join(work, 'v9.vtbk');
    const header = Buffer.concat([MAGIC, Buffer.from([9]), Buffer.alloc(28, 9)]);
    await writeFile(file, Buffer.concat([header, Buffer.alloc(256, 5)]));
    await expect(restoreFrom(file, 'x')).rejects.toThrow(/unsupported backup format version 9/);
  });

  it('rejects a wrong passphrase with a clear error', async () => {
    const file = path.join(work, 'backup.vtbk');
    await backupTo(file, 'right-passphrase');
    await expect(restoreFrom(file, 'wrong-passphrase')).rejects.toBeInstanceOf(
      BackupPassphraseError,
    );
  });

  it('rejects a file that is not a backup', async () => {
    const file = path.join(work, 'notabackup.vtbk');
    await writeFile(file, Buffer.alloc(200, 3));
    await expect(restoreFrom(file, 'x')).rejects.toBeInstanceOf(BackupFormatError);
  });

  it('rejects a truncated archive rather than restoring partial data', async () => {
    const file = path.join(work, 'backup.vtbk');
    await backupTo(file, 'pw');
    const buf = await readFile(file);
    const cut = path.join(work, 'cut.vtbk');
    // Drop the last 64 bytes: the GCM tag no longer matches the body.
    await writeFile(cut, buf.subarray(0, buf.length - 64));
    await expect(restoreFrom(cut, 'pw')).rejects.toThrow();
  });

  it('detects tampering with the ciphertext body', async () => {
    const file = path.join(work, 'backup.vtbk');
    await backupTo(file, 'pw');
    const buf = await readFile(file);
    const flipped = Buffer.from(buf);
    // Flip a bit well inside the ciphertext, leaving header and tag intact.
    const at = Math.max(HEADER_LEN + 8, Math.floor(flipped.length / 2));
    flipped[at] = (flipped[at] ?? 0) ^ 0x01;
    const bad = path.join(work, 'bad.vtbk');
    await writeFile(bad, flipped);
    await expect(restoreFrom(bad, 'pw')).rejects.toThrow();
  });

  it('skips files the caller declines to restore', async () => {
    const file = path.join(work, 'backup.vtbk');
    await backupTo(file, 'pw');
    const dest = path.join(work, 'partial');
    let sawDb = false;
    await readBackup(file, 'pw', {
      onManifest: () => {},
      onMasterKey: () => {},
      onDatabase: async (dump) => {
        for await (const _ of dump) void _;
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

describe('manifest schema', () => {
  it('accepts a valid v2 manifest and rejects structural junk', () => {
    expect(parseManifest(JSON.stringify(MANIFEST))).toEqual(MANIFEST);
    expect(() => parseManifest('not json')).toThrow(BackupFormatError);
    expect(() => parseManifest(JSON.stringify({ format: 1 }))).toThrow(BackupFormatError);
    expect(() => parseManifest(JSON.stringify({ ...MANIFEST, tables: { users: -1 } }))).toThrow(
      /tables/,
    );
  });
});
