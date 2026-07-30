// End-to-end check of deliverable rendering against a real Postgres: build
// render data from actual rows, run the PDFKit renderer, and confirm the
// worker writes a content-addressed artifact and flips the row to `ready`.
//
// This covers the seam the unit tests cannot — buildRenderData's queries
// (including the plan_memos read added with the memo feature) against live
// schema. Skips cleanly when no database is reachable so bare CI stays green.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config as dotenvConfig } from 'dotenv';
import { eq, sql as raw } from 'drizzle-orm';
import { getDb } from '@vibe/db';
import {
  clients,
  deliverables,
  plan_memos,
  plan_results,
  plans,
  table_sets,
} from '@vibe/db/schema';
import type { YearResult } from '@vibe/shared';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: path.resolve(__dirname, '../../../../../.env') });

const CLIENT_ID = '99999999-9999-4999-8999-999999999992';
const PLAN_ID = '88888888-8888-4888-8888-888888888882';
const TABLE_SET_ID = '77777777-7777-4777-8777-777777777772';

let available = false;
const written: string[] = [];

type Db = ReturnType<typeof getDb>;

beforeAll(async () => {
  if (!process.env.DATABASE_URL) return;
  try {
    // Require the tables this pipeline reads — including plan_memos, so an
    // un-migrated database skips rather than failing.
    const rows = await getDb().execute(raw`
      SELECT count(*)::int AS n FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('plans','plan_results','plan_memos','deliverables','table_sets','clients')`);
    const n = (rows as unknown as Array<{ n: number }>)[0]?.n;
    available = n === 6;
  } catch {
    available = false;
  }
});

afterAll(async () => {
  if (available) {
    const db = getDb();
    await db
      .delete(deliverables)
      .where(eq(deliverables.plan_id, PLAN_ID))
      .catch(() => {});
    await db
      .delete(plan_memos)
      .where(eq(plan_memos.plan_id, PLAN_ID))
      .catch(() => {});
    // Unfreeze before deleting results — migration 0012 blocks writes on a
    // presented plan.
    await db
      .update(plans)
      .set({ status: 'draft' })
      .where(eq(plans.id, PLAN_ID))
      .catch(() => {});
    await db
      .delete(plan_results)
      .where(eq(plan_results.plan_id, PLAN_ID))
      .catch(() => {});
    await db
      .delete(plans)
      .where(eq(plans.id, PLAN_ID))
      .catch(() => {});
    await db
      .delete(clients)
      .where(eq(clients.id, CLIENT_ID))
      .catch(() => {});
    await db
      .delete(table_sets)
      .where(eq(table_sets.id, TABLE_SET_ID))
      .catch(() => {});
  }
  for (const f of written) rmSync(f, { force: true });
});

const yearResult = (totalBurden: number): YearResult =>
  ({
    year: 2026,
    totalBurden,
    agi: 200000,
    taxableIncome: 180000,
  }) as unknown as YearResult;

/** Minimal but realistic fixture: a computed plan with one baseline year. */
async function seedPlan(db: Db, memo: string | null): Promise<void> {
  await db
    .insert(table_sets)
    .values({
      id: TABLE_SET_ID,
      tax_year: 2026,
      version: 999,
      status: 'published',
      payload: {} as never,
    })
    .onConflictDoNothing();
  await db.insert(clients).values({ id: CLIENT_ID, name: 'Pipeline IT' }).onConflictDoNothing();
  await db
    .insert(plans)
    .values({
      id: PLAN_ID,
      client_id: CLIENT_ID,
      title: 'Pipeline IT plan',
      status: 'draft',
      baseline_profile: {} as never,
      growth_pct: '0',
      years: 1,
      table_set_id: TABLE_SET_ID,
      engine_version: 'it',
    })
    .onConflictDoUpdate({ target: plans.id, set: { status: 'draft' } });
  await db.delete(plan_results).where(eq(plan_results.plan_id, PLAN_ID));
  await db.insert(plan_results).values({
    plan_id: PLAN_ID,
    scenario_id: null,
    year: 2026,
    result: yearResult(50000),
    table_set_id: TABLE_SET_ID,
    engine_version: 'it',
  });
  await db.delete(plan_memos).where(eq(plan_memos.plan_id, PLAN_ID));
  if (memo !== null) {
    await db
      .insert(plan_memos)
      .values({ plan_id: PLAN_ID, body_markdown: memo, claude_drafted: false });
  }
}

/** Drive the real worker handler and assert the artifact landed. */
async function renderVia(db: Db, kind: string): Promise<string> {
  const [d] = await db
    .insert(deliverables)
    .values({
      plan_id: PLAN_ID,
      kind,
      reveal_strategies: true,
      delivered_via: 'staff-manual',
      status: 'queued',
    })
    .returning();
  const { renderDeliverable, deliverableStoragePath } =
    await import('../../jobs/handlers/pdf-render.js');
  await renderDeliverable(d!.id);
  const [after] = await db.select().from(deliverables).where(eq(deliverables.id, d!.id)).limit(1);
  expect(after!.error).toBeNull();
  expect(after!.status).toBe('ready');
  expect(after!.sha256).toMatch(/^[0-9a-f]{64}$/);
  const file = deliverableStoragePath(after!.storage_ref!);
  written.push(file);
  expect(existsSync(file)).toBe(true);
  return file;
}

describe('deliverable render pipeline (integration)', () => {
  it('connects (or skips the suite)', () => {
    if (!available) {
      console.warn('pipeline.integration: no reachable migrated DB — skipping');
    }
    expect(true).toBe(true);
  });

  it('renders an advisor PDF end-to-end and marks the row ready', async ({ skip }) => {
    if (!available) return skip();
    const db = getDb();
    await seedPlan(db, null);
    const file = await renderVia(db, 'advisor-pdf');
    expect(readFileSync(file).subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('includes a saved memo in the advisor PDF', async ({ skip }) => {
    if (!available) return skip();
    const db = getDb();
    await seedPlan(db, null);
    const plain = await renderVia(db, 'advisor-pdf');
    await seedPlan(db, '# Situation\n\nThe client runs an **S corporation**.');
    const withMemo = await renderVia(db, 'advisor-pdf');
    // The memo adds a page, so the artifact must be strictly larger.
    expect(statSync(withMemo).size).toBeGreaterThan(statSync(plain).size);
  });

  it('renders every client-facing kind once the plan is presented', async ({ skip }) => {
    if (!available) return skip();
    const db = getDb();
    await seedPlan(db, null);
    await db.update(plans).set({ status: 'presented' }).where(eq(plans.id, PLAN_ID));
    for (const kind of ['client-pdf', 'pitch-deck', 'slideshow']) {
      await renderVia(db, kind);
    }
  });
});
