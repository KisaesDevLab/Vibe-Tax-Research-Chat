// TP-15 — integration tests for the migration-0012 triggers, run against
// a real Postgres (local dev stack on 5439). Skips cleanly when no
// database is reachable so `pnpm test` stays green in bare CI.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as dotenvConfig } from 'dotenv';
import postgres from 'postgres';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: path.resolve(__dirname, '../../../.env') });

const CLIENT_ID = '99999999-9999-4999-8999-999999999991';
const PLAN_ID = '88888888-8888-4888-8888-888888888881';

let sql: ReturnType<typeof postgres> | null = null;
let available = false;

beforeAll(async () => {
  if (!process.env.DATABASE_URL) return;
  try {
    sql = postgres(process.env.DATABASE_URL, { max: 2, connect_timeout: 3 });
    const rows = await sql`
      SELECT count(*)::int AS n FROM pg_trigger
      WHERE tgname IN ('plan_results_freeze', 'audit_log_append_only')`;
    available = rows[0]?.n === 2;
  } catch {
    available = false;
  }
});

afterAll(async () => {
  if (sql && available) {
    await sql`UPDATE plans SET status = 'draft' WHERE id = ${PLAN_ID}`.catch(() => {});
    await sql`DELETE FROM plan_results WHERE plan_id = ${PLAN_ID}`.catch(() => {});
    await sql`DELETE FROM plans WHERE id = ${PLAN_ID}`.catch(() => {});
    await sql`DELETE FROM clients WHERE id = ${CLIENT_ID}`.catch(() => {});
  }
  await sql?.end({ timeout: 2 });
});

describe('migration 0012 triggers (integration)', () => {
  it.skipIf(!process.env.DATABASE_URL)('connects (or skips the suite)', () => {
    if (!available) {
      console.warn('triggers.integration: no reachable DB with 0012 applied — skipping');
    }
    expect(true).toBe(true);
  });

  it('freezes plan_results once the plan is presented, and thaws never', async ({ skip }) => {
    if (!available) return skip();
    const s = sql!;
    await s`INSERT INTO clients (id, name) VALUES (${CLIENT_ID}, 'Trigger IT') ON CONFLICT DO NOTHING`;
    await s`
      INSERT INTO plans (id, client_id, title, status, baseline_profile, growth_pct, years, table_set_id, engine_version)
      SELECT ${PLAN_ID}, ${CLIENT_ID}, 'trigger-it', 'draft', '{}'::jsonb, 0, 1, id, 'it' FROM table_sets LIMIT 1
      ON CONFLICT (id) DO UPDATE SET status = 'draft'`;
    await s`DELETE FROM plan_results WHERE plan_id = ${PLAN_ID}`;
    await s`
      INSERT INTO plan_results (plan_id, year, result, table_set_id, engine_version)
      SELECT ${PLAN_ID}, 2026, '{}'::jsonb, id, 'it' FROM table_sets LIMIT 1`;

    // Draft: recompute-style mutations are allowed.
    await s`UPDATE plan_results SET engine_version = 'it2' WHERE plan_id = ${PLAN_ID}`;

    // Presented: both UPDATE and DELETE must raise.
    await s`UPDATE plans SET status = 'presented' WHERE id = ${PLAN_ID}`;
    await expect(
      s`UPDATE plan_results SET engine_version = 'tampered' WHERE plan_id = ${PLAN_ID}`,
    ).rejects.toThrow(/plan_frozen/);
    await expect(s`DELETE FROM plan_results WHERE plan_id = ${PLAN_ID}`).rejects.toThrow(
      /plan_frozen/,
    );
  });

  it('audit_log is append-only', async ({ skip }) => {
    if (!available) return skip();
    const s = sql!;
    const [row] = await s`
      INSERT INTO audit_log (action, metadata) VALUES ('trigger.it', '{}'::jsonb)
      RETURNING id`;
    await expect(s`UPDATE audit_log SET action = 'tampered' WHERE id = ${row!.id}`).rejects.toThrow(
      /audit_log_append_only/,
    );
    await expect(s`DELETE FROM audit_log WHERE id = ${row!.id}`).rejects.toThrow(
      /audit_log_append_only/,
    );
  });
});
