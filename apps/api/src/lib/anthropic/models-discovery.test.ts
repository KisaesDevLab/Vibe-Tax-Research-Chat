import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const { getSettingMock } = vi.hoisted(() => ({ getSettingMock: vi.fn() }));
vi.mock('../settings-store.js', () => ({
  getSetting: getSettingMock,
}));

import { discoverAnthropicModels } from './models-discovery.js';

const ORIGINAL_FETCH = globalThis.fetch;

beforeEach(() => {
  getSettingMock.mockReset();
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

function mockFetchOnce(handler: (input: FetchInput) => Response | Promise<Response>): void {
  globalThis.fetch = vi.fn(async (input: FetchInput) => handler(input)) as typeof fetch;
}

describe('discoverAnthropicModels', () => {
  it('returns anthropic_api_key_not_set when no key is configured', async () => {
    getSettingMock.mockResolvedValue(null);
    const r = await discoverAnthropicModels();
    expect(r.ok).toBe(false);
    expect(r.error).toBe('anthropic_api_key_not_set');
    expect(r.models).toEqual([]);
  });

  it('returns the data array on a single-page success', async () => {
    getSettingMock.mockResolvedValue('sk-ant-test');
    mockFetchOnce(async () =>
      Response.json({
        data: [
          {
            id: 'claude-opus-4-7',
            display_name: 'Claude Opus 4.7',
            created_at: '2026-04-01T00:00:00Z',
            max_input_tokens: 1_000_000,
            max_tokens: 128_000,
            capabilities: { thinking: { supported: false } },
            type: 'model',
          },
          {
            id: 'claude-sonnet-4-6',
            display_name: 'Claude Sonnet 4.6',
            created_at: '2026-02-01T00:00:00Z',
            max_input_tokens: 1_000_000,
            max_tokens: 64_000,
            capabilities: { thinking: { supported: true } },
            type: 'model',
          },
        ],
        has_more: false,
        first_id: 'claude-opus-4-7',
        last_id: 'claude-sonnet-4-6',
      }),
    );
    const r = await discoverAnthropicModels();
    expect(r.ok).toBe(true);
    expect(r.models).toHaveLength(2);
    expect(r.models[0]!.id).toBe('claude-opus-4-7');
    expect(r.models[1]!.id).toBe('claude-sonnet-4-6');
  });

  it('paginates with after_id when has_more=true', async () => {
    getSettingMock.mockResolvedValue('sk-ant-test');
    let call = 0;
    globalThis.fetch = vi.fn(async (input: FetchInput) => {
      const url = new URL(input!.toString());
      const after = url.searchParams.get('after_id');
      call++;
      if (call === 1) {
        expect(after).toBeNull();
        return Response.json({
          data: [{ id: 'a', display_name: 'A', created_at: '2026-01-01T00:00:00Z' }],
          has_more: true,
          first_id: 'a',
          last_id: 'a',
        });
      }
      expect(after).toBe('a');
      return Response.json({
        data: [{ id: 'b', display_name: 'B', created_at: '2026-01-02T00:00:00Z' }],
        has_more: false,
        first_id: 'b',
        last_id: 'b',
      });
    }) as typeof fetch;

    const r = await discoverAnthropicModels();
    expect(r.ok).toBe(true);
    expect(r.models.map((m) => m.id)).toEqual(['a', 'b']);
    expect(call).toBe(2);
  });

  it('returns ok:false with HTTP status on a non-2xx response', async () => {
    getSettingMock.mockResolvedValue('sk-ant-test');
    mockFetchOnce(async () => new Response('forbidden', { status: 403, statusText: 'Forbidden' }));
    const r = await discoverAnthropicModels();
    expect(r.ok).toBe(false);
    expect(r.error).toContain('HTTP 403');
    expect(r.models).toEqual([]);
  });

  it('returns ok:false on a network error', async () => {
    getSettingMock.mockResolvedValue('sk-ant-test');
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;
    const r = await discoverAnthropicModels();
    expect(r.ok).toBe(false);
    expect(r.error).toContain('ECONNREFUSED');
  });

  it('sends x-api-key and anthropic-version headers', async () => {
    getSettingMock.mockResolvedValue('sk-ant-secret');
    let capturedHeaders: Record<string, string> | undefined;
    globalThis.fetch = vi.fn(async (_input: FetchInput, init?: FetchInit) => {
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      return Response.json({ data: [], has_more: false, first_id: '', last_id: '' });
    }) as typeof fetch;
    await discoverAnthropicModels();
    expect(capturedHeaders).toMatchObject({
      'x-api-key': 'sk-ant-secret',
      'anthropic-version': '2023-06-01',
    });
  });

  it('returns malformed_response_missing_data_array when payload lacks data[]', async () => {
    getSettingMock.mockResolvedValue('sk-ant-test');
    mockFetchOnce(async () =>
      Response.json({ has_more: false, first_id: '', last_id: '' /* no data */ }),
    );
    const r = await discoverAnthropicModels();
    expect(r.ok).toBe(false);
    expect(r.error).toBe('malformed_response_missing_data_array');
  });
});
