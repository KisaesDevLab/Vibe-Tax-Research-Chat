// Phase 32 — VoyageEmbeddingsClient transport contract.
//
// We can't call the real endpoint in CI, so we stub global fetch and
// assert the request shape matches Voyage's documented schema, plus the
// response handling normalizes order, surfaces token counts, and treats
// non-2xx as a hard error.
import { describe, expect, it, beforeAll, vi, afterEach } from 'vitest';
import crypto from 'node:crypto';

beforeAll(() => {
  process.env.MASTER_KEY = crypto.randomBytes(32).toString('hex');
  process.env.JWT_SECRET = crypto.randomBytes(64).toString('hex');
  process.env.JWT_REFRESH_SECRET = crypto.randomBytes(64).toString('hex');
  process.env.DATABASE_URL = 'postgres://x/x';
  process.env.REDIS_URL = 'redis://localhost:6389';
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('VoyageEmbeddingsClient', () => {
  it('rejects construction without an API key', async () => {
    const { VoyageEmbeddingsClient } = await import('./voyage.js');
    expect(() => new VoyageEmbeddingsClient('')).toThrow(/EMBEDDINGS_API_KEY is required/);
  });

  it('sends the documented request shape and parses the response', async () => {
    const { VoyageEmbeddingsClient } = await import('./voyage.js');
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify({
          data: [
            { embedding: [0.1, 0.2], index: 1 },
            { embedding: [0.3, 0.4], index: 0 },
          ],
          model: 'voyage-3-large',
          usage: { total_tokens: 17 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fakeFetch);

    const client = new VoyageEmbeddingsClient('vk-test', 'voyage-3-large');
    const out = await client.embed(['hello', 'world'], 'document');

    // Order: response was returned out of order; client must sort by index
    expect(out.vectors).toEqual([
      [0.3, 0.4],
      [0.1, 0.2],
    ]);
    expect(out.inputTokens).toBe(17);
    expect(out.model).toBe('voyage-3-large');

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.voyageai.com/v1/embeddings');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer vk-test');
    const body = JSON.parse(calls[0]!.init.body as string) as Record<string, unknown>;
    expect(body.model).toBe('voyage-3-large');
    expect(body.input_type).toBe('document');
    expect(body.input).toEqual(['hello', 'world']);
  });

  it('throws on non-2xx with a helpful message', async () => {
    const { VoyageEmbeddingsClient } = await import('./voyage.js');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('invalid api key', { status: 401 })),
    );
    const client = new VoyageEmbeddingsClient('vk-bad');
    await expect(client.embed(['hi'], 'document')).rejects.toThrow(/Voyage embeddings 401/);
  });

  it('short-circuits on empty input without calling the API', async () => {
    const { VoyageEmbeddingsClient } = await import('./voyage.js');
    const fakeFetch = vi.fn();
    vi.stubGlobal('fetch', fakeFetch);
    const client = new VoyageEmbeddingsClient('vk-test');
    const out = await client.embed([], 'query');
    expect(out.vectors).toEqual([]);
    expect(out.inputTokens).toBe(0);
    expect(fakeFetch).not.toHaveBeenCalled();
  });
});
