// MIG-4 — router-mode seam tests. Mirrors client.test.ts style: everything
// mocked at module boundaries, wire contract asserted via injected client.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VibeAiClient } from '@kisaes/vibe-ai-client';

vi.mock('../audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { audit } from '../audit.js';
import {
  JOB_TASK_CLASS,
  TRC_TASK_CLASSES,
  _setRouterClientForTests,
  aiMode,
  callClaudeViaRouter,
  jobRoutable,
  registerTrcTaskClasses,
  routerEnvConfigured,
  setAiModeOverride,
  testRouterConnection,
  validateAiModeEnv,
} from './router-mode.js';

const ENV_KEYS = ['VIBE_AI_MODE', 'VIBE_AI_ROUTER_URL', 'VIBE_AI_TOKEN'] as const;
let savedEnv: Record<string, string | undefined>;

function clientWithFetch(fn: typeof fetch): VibeAiClient {
  return new VibeAiClient({ baseUrl: 'http://router.test:8220', token: 'tok', fetch: fn });
}

function completionResponse(body?: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({
      model: 'ollama/qwen3:14b',
      choices: [{ message: { content: 'router says hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 4 },
      ...body,
    }),
    { status: 200, headers: { 'content-type': 'application/json', 'x-request-id': 'req_r1' } },
  );
}

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.VIBE_AI_MODE = 'router';
  process.env.VIBE_AI_ROUTER_URL = 'http://router.test:8220';
  process.env.VIBE_AI_TOKEN = 'tok';
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  _setRouterClientForTests(null);
  setAiModeOverride(null);
  vi.clearAllMocks();
});

describe('mode + routability', () => {
  it('aiMode reads the env; anything but "router" is direct', () => {
    expect(aiMode()).toBe('router');
    process.env.VIBE_AI_MODE = 'direct';
    expect(aiMode()).toBe('direct');
    delete process.env.VIBE_AI_MODE;
    expect(aiMode()).toBe('direct');
  });

  it('the admin override (DB-backed) outranks the env default', () => {
    process.env.VIBE_AI_MODE = 'direct';
    setAiModeOverride('router');
    expect(aiMode()).toBe('router');
    setAiModeOverride('direct');
    expect(aiMode()).toBe('direct');
    setAiModeOverride(null);
    expect(aiMode()).toBe('direct');
  });

  it('routerEnvConfigured requires both URL and token', () => {
    expect(routerEnvConfigured()).toBe(true);
    delete process.env.VIBE_AI_TOKEN;
    expect(routerEnvConfigured()).toBe(false);
  });

  it('validateAiModeEnv refuses router without URL+token', () => {
    delete process.env.VIBE_AI_TOKEN;
    expect(validateAiModeEnv()).toMatch(/requires both/);
    process.env.VIBE_AI_MODE = 'direct';
    expect(validateAiModeEnv()).toBeNull();
  });

  it('web-search jobs are pinned direct; all other jobs route', () => {
    const PINNED_DIRECT = ['strategy-watch', 'tables-draft'];
    for (const job of PINNED_DIRECT) {
      expect(jobRoutable(job as never), job).toBe(false);
      expect(JOB_TASK_CLASS[job as never], job).toBeNull();
    }
    for (const [job, cls] of Object.entries(JOB_TASK_CLASS)) {
      if (!PINNED_DIRECT.includes(job)) expect(cls, job).toBeTruthy();
    }
  });
});

describe('callClaudeViaRouter', () => {
  it('sends the mapped task class, clamps tokens, forwards attribution — and NO model', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    _setRouterClientForTests(
      clientWithFetch((async (url: unknown, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} });
        return completionResponse();
      }) as typeof fetch),
    );

    const result = await callClaudeViaRouter(
      'chat-title',
      { max_tokens: 9999, system: 'sys', messages: [{ role: 'user', content: 'title this' }] },
      { actorUserId: 'user-7' },
    );

    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['x-vibe-task-class']).toBe(TRC_TASK_CLASSES.CONTENT_META);
    expect(headers['x-vibe-user']).toBe('user-7');
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.model).toBeUndefined();
    expect(body.max_tokens).toBe(64); // clamped to the chat-title job budget
    expect(body.messages[0]).toEqual({ role: 'system', content: 'sys' });

    expect(result.text).toBe('router says hi');
    expect(result.response.usage.input_tokens).toBe(10);
    expect(result.response.stop_reason).toBe('end_turn');
    expect(result.request_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('translates forced tool_choice and synthesizes tool_use blocks (skill-author shape)', async () => {
    const calls: { init: RequestInit }[] = [];
    _setRouterClientForTests(
      clientWithFetch((async (_url: unknown, init?: RequestInit) => {
        calls.push({ init: init ?? {} });
        return completionResponse({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: 'tc1',
                    function: {
                      name: 'propose_skill_draft',
                      arguments: '{"name":"basis-tracking"}',
                    },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        });
      }) as typeof fetch),
    );

    const result = await callClaudeViaRouter('skill-author', {
      system: 'draft it',
      tools: [{ name: 'propose_skill_draft', description: 'd', input_schema: { type: 'object' } }],
      tool_choice: { type: 'tool', name: 'propose_skill_draft' },
      messages: [{ role: 'user', content: 'doc text' }],
    });

    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.tools[0].function.name).toBe('propose_skill_draft');
    expect(body.tool_choice).toEqual({
      type: 'function',
      function: { name: 'propose_skill_draft' },
    });

    const toolUse = result.response.content.find((b) => b.type === 'tool_use');
    expect(toolUse).toBeTruthy();
    expect((toolUse as { input: unknown }).input).toEqual({ name: 'basis-tracking' });
    expect(result.response.stop_reason).toBe('tool_use');
  });

  it('refuses to route a non-routable job or untranslatable content', async () => {
    await expect(
      callClaudeViaRouter('strategy-watch', { messages: [{ role: 'user', content: 'scan' }] }),
    ).rejects.toThrow(/not routable/);

    _setRouterClientForTests(clientWithFetch((async () => completionResponse()) as typeof fetch));
    await expect(
      callClaudeViaRouter('chat-title', {
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: 'x' },
              } as never,
            ],
          },
        ],
      }),
    ).rejects.toThrow(/cannot translate content block/);
  });

  it('router failure surfaces to the caller and audits — never falls back, never retried', async () => {
    let fetches = 0;
    _setRouterClientForTests(
      clientWithFetch((async () => {
        fetches += 1;
        return new Response(
          JSON.stringify({ error: { code: 'policy_blocked', message: 'no policy' } }),
          { status: 403 },
        );
      }) as typeof fetch),
    );
    await expect(
      callClaudeViaRouter('plan-memo', { messages: [{ role: 'user', content: 'memo' }] }),
    ).rejects.toThrow(/no policy/);
    expect(fetches).toBe(1); // policy_blocked is not retryable
    const auditCalls = vi.mocked(audit).mock.calls;
    const failures = auditCalls.filter((c) => (c[0].metadata as { failed?: boolean }).failed);
    expect(failures).toHaveLength(1);
    expect((failures[0]![0].metadata as { backend: string }).backend).toBe('vibe_router');
  });

  it('bounds every request with an AbortSignal (A3)', async () => {
    const calls: { init: RequestInit }[] = [];
    _setRouterClientForTests(
      clientWithFetch((async (_url: unknown, init?: RequestInit) => {
        calls.push({ init: init ?? {} });
        return completionResponse();
      }) as typeof fetch),
    );
    await callClaudeViaRouter('chat-title', { messages: [{ role: 'user', content: 'x' }] });
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('a hung router fails within the overall deadline — no retries past it (A3)', async () => {
    let fetches = 0;
    _setRouterClientForTests(
      clientWithFetch(((_url: unknown, init?: RequestInit) => {
        fetches += 1;
        // Hang until the timeout signal fires, like a stalled router.
        return new Promise((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason));
        });
      }) as unknown as typeof fetch),
    );
    const startedAt = Date.now();
    await expect(
      callClaudeViaRouter(
        'chat-title',
        { messages: [{ role: 'user', content: 'x' }] },
        { timeoutMs: 30 },
      ),
    ).rejects.toThrow();
    // The first attempt consumes the whole deadline; there is no budget left
    // to retry, so timeoutMs stays a hard bound on the logical call.
    expect(fetches).toBe(1);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    const failures = vi
      .mocked(audit)
      .mock.calls.filter((c) => (c[0].metadata as { failed?: boolean }).failed);
    expect(failures).toHaveLength(1);
    expect((failures[0]![0].metadata as { attempts: number }).attempts).toBe(1);
  });

  it('retries a 5xx with a non-JSON body (VibeAiError code "unknown"), then succeeds', async () => {
    let fetches = 0;
    _setRouterClientForTests(
      clientWithFetch((async () => {
        fetches += 1;
        if (fetches === 1) {
          return new Response('<html>bad gateway</html>', { status: 502 });
        }
        return completionResponse();
      }) as typeof fetch),
    );
    const result = await callClaudeViaRouter('chat-title', {
      messages: [{ role: 'user', content: 'x' }],
    });
    expect(fetches).toBe(2);
    expect(result.text).toBe('router says hi');
  }, 15_000);

  it('does NOT retry deterministic failures (malformed 200 body)', async () => {
    let fetches = 0;
    _setRouterClientForTests(
      clientWithFetch((async () => {
        fetches += 1;
        return new Response('<html>not json</html>', { status: 200 });
      }) as typeof fetch),
    );
    await expect(
      callClaudeViaRouter('chat-title', { messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toThrow();
    expect(fetches).toBe(1); // a parse error is not transient — fail fast
  });

  it('treats finish_reason "error" as a failed attempt: retried, then succeeds', async () => {
    let fetches = 0;
    _setRouterClientForTests(
      clientWithFetch((async () => {
        fetches += 1;
        if (fetches === 1) {
          return completionResponse({
            choices: [{ message: { content: '' }, finish_reason: 'error' }],
          });
        }
        return completionResponse();
      }) as typeof fetch),
    );
    const result = await callClaudeViaRouter('chat-title', {
      messages: [{ role: 'user', content: 'x' }],
    });
    expect(fetches).toBe(2);
    expect(result.text).toBe('router says hi');
  }, 15_000);

  it('finish_reason "error" on every attempt fails the call — never a blank success', async () => {
    let fetches = 0;
    _setRouterClientForTests(
      clientWithFetch((async () => {
        fetches += 1;
        return completionResponse({
          choices: [{ message: { content: '' }, finish_reason: 'error' }],
        });
      }) as typeof fetch),
    );
    await expect(
      callClaudeViaRouter('chat-title', { messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toThrow(/finish_reason "error"/);
    expect(fetches).toBe(3);
    const failures = vi
      .mocked(audit)
      .mock.calls.filter((c) => (c[0].metadata as { failed?: boolean }).failed);
    expect(failures).toHaveLength(1); // failed, not a success row with empty text
    expect((failures[0]![0].metadata as { attempts: number }).attempts).toBe(3);
  }, 15_000);

  it('retries rate_limited honoring retry-after, then succeeds (A9)', async () => {
    let fetches = 0;
    _setRouterClientForTests(
      clientWithFetch((async () => {
        fetches += 1;
        if (fetches === 1) {
          return new Response(
            JSON.stringify({ error: { code: 'rate_limited', message: 'slow down' } }),
            { status: 429, headers: { 'retry-after': '0' } },
          );
        }
        return completionResponse();
      }) as typeof fetch),
    );
    const result = await callClaudeViaRouter('chat-title', {
      messages: [{ role: 'user', content: 'x' }],
    });
    expect(fetches).toBe(2);
    expect(result.text).toBe('router says hi');
    const meta = vi.mocked(audit).mock.calls[0]![0].metadata as Record<string, unknown>;
    expect(meta.attempts).toBe(2);
    expect(meta.failed).toBeUndefined();
  });

  it('reports disjoint input vs cache-read tokens (A4)', async () => {
    _setRouterClientForTests(
      clientWithFetch((async () =>
        completionResponse({
          usage: {
            prompt_tokens: 10,
            completion_tokens: 4,
            prompt_tokens_details: { cached_tokens: 6 },
          },
        })) as typeof fetch),
    );
    const result = await callClaudeViaRouter('chat-title', {
      messages: [{ role: 'user', content: 'x' }],
    });
    expect(result.response.usage.input_tokens).toBe(4);
    expect(result.response.usage.cache_read_input_tokens).toBe(6);
    const meta = vi.mocked(audit).mock.calls[0]![0].metadata as Record<string, unknown>;
    expect(meta.input_tokens).toBe(4);
    expect(meta.cache_read_input_tokens).toBe(6);
  });

  it('preserves the content_filter finish reason', async () => {
    _setRouterClientForTests(
      clientWithFetch((async () =>
        completionResponse({
          choices: [{ message: { content: 'partial' }, finish_reason: 'content_filter' }],
        })) as typeof fetch),
    );
    const result = await callClaudeViaRouter('chat-title', {
      messages: [{ role: 'user', content: 'x' }],
    });
    expect(result.response.stop_reason).toBe('content_filter');
  });

  it('audit rows carry hashes and dims, never payload text', async () => {
    _setRouterClientForTests(clientWithFetch((async () => completionResponse()) as typeof fetch));
    await callClaudeViaRouter('plan-memo', {
      messages: [{ role: 'user', content: 'SECRET CLIENT FACTS' }],
    });
    const meta = vi.mocked(audit).mock.calls[0]![0].metadata as Record<string, unknown>;
    expect(meta.backend).toBe('vibe_router');
    expect(meta.task_class).toBe(TRC_TASK_CLASSES.MEMO_DRAFT);
    expect(JSON.stringify(meta)).not.toContain('SECRET CLIENT FACTS');
  });
});

describe('registerTrcTaskClasses', () => {
  it('declares the four classes in router mode only', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const client = clientWithFetch((async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ registered: [] }), { status: 200 });
    }) as typeof fetch);

    registerTrcTaskClasses({ client, maxAttempts: 1 });
    await new Promise((r) => setTimeout(r, 30));
    expect(calls[0]!.url).toContain('/v1/task-classes/register');
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.app).toBe('vibe-tax-research');
    expect(body.classes.map((c: { key: string }) => c.key).sort()).toEqual([
      'taxresearch_authoring',
      'taxresearch_content_meta',
      'taxresearch_fact_extract',
      'taxresearch_memo_draft',
    ]);

    process.env.VIBE_AI_MODE = 'direct';
    registerTrcTaskClasses({ client, maxAttempts: 1 });
    await new Promise((r) => setTimeout(r, 30));
    expect(calls.length).toBe(1);
  });
});

describe('testRouterConnection', () => {
  it('reports ok with latency and registered count on success', async () => {
    const client = clientWithFetch(
      (async () =>
        new Response(
          JSON.stringify({
            registered: [
              { key: 'taxresearch_memo_draft', created: false, sensitivity: 'cloud_deidentified' },
              { key: 'taxresearch_content_meta', created: false, sensitivity: 'local_only' },
              { key: 'taxresearch_authoring', created: false, sensitivity: 'local_only' },
            ],
          }),
          { status: 200 },
        )) as typeof fetch,
    );
    const result = await testRouterConnection({ client });
    expect(result.ok).toBe(true);
    expect(result.registered).toBe(3);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('reports a router error verdict without throwing', async () => {
    const client = clientWithFetch(
      (async () =>
        new Response(JSON.stringify({ error: { code: 'auth_error', message: 'bad token' } }), {
          status: 401,
        })) as typeof fetch,
    );
    const result = await testRouterConnection({ client });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/401|auth/i);
  });

  it('fails fast when the router env is not configured', async () => {
    delete process.env.VIBE_AI_ROUTER_URL;
    const result = await testRouterConnection();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/VIBE_AI_ROUTER_URL/);
  });
});
