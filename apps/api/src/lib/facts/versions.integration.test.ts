// TP-3a — fact-pattern versioning against a real Postgres (dev stack on
// 5439). Exercises the supersede + MAX+1 write path and the
// one-current-per-client partial unique index. Skips cleanly without a DB.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as dotenvConfig } from 'dotenv';
import postgres from 'postgres';
import { emptyFactPattern } from '@vibe/shared';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: path.resolve(__dirname, '../../../../../.env') });

const CLIENT_ID = '99999999-9999-4999-8999-999999999f3a';

let sql: ReturnType<typeof postgres> | null = null;
let available = false;

beforeAll(async () => {
  if (!process.env.DATABASE_URL) return;
  try {
    sql = postgres(process.env.DATABASE_URL, { max: 2, connect_timeout: 3 });
    const rows = await sql`
      SELECT count(*)::int AS n FROM pg_indexes
      WHERE indexname = 'client_fact_patterns_current_uq'`;
    available = rows[0]?.n === 1;
    if (available) {
      await sql`DELETE FROM client_fact_patterns WHERE client_id = ${CLIENT_ID}`;
      await sql`DELETE FROM clients WHERE id = ${CLIENT_ID}`;
      await sql`INSERT INTO clients (id, name) VALUES (${CLIENT_ID}, 'Facts Integration Fixture')`;
    }
  } catch {
    available = false;
  }
});

afterAll(async () => {
  if (sql && available) {
    await sql`DELETE FROM client_fact_patterns WHERE client_id = ${CLIENT_ID}`.catch(() => {});
    await sql`DELETE FROM clients WHERE id = ${CLIENT_ID}`.catch(() => {});
  }
  await sql?.end({ timeout: 2 });
});

describe('client_fact_patterns versioning', () => {
  it('supersedes the prior current and increments version', async (ctx) => {
    if (!available) return ctx.skip();
    const facts = JSON.stringify(emptyFactPattern());
    const insertVersion = async (summary: string) =>
      sql!.begin(async (tx) => {
        await tx`
          UPDATE client_fact_patterns SET superseded_at = now()
          WHERE client_id = ${CLIENT_ID} AND superseded_at IS NULL`;
        const rows = (await tx`
          SELECT coalesce(max(version), 0) + 1 AS next
          FROM client_fact_patterns WHERE client_id = ${CLIENT_ID}`) as unknown as Array<{
          next: number;
        }>;
        const next = rows[0]!.next;
        return tx`
          INSERT INTO client_fact_patterns (client_id, version, schema_version, facts, change_summary)
          VALUES (${CLIENT_ID}, ${next as number}, '1.0.0', ${facts}::jsonb, ${summary})
          RETURNING id, version`;
      });

    const [v1] = await insertVersion('v1');
    const [v2] = await insertVersion('v2');
    expect(v1!.version).toBe(1);
    expect(v2!.version).toBe(2);

    const current = await sql!`
      SELECT version FROM client_fact_patterns
      WHERE client_id = ${CLIENT_ID} AND superseded_at IS NULL`;
    expect(current).toHaveLength(1);
    expect(current[0]!.version).toBe(2);
  });

  it('partial unique index rejects a second current row', async (ctx) => {
    if (!available) return ctx.skip();
    const facts = JSON.stringify(emptyFactPattern());
    await expect(
      sql!`
        INSERT INTO client_fact_patterns (client_id, version, schema_version, facts, change_summary)
        VALUES (${CLIENT_ID}, 99, '1.0.0', ${facts}::jsonb, 'race')`,
    ).rejects.toMatchObject({ code: '23505' });
  });
});
