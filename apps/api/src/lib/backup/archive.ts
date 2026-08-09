// DR v2 — portable, passphrase-encrypted backup archive (format 2).
//
// Envelope (the plaintext header is readable so restore can derive the key
// before it has to trust anything):
//
//   "VIBETAXBK" | ver(1)=2 | salt(16) | iv(12) | AES-256-GCM(gzip(tar)) | tag(16)
//
// The tar carries manifest.json (FIRST entry — readManifestOnly relies on
// it), master.key, database.dump (pg_dump custom format, pre-built by the
// backup job), then the data directories. MASTER_KEY travels INSIDE the
// encrypted payload: without it the encrypted settings rows (Anthropic key,
// SMTP password) are so much noise on the destination box.
//
// Format 1 (plain-SQL dump, restored straight into the live database) is
// deliberately NOT readable by this build — the restore architecture it
// implied is what this rewrite retires.
//
// Everything streams. Archives include client uploads and rendered PDFs and
// can run to gigabytes; nothing here may buffer a whole file.
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scrypt as scryptCb,
} from 'node:crypto';
import { createGzip, createGunzip } from 'node:zlib';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, type Writable } from 'node:stream';
import * as tar from 'tar-stream';
import { BackupFormatError, BackupPassphraseError } from './errors.js';
import { parseManifest, type ManifestV2 } from './manifest.js';

export const MAGIC = Buffer.from('VIBETAXBK');
export const FORMAT_VERSION = 2;
export const DATABASE_ENTRY = 'database.dump';
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
/** scrypt cost. N=2^15 keeps derivation ~100ms — enough to make a weak
 *  passphrase expensive to grind, cheap enough not to stall a restore. */
const SCRYPT_N = 32768;

export const HEADER_LEN = MAGIC.length + 1 + SALT_LEN + IV_LEN;

async function deriveKey(passphrase: string, salt: Buffer): Promise<Buffer> {
  // maxmem must be raised for N=2^15; the default 32MB cap rejects it.
  return (await new Promise((resolve, reject) => {
    scryptCb(
      passphrase,
      salt,
      KEY_LEN,
      { N: SCRYPT_N, r: 8, p: 1, maxmem: 96 * 1024 * 1024 },
      (e, k) => (e ? reject(e) : resolve(k)),
    );
  })) as Buffer;
}

export interface BackupSource {
  /** Directories copied verbatim: archive prefix -> absolute path. */
  dirs: Record<string, string>;
  /** Pre-built pg_dump custom-format file, streamed in as database.dump. */
  databaseDumpFile: { path: string; size: number };
  manifest: ManifestV2;
  masterKey: string;
}

/** Recursively yield files under `root` as archive-relative paths. */
async function* walk(root: string, prefix: string): AsyncGenerator<{ abs: string; rel: string }> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return; // Directory absent on this install — nothing to archive.
  }
  for (const e of entries) {
    // Restore generations (.dr-staging/.dr-prev/.dr-undone) live inside the
    // data dirs — they must never leak into a new archive.
    if (e.name.startsWith('.dr-')) continue;
    const abs = path.join(root, e.name);
    const rel = `${prefix}/${e.name}`;
    if (e.isDirectory()) {
      yield* walk(abs, rel);
    } else if (e.isFile()) {
      yield { abs, rel };
    }
    // Sockets/symlinks are deliberately skipped: nothing the app writes
    // needs them, and following links out of the data dir is a footgun.
  }
}

/**
 * Write an encrypted backup to `out`. Resolves once the archive is fully
 * flushed; rejects if any stage fails (the caller must treat a rejection
 * as a failed backup even though bytes may already have been written).
 */
export async function writeBackup(
  source: BackupSource,
  passphrase: string,
  out: Writable,
  onProgress?: (bytesWritten: number, currentEntry: string) => void,
): Promise<void> {
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = await deriveKey(passphrase, salt);

  // Plaintext header first — restore needs salt+iv before it can decrypt.
  out.write(Buffer.concat([MAGIC, Buffer.from([FORMAT_VERSION]), salt, iv]));

  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const pack = tar.pack();
  const gzip = createGzip({ level: 6 });

  let bytesWritten = 0;
  let currentEntry = 'manifest.json';
  cipher.on('data', (c: Buffer) => {
    bytesWritten += c.length;
    onProgress?.(bytesWritten, currentEntry);
  });

  // The GCM tag is only known once the cipher finishes, so it is appended
  // after the ciphertext — which means `out` must stay open past the end of
  // the pipeline. Piping with { end: false } keeps it open AND preserves
  // backpressure; the tag write below simply queues behind the body.
  cipher.pipe(out, { end: false });
  const done = pipeline(pack, gzip, cipher);

  const entry = (name: string, size: number, body: Readable) => {
    currentEntry = name;
    return new Promise<void>((resolve, reject) => {
      const e = pack.entry({ name, size }, (err) => (err ? reject(err) : resolve()));
      body.pipe(e);
      body.on('error', reject);
    });
  };

  const manifestJson = Buffer.from(JSON.stringify(source.manifest, null, 2));
  await entry('manifest.json', manifestJson.length, Readable.from([manifestJson]));

  const keyBuf = Buffer.from(source.masterKey, 'utf-8');
  await entry('master.key', keyBuf.length, Readable.from([keyBuf]));

  await entry(
    DATABASE_ENTRY,
    source.databaseDumpFile.size,
    createReadStream(source.databaseDumpFile.path),
  );

  for (const [prefix, dir] of Object.entries(source.dirs)) {
    for await (const f of walk(dir, prefix)) {
      const st = await stat(f.abs).catch(() => null);
      if (!st) continue; // Vanished mid-walk; skip rather than abort.
      await entry(f.rel, st.size, createReadStream(f.abs));
    }
  }

  pack.finalize();
  await done;
  out.write(cipher.getAuthTag());
}

export interface RestoreHandlers {
  onManifest: (m: ManifestV2) => void | Promise<void>;
  onMasterKey: (key: string) => void | Promise<void>;
  /** Called with the database.dump stream; must consume it fully. */
  onDatabase: (dump: Readable) => Promise<void>;
  /** Absolute destination for an archive path, or null to skip it. */
  resolveFile: (archivePath: string) => string | null;
  /** Decrypt progress over the encrypted body. */
  onProgress?: (bytesRead: number, bytesTotal: number) => void;
}

interface OpenedArchive {
  key: Buffer;
  iv: Buffer;
  tag: Buffer;
  bodyStart: number;
  bodyEnd: number; // inclusive
  bodyLen: number;
}

async function openArchive(file: string, passphrase: string): Promise<OpenedArchive> {
  const st = await stat(file);
  if (st.size < HEADER_LEN + TAG_LEN)
    throw new BackupFormatError('file is too small to be a backup');

  const fh = await open(file, 'r');
  try {
    const header = Buffer.alloc(HEADER_LEN);
    await fh.read(header, 0, HEADER_LEN, 0);
    if (!header.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new BackupFormatError('not a Vibe Tax backup archive');
    }
    const version = header[MAGIC.length]!;
    if (version === 1) {
      throw new BackupFormatError(
        'This archive is a format-1 backup made by an older release; this build cannot ' +
          'restore it. Restore it on the release that created it, then create a fresh ' +
          'backup with this version.',
      );
    }
    if (version !== FORMAT_VERSION) {
      throw new BackupFormatError(`unsupported backup format version ${version}`);
    }
    const salt = header.subarray(MAGIC.length + 1, MAGIC.length + 1 + SALT_LEN);
    const iv = header.subarray(MAGIC.length + 1 + SALT_LEN);
    const tag = Buffer.alloc(TAG_LEN);
    await fh.read(tag, 0, TAG_LEN, st.size - TAG_LEN);
    const key = await deriveKey(passphrase, salt);
    return {
      key,
      iv: Buffer.from(iv),
      tag,
      bodyStart: HEADER_LEN,
      bodyEnd: st.size - TAG_LEN - 1,
      bodyLen: st.size - TAG_LEN - HEADER_LEN,
    };
  } finally {
    await fh.close();
  }
}

/**
 * Read an encrypted backup from a file on disk.
 *
 * Requires a real file rather than a stream: AES-GCM cannot be verified
 * until the tag is known, and the tag lives at the end. Seeking to read it
 * first is what lets the body stream instead of being buffered.
 */
export async function readBackup(
  file: string,
  passphrase: string,
  handlers: RestoreHandlers,
): Promise<void> {
  const opened = await openArchive(file, passphrase);
  const decipher = createDecipheriv('aes-256-gcm', opened.key, opened.iv);
  decipher.setAuthTag(opened.tag);

  const body = createReadStream(file, { start: opened.bodyStart, end: opened.bodyEnd });
  let bytesRead = 0;
  body.on('data', (c) => {
    bytesRead += (c as Buffer).length;
    handlers.onProgress?.(bytesRead, opened.bodyLen);
  });
  const extract = tar.extract();

  // Handler failures are collected, never left as floating rejected
  // promises: if the outer pipeline also fails (e.g. the decipher aborts
  // because pg_restore stopped consuming the dump), the FIRST handler error
  // is the actionable cause and must win over the secondary stream error.
  const failures: unknown[] = [];
  extract.on('entry', (header, stream, next) => {
    const name = header.name;
    const collect = async () => {
      if (name === 'manifest.json' || name === 'master.key') {
        const chunks: Buffer[] = [];
        for await (const c of stream) chunks.push(c as Buffer);
        const text = Buffer.concat(chunks).toString('utf-8');
        if (name === 'manifest.json') {
          await handlers.onManifest(parseManifest(text));
        } else {
          await handlers.onMasterKey(text.trim());
        }
        return;
      }
      if (name === DATABASE_ENTRY) {
        await handlers.onDatabase(stream as unknown as Readable);
        return;
      }
      const dest = handlers.resolveFile(name);
      if (!dest) {
        stream.resume();
        return;
      }
      await mkdir(path.dirname(dest), { recursive: true });
      await pipeline(stream as unknown as Readable, createWriteStream(dest));
    };
    collect()
      .then(() => next())
      .catch((err) => {
        stream.resume();
        failures.push(err);
        next();
      });
  });

  try {
    await pipeline(body, decipher, createGunzip(), extract);
  } catch (err) {
    if (failures.length) throw failures[0];
    const msg = (err as Error).message ?? '';
    // GCM surfaces both a wrong passphrase and a truncated/edited file the
    // same way; say so plainly instead of leaking "unable to authenticate".
    if (/auth|unable to authenticate|bad decrypt/i.test(msg)) {
      throw new BackupPassphraseError(
        'Could not decrypt the archive — wrong passphrase, or the file is corrupt.',
      );
    }
    throw err;
  }
  if (failures.length) throw failures[0];
}

/**
 * Decrypt just far enough to return the manifest (the FIRST tar entry).
 *
 * Cheap even on multi-GB archives, but it deliberately does NOT verify the
 * GCM tag — a full extract pass (which readBackup performs before any
 * database write) is the integrity check. Callers must treat the result as
 * "what the archive claims", not "what the archive is proven to contain".
 */
export async function readManifestOnly(file: string, passphrase: string): Promise<ManifestV2> {
  const opened = await openArchive(file, passphrase);
  const decipher = createDecipheriv('aes-256-gcm', opened.key, opened.iv);
  decipher.setAuthTag(opened.tag);

  const body = createReadStream(file, { start: opened.bodyStart, end: opened.bodyEnd });
  const extract = tar.extract();

  // Result is carried OUT of the stream machinery rather than thrown
  // through it — destroying a pipeline with a custom error re-emits it on
  // inner streams with no listeners and becomes an uncaught exception.
  let found: ManifestV2 | undefined;
  let failure: Error | undefined;
  // Only the FIRST entry matters; destroy() lands asynchronously, so later
  // entries may still be announced — drain them instead of re-judging them.
  let seenFirst = false;
  extract.on('entry', (header, stream, next) => {
    if (seenFirst) {
      stream.resume();
      next();
      return;
    }
    seenFirst = true;
    if (header.name !== 'manifest.json') {
      failure = new BackupFormatError('archive does not begin with manifest.json — cannot inspect');
      extract.destroy();
      return;
    }
    const chunks: Buffer[] = [];
    stream.on('data', (c) => chunks.push(c as Buffer));
    stream.on('end', () => {
      try {
        found = parseManifest(Buffer.concat(chunks).toString('utf-8'));
      } catch (err) {
        failure = err as Error;
      }
      extract.destroy();
    });
    next();
  });

  try {
    await pipeline(body, decipher, createGunzip(), extract);
  } catch (err) {
    // Premature close is the EXPECTED outcome of our own early destroy; any
    // pipeline error only matters when we did not already get a result.
    if (!found && !failure) {
      const msg = (err as Error).message ?? '';
      if (/auth|unable to authenticate|bad decrypt/i.test(msg)) {
        throw new BackupPassphraseError(
          'Could not decrypt the archive — wrong passphrase, or the file is corrupt.',
        );
      }
      throw err;
    }
  }
  if (failure) throw failure;
  if (found) return found;
  throw new BackupFormatError('archive contained no manifest.json');
}

/** Non-reversible fingerprint so a manifest can be compared without
 *  disclosing the key it describes. */
export function fingerprint(secret: string): string {
  return createHash('sha256').update(secret).digest('hex').slice(0, 16);
}

// Re-exported so existing importers of the error classes keep working.
export { BackupFormatError, BackupPassphraseError } from './errors.js';
