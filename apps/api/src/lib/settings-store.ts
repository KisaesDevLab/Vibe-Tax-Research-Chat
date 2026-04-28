// Phase 5 — settings KV with per-key encrypt-on-write for is_encrypted=true rows.
import { eq } from 'drizzle-orm';
import { getDb } from '@vibe/db';
import { settings } from '@vibe/db/schema';
import { seal, open, type SealedValue } from './crypto.js';

export async function getSetting<T = unknown>(key: string): Promise<T | null> {
  const [row] = await getDb().select().from(settings).where(eq(settings.key, key)).limit(1);
  if (!row) return null;
  if (row.is_encrypted) {
    return open(row.value as unknown as SealedValue, key) as unknown as T;
  }
  return row.value as T;
}

export async function setSetting(
  key: string,
  value: unknown,
  opts: { encrypted?: boolean; updated_by?: string } = {},
): Promise<void> {
  const stored = opts.encrypted ? (seal(String(value), key) as unknown as object) : (value as object);
  await getDb()
    .insert(settings)
    .values({
      key,
      value: stored as Record<string, unknown>,
      is_encrypted: opts.encrypted ?? false,
      updated_by: opts.updated_by ?? null,
    })
    .onConflictDoUpdate({
      target: settings.key,
      set: {
        value: stored as Record<string, unknown>,
        is_encrypted: opts.encrypted ?? false,
        updated_by: opts.updated_by ?? null,
        updated_at: new Date(),
      },
    });
}

export async function deleteSetting(key: string): Promise<void> {
  await getDb().delete(settings).where(eq(settings.key, key));
}
