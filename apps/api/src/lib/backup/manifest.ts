// DR v2 — manifest schema for format-2 archives.
//
// The manifest is the restore's contract: everything `verify` checks after
// pg_restore (per-table row counts, migration count) and everything
// `inspect` preflights (dump tool major, app version) is recorded here at
// backup time. Row counts come from the same exported snapshot the dump
// runs under, so an exact compare after restore is sound.
import { z } from 'zod';
import { BackupFormatError } from './errors.js';

export const MANIFEST_FORMAT = 2;

export const manifestV2Schema = z.object({
  format: z.literal(2),
  createdAt: z.string(),
  appVersion: z.string(),
  /** Non-reversible fingerprint of the MASTER_KEY inside the archive. */
  masterKeyFingerprint: z.string(),
  database: z.object({
    name: z.string(),
    /** e.g. "16.11" — from SHOW server_version at dump time. */
    serverVersion: z.string(),
    /** pg_dump --version output; restore preflights major compatibility. */
    dumpedWith: z.string(),
    /** Applied drizzle migration count; restore refuses newer-than-shipped. */
    migrationsApplied: z.number().int().nonnegative(),
  }),
  /** public-schema table name → exact row count at the dump snapshot. */
  tables: z.record(z.number().int().nonnegative()),
  /** data-dir key → what the archive carries for it. */
  dirs: z.record(
    z.object({
      files: z.number().int().nonnegative(),
      bytes: z.number().int().nonnegative(),
    }),
  ),
});

export type ManifestV2 = z.infer<typeof manifestV2Schema>;

export function parseManifest(text: string): ManifestV2 {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new BackupFormatError('manifest.json in the archive is not valid JSON.');
  }
  const parsed = manifestV2Schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new BackupFormatError(`manifest.json failed validation — ${issues}`);
  }
  return parsed.data;
}
