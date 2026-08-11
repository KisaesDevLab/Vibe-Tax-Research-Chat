// TP-12 — unit tests for the semver-collision resolver. The unique index
// on (strategy_id, semver) covers rejected and deprecated rows too,
// so the resolver must bump past the numeric max, not just the current
// published version.
//
// QA round 2 adds draftStrategy dedupe/concurrency tests: an OPEN
// strategy-draft review item suppresses a new draft (refresh-sweep is
// idempotent), and a semver unique-violation from a concurrent run is a
// logged skip, never a throw that aborts the sweep.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import crypto from 'node:crypto';
import { strategies, strategy_versions, review_queue, table_sets } from '@vibe/db/schema';

const callClaude = vi.fn(
  async (): Promise<{ text: string }> => ({
    text: '{"version":"1.1.0"}',
  }),
);
vi.mock('../../lib/anthropic/client.js', () => ({
  callClaude: (...args: unknown[]) => callClaude(...(args as [])),
  ClaudeDisabledError: class ClaudeDisabledError extends Error {},
}));
vi.mock('../../lib/audit.js', () => ({ audit: vi.fn() }));
vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
// The draft's content is irrelevant to these tests — validation outcome
// only steers the retry/park paths, not the dedupe or 23505 handling.
vi.mock('@vibe/schema', () => ({
  validateStrategyRecord: () => ({ ok: true, errors: [] }),
}));

type Row = Record<string, unknown>;
const dbState: {
  strategy: Row | null;
  openReviewItems: Row[];
  currentVersion: Row | null;
  txError: Error | null;
} = { strategy: null, openReviewItems: [], currentVersion: null, txError: null };

function rowsFor(table: unknown): Row[] {
  if (table === strategies) return dbState.strategy ? [dbState.strategy] : [];
  if (table === review_queue) return dbState.openReviewItems;
  if (table === strategy_versions) return dbState.currentVersion ? [dbState.currentVersion] : [];
  if (table === table_sets) return [];
  return [];
}

function makeDb(): Record<string, unknown> {
  return {
    select: () => ({
      from: (table: unknown) => {
        const rows = rowsFor(table);
        // where() is awaited directly for the existing-semvers scan and
        // chained through limit/orderBy everywhere else.
        const tail = Promise.resolve(rows) as Promise<Row[]> & {
          limit: () => Promise<Row[]>;
          orderBy: () => { limit: () => Promise<Row[]> };
        };
        tail.limit = async () => rows;
        tail.orderBy = () => ({ limit: async () => rows });
        return {
          where: () => tail,
          orderBy: () => ({ limit: async () => rows }),
        };
      },
    }),
    transaction: async () => {
      if (dbState.txError) throw dbState.txError;
      return { id: 'new-version' };
    },
  };
}

vi.mock('@vibe/db', () => ({ getDb: () => makeDb() }));

beforeAll(() => {
  process.env.MASTER_KEY = crypto.randomBytes(32).toString('hex');
  process.env.DATABASE_URL ??= 'postgres://x:x@localhost:9/x';
  process.env.REDIS_URL ??= 'redis://localhost:9';
});

describe('resolveDraftSemver', () => {
  it('keeps the desired version when unused', async () => {
    const { resolveDraftSemver } = await import('./strategy-author.js');
    expect(resolveDraftSemver('1.3.0', ['1.0.0', '1.1.0', '1.2.0'])).toBe('1.3.0');
  });

  it('bumps minor past the max on collision', async () => {
    const { resolveDraftSemver } = await import('./strategy-author.js');
    expect(resolveDraftSemver('1.2.0', ['1.0.0', '1.1.0', '1.2.0'])).toBe('1.3.0');
  });

  it('bumps past a rejected row above the desired version', async () => {
    // 1.3.0 was drafted and rejected earlier; a fresh draft
    // desiring 1.2.0 must land beyond it, not at 1.2.x again.
    const { resolveDraftSemver } = await import('./strategy-author.js');
    expect(resolveDraftSemver('1.2.0', ['1.1.0', '1.2.0', '1.3.0'])).toBe('1.4.0');
  });

  it('compares numerically, not lexicographically', async () => {
    const { resolveDraftSemver } = await import('./strategy-author.js');
    expect(resolveDraftSemver('1.9.0', ['1.9.0', '1.10.0'])).toBe('1.11.0');
  });

  it('resets patch on the bump', async () => {
    const { resolveDraftSemver } = await import('./strategy-author.js');
    expect(resolveDraftSemver('2.1.3', ['2.1.3'])).toBe('2.2.0');
  });

  it('bumps past a higher major version', async () => {
    const { resolveDraftSemver } = await import('./strategy-author.js');
    expect(resolveDraftSemver('1.5.0', ['1.5.0', '3.0.1'])).toBe('3.1.0');
  });
});

describe('restoreMachineFields', () => {
  it('drops a fabricated all-null model block on an advisory record', async () => {
    // The exact production failure: "keep model.applyOrder unchanged" on a
    // record with NO model block made Claude emit one made of nulls, and
    // the validator reported "model.applyOrder: Expected number, received
    // null" (+ inputs/apply/suggest/goldenTests).
    const { restoreMachineFields } = await import('./strategy-author.js');
    const current = { id: 's-1', modeled: false, suggest: { rule: 'always' } };
    const draft: Record<string, unknown> = {
      id: 's-1',
      modeled: false,
      model: { applyOrder: null, inputs: null, apply: null, suggest: null, goldenTests: null },
      suggest: null,
    };
    restoreMachineFields(draft, current);
    expect('model' in draft).toBe(false);
    expect(draft.suggest).toEqual({ rule: 'always' });
  });

  it('restores nulled machine fields on a modeled record from the current version', async () => {
    const { restoreMachineFields } = await import('./strategy-author.js');
    const current = {
      id: 's-2',
      modeled: true,
      complexity: 3,
      model: {
        applyOrder: 30,
        inputs: { type: 'object' },
        apply: { module: 's-2@1.0.0' },
        suggest: { rule: 'x' },
        goldenTests: [{}, {}],
      },
    };
    const draft: Record<string, unknown> = {
      id: null,
      modeled: null,
      complexity: null,
      model: {
        applyOrder: null,
        inputs: null,
        apply: { module: 's-2@1.0.0' },
        suggest: { rule: 'x' },
        goldenTests: null,
      },
    };
    restoreMachineFields(draft, current);
    expect(draft.id).toBe('s-2');
    expect(draft.modeled).toBe(true);
    expect(draft.complexity).toBe(3);
    const model = draft.model as Record<string, unknown>;
    expect(model.applyOrder).toBe(30);
    expect(model.inputs).toEqual({ type: 'object' });
    expect(model.goldenTests).toHaveLength(2);
  });

  it('replaces a missing model block wholesale on a modeled record', async () => {
    const { restoreMachineFields } = await import('./strategy-author.js');
    const current = { modeled: true, model: { applyOrder: 10 } };
    const draft: Record<string, unknown> = { modeled: true };
    restoreMachineFields(draft, current);
    expect(draft.model).toEqual({ applyOrder: 10 });
  });

  it('leaves legitimate draft values untouched', async () => {
    const { restoreMachineFields } = await import('./strategy-author.js');
    const current = { modeled: true, riskRating: 'low', model: { applyOrder: 10 } };
    const draft: Record<string, unknown> = {
      modeled: true,
      riskRating: 'moderate',
      model: { applyOrder: 20 },
    };
    restoreMachineFields(draft, current);
    expect(draft.riskRating).toBe('moderate');
    expect((draft.model as Record<string, unknown>).applyOrder).toBe(20);
  });
});

describe('draftStrategy dedupe + concurrency', () => {
  beforeEach(() => {
    callClaude.mockClear();
    dbState.strategy = { id: 'strat-1', current_version_id: 'v1' };
    dbState.openReviewItems = [];
    dbState.currentVersion = { id: 'v1', semver: '1.0.0', content: {} };
    dbState.txError = null;
  });

  it('skips without calling Claude when an open strategy-draft item exists', async () => {
    dbState.openReviewItems = [{ id: 'rq-1' }];
    const { draftStrategy } = await import('./strategy-author.js');
    const result = await draftStrategy('strat-1', 'test');
    expect(result.status).toBe('skipped-open-review-item');
    expect(callClaude).not.toHaveBeenCalled();
  });

  it('treats a semver unique-violation (err.code) as a skip, not a throw', async () => {
    dbState.txError = Object.assign(new Error('duplicate key value'), { code: '23505' });
    const { draftStrategy } = await import('./strategy-author.js');
    const result = await draftStrategy('strat-1', 'test');
    expect(result.status).toBe('skipped-open-review-item');
  });

  it('detects the Postgres code on err.cause (drizzle-wrapped)', async () => {
    dbState.txError = new Error('insert failed', { cause: { code: '23505' } });
    const { draftStrategy } = await import('./strategy-author.js');
    const result = await draftStrategy('strat-1', 'test');
    expect(result.status).toBe('skipped-open-review-item');
  });

  it('still throws non-unique-violation transaction errors', async () => {
    dbState.txError = Object.assign(new Error('deadlock detected'), { code: '40P01' });
    const { draftStrategy } = await import('./strategy-author.js');
    await expect(draftStrategy('strat-1', 'test')).rejects.toThrow('deadlock detected');
  });

  it('creates a draft when no open item exists', async () => {
    const { draftStrategy } = await import('./strategy-author.js');
    const result = await draftStrategy('strat-1', 'test');
    expect(result.status).toBe('draft-created');
    expect(result.version_id).toBe('new-version');
    expect(callClaude).toHaveBeenCalledTimes(1);
  });
});
