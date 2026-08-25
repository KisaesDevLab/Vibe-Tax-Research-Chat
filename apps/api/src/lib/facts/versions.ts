// TP-3a — the ONE write path for fact-pattern versions. Supersede-current +
// MAX(version)+1 + insert, inside the caller's transaction. The partial
// unique index (one current row per client) turns lost races into a
// constraint violation — callers map that to 409 version_conflict.
import { and, eq, isNull, sql } from 'drizzle-orm';
import { getDb } from '@vibe/db';
import { client_fact_patterns, type ClientFactPattern } from '@vibe/db/schema';
import type { FactPattern } from '@vibe/shared';
import { FACT_SCHEMA_VERSION } from '@vibe/shared';

type DbConn = Pick<ReturnType<typeof getDb>, 'select' | 'insert' | 'update'>;

export interface CreateVersionArgs {
  clientId: string;
  facts: FactPattern;
  changeSummary: string;
  createdBy: string | null;
  schemaVersion?: string;
}

export function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === '23505';
}

export async function createFactPatternVersion(
  tx: DbConn,
  args: CreateVersionArgs,
): Promise<ClientFactPattern> {
  await tx
    .update(client_fact_patterns)
    .set({ superseded_at: new Date() })
    .where(
      and(
        eq(client_fact_patterns.client_id, args.clientId),
        isNull(client_fact_patterns.superseded_at),
      ),
    );
  const [{ next }] = (await tx
    .select({ next: sql<number>`coalesce(max(${client_fact_patterns.version}), 0) + 1` })
    .from(client_fact_patterns)
    .where(eq(client_fact_patterns.client_id, args.clientId))) as [{ next: number }];
  const [row] = await tx
    .insert(client_fact_patterns)
    .values({
      client_id: args.clientId,
      version: Number(next),
      schema_version: args.schemaVersion ?? FACT_SCHEMA_VERSION,
      facts: args.facts,
      created_by: args.createdBy,
      change_summary: args.changeSummary,
    })
    .returning();
  return row!;
}

/** The client's current (non-superseded) fact pattern, or null. */
export async function currentFactPattern(
  db: DbConn,
  clientId: string,
): Promise<ClientFactPattern | null> {
  const [row] = await db
    .select()
    .from(client_fact_patterns)
    .where(
      and(eq(client_fact_patterns.client_id, clientId), isNull(client_fact_patterns.superseded_at)),
    )
    .limit(1);
  return row ?? null;
}
