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

  it('validateAiModeEnv refuses router without URL+token', () => {
    delete process.env.VIBE_AI_TOKEN;
    expect(validateAiModeEnv()).toMatch(/requires both/);
    process.env.VIBE_AI_MODE = 'direct';
    expect(validateAiModeEnv()).toBeNull();
  });

  it('strategy-watch is pinned direct (server-side web_search); all other jobs route', () => {
    expect(jobRoutable('strategy-watch')).toBe(false);
    expect(JOB_TASK_CLASS['strategy-watch']).toBeNull();
    for (const [job, cls] of Object.entries(JOB_TASK_CLASS)) {
      if (job !== 'strategy-watch') expect(cls, job).toBeTruthy();
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

  it('router failure surfaces to the caller and audits — never falls back', async () => {
    _setRouterClientForTests(
      clientWithFetch(
        (async () =>
          new Response(
            JSON.stringify({ error: { code: 'policy_blocked', message: 'no policy' } }),
            { status: 403 },
          )) as typeof fetch,
      ),
    );
    await expect(
      callClaudeViaRouter('plan-memo', { messages: [{ role: 'user', content: 'memo' }] }),
    ).rejects.toThrow(/no policy/);
    const auditCalls = vi.mocked(audit).mock.calls;
    const failure = auditCalls.find((c) => (c[0].metadata as { failed?: boolean }).failed);
    expect(failure).toBeTruthy();
    expect((failure![0].metadata as { backend: string }).backend).toBe('vibe_router');
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
  it('declares the three classes in router mode only', async () => {
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
      'taxresearch_memo_draft',
    ]);

    process.env.VIBE_AI_MODE = 'direct';
    registerTrcTaskClasses({ client, maxAttempts: 1 });
    await new Promise((r) => setTimeout(r, 30));
    expect(calls.length).toBe(1);
  });
});
