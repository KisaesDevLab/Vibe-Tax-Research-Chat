// Phase 4 — monthly spend cap enforcement.
// Returns null if the user is OK to proceed, otherwise the reason payload.
import { and, eq, gte, sql } from 'drizzle-orm';
import { getDb } from '@vibe/db';
import { users, usage_events } from '@vibe/db/schema';

export interface SpendCapBlock {
  cap_usd: number;
  mtd_usd: number;
}

export async function checkSpendCap(user_id: string): Promise<SpendCapBlock | null> {
  const db = getDb();
  const [user] = await db.select().from(users).where(eq(users.id, user_id)).limit(1);
  if (!user || user.monthly_spend_cap_usd === null) return null;
  const cap = Number(user.monthly_spend_cap_usd);
  if (cap <= 0) return null;

  const start = new Date();
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);

  const rows = await db
    .select({ total: sql<string>`COALESCE(SUM(${usage_events.cost_usd}), 0)`.as('total') })
    .from(usage_events)
    .where(and(eq(usage_events.user_id, user_id), gte(usage_events.occurred_at, start)));

  const mtd = Number(rows[0]?.total ?? 0);
  if (mtd >= cap) return { cap_usd: cap, mtd_usd: mtd };
  return null;
}
