// Phase 36 — api-side authority-mcp http client.
import { describe, it, expect, beforeAll, vi, afterEach } from 'vitest';
import crypto from 'node:crypto';

beforeAll(() => {
  process.env.MASTER_KEY = crypto.randomBytes(32).toString('hex');
  process.env.JWT_SECRET = crypto.randomBytes(64).toString('hex');
  process.env.JWT_REFRESH_SECRET = crypto.randomBytes(64).toString('hex');
  process.env.DATABASE_URL = 'postgres://x/x';
  process.env.REDIS_URL = 'redis://localhost:6389';
  process.env.AUTHORITY_MCP_URL = 'http://authority-mcp:4100';
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('callAuthorityMcp', () => {
  it('POSTs the input as JSON and returns result', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ result: { cite: '26 U.S.C. § 61', text: 'hello' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );
    const { callAuthorityMcp } = await import('./client.js');
    const out = await callAuthorityMcp('usc_lookup', { section: '61' });
    expect(out.cite).toBe('26 U.S.C. § 61');
    expect(out.text).toBe('hello');
    expect(calls[0]!.url).toBe('http://authority-mcp:4100/tools/usc_lookup');
    const body = JSON.parse(calls[0]!.init.body as string) as { section: string };
    expect(body.section).toBe('61');
  });

  it('throws AuthorityMcpError on non-2xx with the body attached', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'not_implemented', tool: 'fr_search' }), {
            status: 501,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    );
    const { callAuthorityMcp, AuthorityMcpError } = await import('./client.js');
    await expect(callAuthorityMcp('fr_search', {})).rejects.toBeInstanceOf(AuthorityMcpError);
    try {
      await callAuthorityMcp('fr_search', {});
    } catch (err) {
      const e = err as InstanceType<typeof AuthorityMcpError>;
      expect(e.tool).toBe('fr_search');
      expect(e.status).toBe(501);
      expect((e.body as { error?: string }).error).toBe('not_implemented');
    }
  });

  it('encodes tool name to defend against odd characters in URLs', async () => {
    const calls: Array<{ url: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push({ url });
        return new Response(JSON.stringify({ result: {} }), { status: 200 });
      }),
    );
    const { callAuthorityMcp } = await import('./client.js');
    await callAuthorityMcp('weird/name', {});
    expect(calls[0]!.url).toBe('http://authority-mcp:4100/tools/weird%2Fname');
  });

  it('strips trailing slashes from AUTHORITY_MCP_URL when concatenating', async () => {
    process.env.AUTHORITY_MCP_URL = 'http://authority-mcp:4100/';
    const calls: Array<{ url: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push({ url });
        return new Response(JSON.stringify({ result: {} }), { status: 200 });
      }),
    );
    // Re-import to pick up the env change
    vi.resetModules();
    const { callAuthorityMcp } = await import('./client.js');
    await callAuthorityMcp('usc_lookup', {});
    expect(calls[0]!.url).toBe('http://authority-mcp:4100/tools/usc_lookup');
  });
});
