// QA round 2 — the strategy-refresh sweep must keep going past one bad
// strategy: a thrown draft (e.g. a lost semver race before the 23505
// skip existed) previously aborted the loop and silently skipped every
// strategy after it.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../lib/redis.js', () => ({ getRedis: () => ({}) }));
vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../lib/skills/sync.js', () => ({ runDryRun: vi.fn() }));
vi.mock('../lib/references/ingest.js', () => ({ ingestReferenceDocument: vi.fn() }));
vi.mock('../lib/anthropic/client.js', () => ({ callClaude: vi.fn() }));
vi.mock('../lib/email/index.js', () => ({ buildMailer: vi.fn(), renderResetEmail: vi.fn() }));
vi.mock('../lib/settings-store.js', () => ({ getSetting: vi.fn() }));
vi.mock('../config/env.js', () => ({ env: {} }));
vi.mock('./queues.js', () => ({
  skillsSyncQueue: { add: vi.fn() },
  usageRollupQueue: { add: vi.fn() },
  tablesDraftQueue: { add: vi.fn() },
  strategyWatchQueue: { add: vi.fn() },
  archiveScanQueue: { add: vi.fn() },
}));

const draftStrategy = vi.fn();
vi.mock('./handlers/strategy-author.js', () => ({
  draftStrategy: (...args: unknown[]) => draftStrategy(...(args as [])),
}));

const strategyRows = [{ id: 's1' }, { id: 's2' }, { id: 's3' }];
vi.mock('@vibe/db', () => ({
  getDb: () => ({
    // The sweep filters retired strategies: .where() resolves the rows.
    select: () => ({ from: () => ({ where: () => Promise.resolve(strategyRows) }) }),
  }),
}));

describe('runStrategyRefresh sweep', () => {
  beforeEach(() => {
    draftStrategy.mockReset();
  });

  it('continues past a strategy whose draft throws', async () => {
    draftStrategy
      .mockRejectedValueOnce(Object.assign(new Error('duplicate key'), { code: '23505' }))
      .mockResolvedValue({ status: 'draft-created' });
    const { runStrategyRefresh } = await import('./workers.js');
    await runStrategyRefresh({ triggered_by: 'test' });
    expect(draftStrategy).toHaveBeenCalledTimes(3);
    expect(draftStrategy.mock.calls.map((c) => c[0])).toEqual(['s1', 's2', 's3']);
  });

  it('stops the sweep early on skipped-no-key (no key means nothing will succeed)', async () => {
    draftStrategy.mockResolvedValue({ status: 'skipped-no-key' });
    const { runStrategyRefresh } = await import('./workers.js');
    await runStrategyRefresh({ triggered_by: 'test' });
    expect(draftStrategy).toHaveBeenCalledTimes(1);
  });

  it('targets only the given strategy when strategy_id is set', async () => {
    draftStrategy.mockResolvedValue({ status: 'draft-created' });
    const { runStrategyRefresh } = await import('./workers.js');
    await runStrategyRefresh({ strategy_id: 's2', triggered_by: 'test' });
    expect(draftStrategy).toHaveBeenCalledTimes(1);
    expect(draftStrategy).toHaveBeenCalledWith('s2', 'test');
  });
});
