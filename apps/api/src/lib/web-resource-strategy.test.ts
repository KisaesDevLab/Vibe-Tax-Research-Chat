// Phase 36 — strategy reader semantics. Mocks the settings store so we
// can exercise the merge-with-default path without standing up Postgres.
import { describe, it, expect, beforeAll, vi, afterEach } from 'vitest';
import crypto from 'node:crypto';

beforeAll(() => {
  process.env.MASTER_KEY = crypto.randomBytes(32).toString('hex');
  process.env.JWT_SECRET = crypto.randomBytes(64).toString('hex');
  process.env.JWT_REFRESH_SECRET = crypto.randomBytes(64).toString('hex');
  process.env.DATABASE_URL = 'postgres://x/x';
  process.env.REDIS_URL = 'redis://localhost:6389';
});

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

describe('getWebResourceStrategy', () => {
  it('returns DEFAULT_STRATEGY when nothing is stored', async () => {
    vi.doMock('../lib/settings-store.js', () => ({
      getSetting: vi.fn(async () => null),
      setSetting: vi.fn(),
    }));
    const mod = await import('./web-resource-strategy.js');
    const out = await mod.getWebResourceStrategy();
    expect(out).toEqual(mod.DEFAULT_STRATEGY);
    for (const src of mod.WEB_RESOURCE_SOURCES) {
      expect(out[src]).toBe('anthropic');
    }
  });

  it('merges a partial stored strategy with the default for missing sources', async () => {
    vi.doMock('../lib/settings-store.js', () => ({
      getSetting: vi.fn(async () => ({ usc: 'mcp' })),
      setSetting: vi.fn(),
    }));
    const mod = await import('./web-resource-strategy.js');
    const out = await mod.getWebResourceStrategy();
    expect(out.usc).toBe('mcp');
    expect(out.cfr).toBe('anthropic');
    expect(out.dawson).toBe('anthropic');
  });

  it('drops invalid stored values', async () => {
    vi.doMock('../lib/settings-store.js', () => ({
      getSetting: vi.fn(async () => ({ usc: 'invalid', cfr: 'mcp' })),
      setSetting: vi.fn(),
    }));
    const mod = await import('./web-resource-strategy.js');
    const out = await mod.getWebResourceStrategy();
    expect(out.usc).toBe('anthropic'); // dropped + replaced with default
    expect(out.cfr).toBe('mcp');
  });
});

describe('setWebResourceStrategy', () => {
  it('coerces unknown sources / modes back to anthropic before persisting', async () => {
    const setSpy = vi.fn();
    vi.doMock('../lib/settings-store.js', () => ({
      getSetting: vi.fn(),
      setSetting: setSpy,
    }));
    const mod = await import('./web-resource-strategy.js');
    await mod.setWebResourceStrategy(
      {
        usc: 'mcp',
        cfr: 'anthropic',
        // @ts-expect-error - intentional bad mode
        irb: 'BOGUS',
        fr: 'anthropic',
        dawson: 'anthropic',
        govinfo: 'anthropic',
        state_dor: 'anthropic',
      },
      'user-id',
    );
    expect(setSpy).toHaveBeenCalledOnce();
    const stored = setSpy.mock.calls[0]![1] as Record<string, string>;
    expect(stored.usc).toBe('mcp');
    expect(stored.irb).toBe('anthropic');
  });
});

describe('MCP_IMPLEMENTED_SOURCES', () => {
  it('lists exactly usc + cfr in v1.5', async () => {
    const mod = await import('./web-resource-strategy.js');
    expect([...mod.MCP_IMPLEMENTED_SOURCES].sort()).toEqual(['cfr', 'usc']);
  });
});
