// Portable, passphrase-encrypted backup archive.
//
// Format (the plaintext header is readable so restore can derive the key
// before it has to trust anything):
//
//   "VIBETAXBK" | ver(1) | salt(16) | iv(12) | AES-256-GCM(gzip(tar)) | tag(16)
//
// The tar carries manifest.json, master.key, database.sql, and the data
// directories. MASTER_KEY travels INSIDE the encrypted payload: without it
// the encrypted settings rows (Anthropic key, SMTP password) are so much
// noise on the destination box, and a backup that silently loses them is
// worse than no backup. That is exactly why the archive is encrypted and
// why a passphrase is mandatory rather than optional.
//
// Everything streams. These archives include client uploads and rendered
// PDFs and can run to gigabytes; nothing here may buffer a whole file, let
// alone the whole archive.
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scrypt as scryptCb,
} from 'node:crypto';
import { createGzip, createGunzip } from 'node:zlib';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, type Writable } from 'node:stream';
import * as tar from 'tar-stream';

export const MAGIC = Buffer.from('VIBETAXBK');
export const FORMAT_VERSION = 1;
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

export interface BackupManifest {
  format: number;
  createdAt: string;
  appVersion: string;
  /** Lets restore warn when the destination runs a different MASTER_KEY. */
  masterKeyFingerprint: string;
  includes: string[];
  database: { name: string; dumpedWith: string };
}

export interface BackupSource {
  /** Directories copied verbatim: archive prefix -> absolute path. */
  dirs: Record<string, string>;
  /** Streams the SQL dump. */
  databaseDump: () => Readable;
  manifest: BackupManifest;
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
): Promise<void> {
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = await deriveKey(passphrase, salt);

  // Plaintext header first — restore needs salt+iv before it can decrypt.
  out.write(Buffer.concat([MAGIC, Buffer.from([FORMAT_VERSION]), salt, iv]));

  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const pack = tar.pack();
  const gzip = createGzip({ level: 6 });

  // The GCM tag is only known once the cipher finishes, so it is appended
  // after the ciphertext — which means `out` must stay open past the end of
  // the pipeline. Piping with { end: false } keeps it open AND preserves
  // backpressure; the tag write below simply queues behind the body.
  cipher.pipe(out, { end: false });
  const done = pipeline(pack, gzip, cipher);

  const entry = (name: string, size: number, body: Readable) =>
    new Promise<void>((resolve, reject) => {
      const e = pack.entry({ name, size }, (err) => (err ? reject(err) : resolve()));
      body.pipe(e);
      body.on('error', reject);
    });

  const manifestJson = Buffer.from(JSON.stringify(source.manifest, null, 2));
  await entry('manifest.json', manifestJson.length, Readable.from([manifestJson]));

  const keyBuf = Buffer.from(source.masterKey, 'utf-8');
  await entry('master.key', keyBuf.length, Readable.from([keyBuf]));

  // The dump size is unknown up front, so it cannot use the fixed-size
  // entry path; tar-stream needs a size, so spool it to a temp file first.
  const tmp = path.join(
    process.env.BACKUP_TMP_DIR ?? '/tmp',
    `vibe-dump-${Date.now()}-${randomBytes(4).toString('hex')}.sql`,
  );
  await mkdir(path.dirname(tmp), { recursive: true }).catch(() => {});
  try {
    await pipeline(source.databaseDump(), createWriteStream(tmp));
    const dumpStat = await stat(tmp);
    await entry('database.sql', dumpStat.size, createReadStream(tmp));
  } finally {
    await rm(tmp, { force: true });
  }

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
  onManifest: (m: BackupManifest) => void | Promise<void>;
  onMasterKey: (key: string) => void | Promise<void>;
  /** Called with the SQL dump stream; must consume it fully. */
  onDatabase: (sql: Readable) => Promise<void>;
  /** Absolute destination for an archive path, or null to skip it. */
  resolveFile: (archivePath: string) => string | null;
}

export class BackupFormatError extends Error {}
export class BackupPassphraseError extends Error {}

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
  const st = await stat(file);
  if (st.size < HEADER_LEN + TAG_LEN)
    throw new BackupFormatError('file is too small to be a backup');

  const fh = await open(file, 'r');
  let key: Buffer;
  let iv: Buffer;
  let tag: Buffer;
  try {
    const header = Buffer.alloc(HEADER_LEN);
    await fh.read(header, 0, HEADER_LEN, 0);
    if (!header.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new BackupFormatError('not a Vibe Tax backup archive');
    }
    const version = header[MAGIC.length]!;
    if (version !== FORMAT_VERSION) {
      throw new BackupFormatError(`unsupported backup format version ${version}`);
    }
    const salt = header.subarray(MAGIC.length + 1, MAGIC.length + 1 + SALT_LEN);
    iv = header.subarray(MAGIC.length + 1 + SALT_LEN);
    tag = Buffer.alloc(TAG_LEN);
    await fh.read(tag, 0, TAG_LEN, st.size - TAG_LEN);
    key = await deriveKey(passphrase, salt);
  } finally {
    await fh.close();
  }

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);

  const body = createReadStream(file, { start: HEADER_LEN, end: st.size - TAG_LEN - 1 });
  const extract = tar.extract();

  const pending: Promise<void>[] = [];
  extract.on('entry', (header, stream, next) => {
    const name = header.name;
    const collect = async () => {
      if (name === 'manifest.json' || name === 'master.key') {
        const chunks: Buffer[] = [];
        for await (const c of stream) chunks.push(c as Buffer);
        const text = Buffer.concat(chunks).toString('utf-8');
        if (name === 'manifest.json') {
          await handlers.onManifest(JSON.parse(text) as BackupManifest);
        } else {
          await handlers.onMasterKey(text.trim());
        }
        return;
      }
      if (name === 'database.sql') {
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
        pending.push(Promise.reject(err));
        next();
      });
  });

  try {
    await pipeline(body, decipher, createGunzip(), extract);
  } catch (err) {
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
  await Promise.all(pending);
}

/** Non-reversible fingerprint so a manifest can be compared without
 *  disclosing the key it describes. */
export function fingerprint(secret: string): string {
  return createHash('sha256').update(secret).digest('hex').slice(0, 16);
}
