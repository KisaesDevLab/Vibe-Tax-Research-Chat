// Phase 34 — cache layer behavior. Mocks @vibe/db to keep this a pure
// unit test; the round-trip-through-real-Postgres test runs in the
// extreme-test pass at the end of PR 3.
import { describe, it, expect, beforeAll, vi, afterEach } from 'vitest';

beforeAll(() => {
  process.env.DATABASE_URL = 'postgres://x/x';
});

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

interface Row {
  id: string;
  source: string;
  cache_key: string;
  canonical_url: string;
  raw_text: string | null;
  parsed_text: string | null;
  metadata: Record<string, unknown>;
  fetched_at: Date;
  ttl_until: Date;
  upstream_status: string | null;
  upstream_etag: string | null;
  upstream_last_modified: string | null;
}

function makeFakeDb(initial: Row[]) {
  const rows: Row[] = [...initial];
  // Drizzle's chainable select is mimicked just enough to satisfy the
  // cache layer's two call sites: one filtered SELECT, one INSERT.
  const db = {
    select() {
      return {
        from() {
          return {
            where(_pred: unknown) {
              return {
                orderBy() {
                  return {
                    limit(n: number) {
                      // The cache layer's predicate is "source = X AND
                      // cache_key = Y AND ttl_until > now". The test
                      // controls what's in `rows` so we just return them
                      // when the harness wants a hit.
                      return Promise.resolve(rows.slice(0, n));
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
    insert() {
      return {
        values(vals: Record<string, unknown>) {
          rows.push({
            id: 'inserted',
            source: vals.source as string,
            cache_key: vals.cache_key as string,
            canonical_url: vals.canonical_url as string,
            raw_text: (vals.raw_text as string | null) ?? null,
            parsed_text: vals.parsed_text as string,
            metadata: (vals.metadata as Record<string, unknown>) ?? {},
            fetched_at: vals.fetched_at as Date,
            ttl_until: vals.ttl_until as Date,
            upstream_status: (vals.upstream_status as string | null) ?? null,
            upstream_etag: (vals.upstream_etag as string | null) ?? null,
            upstream_last_modified: (vals.upstream_last_modified as string | null) ?? null,
          });
          return Promise.resolve(undefined);
        },
      };
    },
    _rows: rows,
  };
  return db;
}

vi.mock('@vibe/db', () => {
  const fakeDb = makeFakeDb([]);
  return {
    getDb: () => fakeDb,
    schema: {
      authority_cache: {
        source: 'source',
        cache_key: 'cache_key',
        ttl_until: 'ttl_until',
        fetched_at: 'fetched_at',
      },
    },
    _fakeDb: fakeDb,
  };
});

describe('cachedLookup', () => {
  it('miss → calls fetcher, persists, returns fromCache=false', async () => {
    const dbModule = (await import('@vibe/db')) as unknown as { _fakeDb: { _rows: Row[] } };
    const { cachedLookup } = await import('./cache.js');
    dbModule._fakeDb._rows.length = 0;
    const fetcher = vi.fn(async () => ({
      canonicalUrl: 'https://example.com/x',
      parsedText: 'hello',
      rawText: '<x>hello</x>',
      metadata: { foo: 'bar' },
    }));
    const out = await cachedLookup('usc', '26-61', fetcher);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(out.fromCache).toBe(false);
    expect(out.cacheAgeSeconds).toBe(0);
    expect(out.parsedText).toBe('hello');
    expect(out.canonicalUrl).toBe('https://example.com/x');
    expect(dbModule._fakeDb._rows).toHaveLength(1);
  });

  it('hit → skips fetcher, returns fromCache=true with positive age', async () => {
    const dbModule = (await import('@vibe/db')) as unknown as { _fakeDb: { _rows: Row[] } };
    const { cachedLookup } = await import('./cache.js');
    const ago = 12345; // seconds
    dbModule._fakeDb._rows.length = 0;
    dbModule._fakeDb._rows.push({
      id: 'cached',
      source: 'usc',
      cache_key: '26-61',
      canonical_url: 'https://example.com/x',
      raw_text: null,
      parsed_text: 'cached body',
      metadata: { foo: 'bar' },
      fetched_at: new Date(Date.now() - ago * 1000),
      ttl_until: new Date(Date.now() + 60_000),
      upstream_status: '200',
      upstream_etag: null,
      upstream_last_modified: null,
    });
    const fetcher = vi.fn();
    const out = await cachedLookup('usc', '26-61', fetcher as never);
    expect(fetcher).not.toHaveBeenCalled();
    expect(out.fromCache).toBe(true);
    expect(out.cacheAgeSeconds).toBeGreaterThanOrEqual(ago - 1);
    expect(out.parsedText).toBe('cached body');
  });

  it('TTL constants follow BUILD_PLAN §34', async () => {
    const { TTL_SECONDS } = await import('./cache.js');
    expect(TTL_SECONDS.usc).toBe(30 * 24 * 60 * 60);
    expect(TTL_SECONDS.cfr).toBe(30 * 24 * 60 * 60);
    expect(TTL_SECONDS.irb).toBe(30 * 24 * 60 * 60);
    expect(TTL_SECONDS.fr).toBe(24 * 60 * 60);
    expect(TTL_SECONDS.dawson).toBe(7 * 24 * 60 * 60);
    expect(TTL_SECONDS.state_dor).toBe(7 * 24 * 60 * 60);
    expect(TTL_SECONDS.pl).toBe(90 * 24 * 60 * 60);
  });
});
