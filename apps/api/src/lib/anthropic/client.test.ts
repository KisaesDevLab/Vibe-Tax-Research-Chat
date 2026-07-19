// TP-13 — seam tests: kill switch, Shield routing, budget clamp,
// retry/backoff, and the mandatory claude.call audit rows.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';

const getSetting = vi.fn(async () => 'sk-ant-test-key-000000000000');
const auditSpy = vi.fn(async (_event: unknown) => {});
const messagesCreate = vi.fn();
let capturedClientOptions: Record<string, unknown> | null = null;

vi.mock('../settings-store.js', () => ({
  getSetting: (...a: unknown[]) => getSetting(...(a as [])),
}));
vi.mock('../audit.js', () => ({ audit: (e: unknown) => auditSpy(e) }));
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = { create: messagesCreate };
    constructor(opts: Record<string, unknown>) {
      capturedClientOptions = opts;
    }
  },
}));

function okResponse(text = 'hello') {
  return {
    content: [{ type: 'text', text }],
    usage: { input_tokens: 10, output_tokens: 5 },
    stop_reason: 'end_turn',
  };
}

beforeEach(() => {
  vi.resetModules();
  messagesCreate.mockReset();
  auditSpy.mockClear();
  getSetting.mockClear();
  capturedClientOptions = null;
  process.env.MASTER_KEY = crypto.randomBytes(32).toString('hex');
  delete process.env.ANTHROPIC_KILL_SWITCH;
  delete process.env.SHIELD_URL;
});
afterEach(() => {
  delete process.env.ANTHROPIC_KILL_SWITCH;
  delete process.env.SHIELD_URL;
});

async function seam() {
  return import('./client.js');
}

describe('kill switch', () => {
  it('getAnthropic throws a typed claude_disabled error', async () => {
    process.env.ANTHROPIC_KILL_SWITCH = '1';
    const { getAnthropic, ClaudeDisabledError } = await seam();
    await expect(getAnthropic()).rejects.toBeInstanceOf(ClaudeDisabledError);
    expect(getSetting).not.toHaveBeenCalled();
  });

  it('callClaude is blocked before any network attempt', async () => {
    process.env.ANTHROPIC_KILL_SWITCH = 'true';
    const { callClaude } = await seam();
    await expect(
      callClaude('chat-title', { messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toMatchObject({ code: 'claude_disabled' });
    expect(messagesCreate).not.toHaveBeenCalled();
  });
});

describe('shield routing', () => {
  it('SHIELD_URL becomes the client baseURL (trailing slash stripped)', async () => {
    process.env.SHIELD_URL = 'https://shield.internal:8443/';
    const { getAnthropic } = await seam();
    await getAnthropic();
    expect(capturedClientOptions?.baseURL).toBe('https://shield.internal:8443');
  });

  it('unset SHIELD_URL leaves the default endpoint', async () => {
    const { getAnthropic } = await seam();
    await getAnthropic();
    expect(capturedClientOptions?.baseURL).toBeUndefined();
  });
});

describe('budget clamp + model pin', () => {
  it('clamps a runaway max_tokens request to the job budget', async () => {
    messagesCreate.mockResolvedValueOnce(okResponse());
    const { callClaude } = await seam();
    await callClaude('chat-title', {
      max_tokens: 999_999,
      messages: [{ role: 'user', content: 'title me' }],
    });
    const body = messagesCreate.mock.calls[0]![0] as { model: string; max_tokens: number };
    expect(body.model).toBe('claude-haiku-4-5');
    expect(body.max_tokens).toBe(64);
  });

  it('honors a smaller-than-budget request', async () => {
    messagesCreate.mockResolvedValueOnce(okResponse());
    const { callClaude } = await seam();
    await callClaude('strategy-author', {
      max_tokens: 2_000,
      messages: [{ role: 'user', content: 'draft' }],
    });
    const body = messagesCreate.mock.calls[0]![0] as { max_tokens: number };
    expect(body.max_tokens).toBe(2_000);
  });
});

describe('retry with backoff', () => {
  it('retries a 429 then succeeds', async () => {
    messagesCreate
      .mockRejectedValueOnce(Object.assign(new Error('rate limited'), { status: 429 }))
      .mockResolvedValueOnce(okResponse('after retry'));
    const { callClaude } = await seam();
    const r = await callClaude('chat-title', { messages: [{ role: 'user', content: 'x' }] });
    expect(r.text).toBe('after retry');
    expect(messagesCreate).toHaveBeenCalledTimes(2);
  }, 15_000);

  it('does not retry a 400', async () => {
    messagesCreate.mockRejectedValue(Object.assign(new Error('bad request'), { status: 400 }));
    const { callClaude } = await seam();
    await expect(
      callClaude('chat-title', { messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toThrow('bad request');
    expect(messagesCreate).toHaveBeenCalledTimes(1);
  });
});

describe('audit rows', () => {
  it('writes claude.call with request/response hashes, never payloads', async () => {
    messagesCreate.mockResolvedValueOnce(okResponse('SECRET-PAYLOAD'));
    const { callClaude } = await seam();
    const r = await callClaude('attachment-summarize', {
      messages: [{ role: 'user', content: 'SENSITIVE-DOCUMENT' }],
    });
    expect(auditSpy).toHaveBeenCalledTimes(1);
    const event = auditSpy.mock.calls[0]![0] as {
      action: string;
      target_id: string;
      metadata: Record<string, unknown>;
    };
    expect(event.action).toBe('claude.call');
    expect(event.target_id).toBe('attachment-summarize');
    expect(event.metadata.request_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(event.metadata.response_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(event.metadata.input_tokens).toBe(10);
    expect(JSON.stringify(event)).not.toContain('SENSITIVE-DOCUMENT');
    expect(JSON.stringify(event)).not.toContain('SECRET-PAYLOAD');
    expect(r.request_hash).toBe(event.metadata.request_hash);
  });

  it('a terminal failure still leaves an audit trail', async () => {
    messagesCreate.mockRejectedValue(Object.assign(new Error('boom'), { status: 400 }));
    const { callClaude } = await seam();
    await expect(
      callClaude('chat-title', { messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toThrow('boom');
    const event = auditSpy.mock.calls.at(-1)![0] as { metadata: Record<string, unknown> };
    expect(event.metadata.failed).toBe(true);
    expect(event.metadata.error).toBe('boom');
  });
});
