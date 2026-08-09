// DR v2 — error taxonomy shared across the backup lib. Kept in their own
// module so archive.ts and manifest.ts can both use them without a cycle.

/** Structural problems: wrong magic, unsupported version, bad manifest. */
export class BackupFormatError extends Error {}

/** GCM authentication failure — wrong passphrase or corrupted file. */
export class BackupPassphraseError extends Error {}

/** A precondition failed BEFORE anything destructive ran. */
export class RestorePrerequisiteError extends Error {}

/** A required PostgreSQL client tool is missing from the runtime. */
export class PgToolMissingError extends Error {}
