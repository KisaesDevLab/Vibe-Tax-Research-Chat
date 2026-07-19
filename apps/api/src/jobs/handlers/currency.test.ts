// TP-14 — unit tests for the pure parts of the currency jobs: the
// table field-diff, the archive keyword matcher, and the golden runner
// (proving the DB-shaped golden replays exactly what the content
// records embed).
import { describe, it, expect, beforeAll } from 'vitest';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

beforeAll(() => {
  process.env.MASTER_KEY = crypto.randomBytes(32).toString('hex');
  process.env.DATABASE_URL ??= 'postgres://x:x@localhost:9/x';
  process.env.REDIS_URL ??= 'redis://localhost:9';
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('diffTableFields', () => {
  it('reports changed, added, and removed leaves with dot paths', async () => {
    const { diffTableFields } = await import('./currency.js');
    const a = { salt: { cap: { mfj: 40_400 } }, ctc: { amount: 2_200 }, gone: 1 };
    const b = { salt: { cap: { mfj: 41_000 } }, ctc: { amount: 2_200 }, added: true };
    const diffs = diffTableFields(a, b);
    const paths = diffs.map((d) => d.path).sort();
    expect(paths).toEqual(['added', 'gone', 'salt.cap.mfj']);
    const salt = diffs.find((d) => d.path === 'salt.cap.mfj')!;
    expect(salt.from).toBe(40_400);
    expect(salt.to).toBe(41_000);
  });

  it('is empty for identical payloads', async () => {
    const { diffTableFields } = await import('./currency.js');
    const payload = { brackets: { single: [[0, 0.1]] } };
    expect(diffTableFields(payload, JSON.parse(JSON.stringify(payload)))).toEqual([]);
  });
});

describe('matchArchiveKeywords', () => {
  const strategies = [
    {
      id: 'augusta-rule',
      lastReviewed: '2026-01-01',
      keywords: ['Augusta rule', '280A(g)', 'day'],
    },
  ];

  it('matches case-insensitively, only after lastReviewed', async () => {
    const { matchArchiveKeywords } = await import('./currency.js');
    const hits = matchArchiveKeywords(strategies, [
      { id: 'old', archived_at: new Date('2025-12-01'), text: 'the augusta rule discussion' },
      { id: 'new', archived_at: new Date('2026-06-01'), text: 'New AUGUSTA RULE ruling out' },
      { id: 'unrelated', archived_at: new Date('2026-06-01'), text: 'S corp comp study' },
    ]);
    expect(hits).toEqual([
      { strategy_id: 'augusta-rule', archive_id: 'new', keyword: 'Augusta rule' },
    ]);
  });

  it('ignores keywords shorter than 4 chars (noise guard)', async () => {
    const { matchArchiveKeywords } = await import('./currency.js');
    const hits = matchArchiveKeywords(
      [{ id: 's', lastReviewed: '2026-01-01', keywords: ['day'] }],
      [{ id: 'a', archived_at: new Date('2026-06-01'), text: 'every day text' }],
    );
    expect(hits).toEqual([]);
  });
});

describe('runGoldenCase', () => {
  it('replays an embedded content golden exactly through the DB-shaped runner', async () => {
    const { runGoldenCase } = await import('./currency.js');
    await import('@vibe/strategies'); // side effect: registers apply modules
    const { listStrategyRecords } = await import('@vibe/strategies');
    const tables = JSON.parse(
      readFileSync(
        path.resolve(__dirname, '../../../../../packages/db/seeds/table-sets/2026.json'),
        'utf-8',
      ),
    ) as { tax_year: number; payload: Record<string, unknown> };

    const augusta = listStrategyRecords().find((r) => r.id === 'augusta-rule')!;
    const golden = augusta.model!.goldenTests[0]!;
    const { actual, expected } = runGoldenCase(
      {
        profile: golden.profile,
        params: golden.params,
        expected: { totalBurdenDelta: golden.expect.totalBurdenDelta },
      },
      augusta.model!.apply.module,
      augusta.model!.applyOrder,
      'augusta-rule',
      tables.payload as never,
      tables.tax_year,
    );
    expect(actual).toBe(expected);
  });
});
