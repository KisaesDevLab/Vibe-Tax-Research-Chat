// Phase 34 — server dispatcher behavior. Covers /tools/list, unknown
// tool, bad input, NotImplementedError → 501, UpstreamFetchError → 502.
// Real upstream fetches are stubbed via global fetch; the cache layer
// is exercised indirectly via the implemented tool handlers.
import { describe, it, expect, beforeAll, vi, afterEach } from 'vitest';
import request from 'supertest';

beforeAll(() => {
  process.env.DATABASE_URL = 'postgres://x/x';
});

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});

vi.mock('@vibe/db', () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({ orderBy: () => ({ limit: async () => [] }) }),
      }),
    }),
    insert: () => ({ values: async () => undefined }),
    execute: async () => [{ '?column?': 1 }],
  }),
  schema: {
    authority_cache: {
      source: 'source',
      cache_key: 'cache_key',
      ttl_until: 'ttl_until',
      fetched_at: 'fetched_at',
    },
  },
}));

describe('authority-mcp server', () => {
  it('GET /health returns 200', async () => {
    const { createServer } = await import('./server.js');
    const app = createServer();
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('GET /tools/list lists every tool with implemented flag', async () => {
    const { createServer } = await import('./server.js');
    const app = createServer();
    const res = await request(app).get('/tools/list');
    expect(res.status).toBe(200);
    const names = (res.body.tools as Array<{ name: string; implemented: boolean }>).map(
      (t) => t.name,
    );
    expect(names).toEqual(
      expect.arrayContaining([
        'usc_lookup',
        'cfr_lookup',
        'fr_search',
        'dawson_search',
        'irb_lookup',
        'pl_lookup',
        'state_dor_search',
      ]),
    );
    const usc = (res.body.tools as Array<{ name: string; implemented: boolean }>).find(
      (t) => t.name === 'usc_lookup',
    );
    expect(usc?.implemented).toBe(true);
    const fr = (res.body.tools as Array<{ name: string; implemented: boolean }>).find(
      (t) => t.name === 'fr_search',
    );
    expect(fr?.implemented).toBe(false);
  });

  it('POST /tools/<unknown> → 404', async () => {
    const { createServer } = await import('./server.js');
    const app = createServer();
    const res = await request(app).post('/tools/does_not_exist').send({});
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('unknown_tool');
  });

  it('POST /tools/usc_lookup with bad input → 400', async () => {
    const { createServer } = await import('./server.js');
    const app = createServer();
    const res = await request(app).post('/tools/usc_lookup').send({ section: '' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('bad_input');
  });

  it('POST /tools/fr_search → 501 not_implemented', async () => {
    const { createServer } = await import('./server.js');
    const app = createServer();
    const res = await request(app).post('/tools/fr_search').send({ query: 'irs' });
    expect(res.status).toBe(501);
    expect(res.body.error).toBe('not_implemented');
    expect(res.body.tool).toBe('fr_search');
  });

  it('POST /tools/usc_lookup hits the real handler with a stubbed upstream', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<html><body><p>Section text here.</p></body></html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
    );
    const { createServer } = await import('./server.js');
    const app = createServer();
    const res = await request(app).post('/tools/usc_lookup').send({ title: 26, section: '61' });
    expect(res.status).toBe(200);
    expect(res.body.result.cite).toBe('26 U.S.C. § 61');
    expect(res.body.result.text).toContain('Section text here.');
    expect(res.body.result.fromCache).toBe(false);
  });

  it('POST /tools/usc_lookup → 502 when upstream rejects', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('bot blocked', { status: 403 })),
    );
    const { createServer } = await import('./server.js');
    const app = createServer();
    const res = await request(app).post('/tools/usc_lookup').send({ title: 26, section: '61' });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('upstream_failed');
  });
});
