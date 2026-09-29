import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Scripted attempts: each entry is the event list one stream yields, optionally
// ending in a thrown error — the shape of a mid-stream SSE `error` event.
interface Attempt {
  events: Array<Record<string, unknown>>;
  fail?: Error;
}
const attempts: Attempt[] = [];
const streamCalls = vi.fn();

vi.mock('./client.js', () => ({
  getAnthropic: async () => ({
    client: {
      beta: {
        messages: {
          stream: (body: unknown) => {
            streamCalls(body);
            const attempt = attempts.shift();
            if (!attempt) throw new Error('test script exhausted');
            return {
              async *[Symbol.asyncIterator]() {
                for (const ev of attempt.events) yield ev;
                if (attempt.fail) throw attempt.fail;
              },
              finalMessage: async () => ({
                stop_reason: 'end_turn',
                usage: { input_tokens: 10, output_tokens: 5 },
              }),
            };
          },
        },
      },
    },
  }),
}));

const { streamChat, STREAM_MAX_ATTEMPTS } = await import('./chat.js');

const SANDBOX_DOWN = () =>
  new Error(
    '{"type":"error","error":{"details":null,"type":"overloaded_error","message":"Code execution container setup is temporarily unavailable. Please try again."},"request_id":"req_test" }',
  );

const OK: Attempt = {
  events: [
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Answer.' } },
    { type: 'message_stop' },
  ],
};

const opts = {
  chat_id: 'chat-1',
  user_message: 'Can we expense hearing aids?',
  system_prompt: 'sys',
  model_id: 'claude-sonnet-4-6',
  attached_skill_ids: [],
  enable_web_tools: false,
  history: [],
};

async function collect() {
  const out: Array<{ type: string }> = [];
  const run = (async () => {
    for await (const ev of streamChat(opts)) out.push(ev);
  })();
  // Surface a rejection to the caller without an unhandled-rejection warning
  // while the fake timers are being advanced.
  const settled = run.then(
    () => null,
    (err: unknown) => err as Error,
  );
  await vi.runAllTimersAsync();
  return { out, error: await settled };
}

beforeEach(() => {
  attempts.length = 0;
  streamCalls.mockClear();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('streamChat — transient upstream failures', () => {
  it('retries a sandbox outage that hits before any output', async () => {
    attempts.push({ events: [], fail: SANDBOX_DOWN() }, OK);
    const { out, error } = await collect();
    expect(error).toBeNull();
    expect(streamCalls).toHaveBeenCalledTimes(2);
    expect(out.map((e) => e.type)).toEqual(['text_delta', 'message_stop']);
  });

  it('gives up after the attempt cap and surfaces the original error', async () => {
    for (let i = 0; i < STREAM_MAX_ATTEMPTS + 1; i += 1) {
      attempts.push({ events: [], fail: SANDBOX_DOWN() });
    }
    const { out, error } = await collect();
    expect(error?.message).toContain('overloaded_error');
    expect(streamCalls).toHaveBeenCalledTimes(STREAM_MAX_ATTEMPTS);
    expect(out).toEqual([]);
  });

  it('never retries once text has reached the caller', async () => {
    attempts.push({ events: [OK.events[0]!], fail: SANDBOX_DOWN() }, OK);
    const { out, error } = await collect();
    expect(error?.message).toContain('overloaded_error');
    expect(streamCalls).toHaveBeenCalledTimes(1);
    // One delta, not two: a second attempt would have duplicated the text.
    expect(out.map((e) => e.type)).toEqual(['text_delta']);
  });

  it('does not retry a failure that another attempt cannot fix', async () => {
    attempts.push(
      { events: [], fail: Object.assign(new Error('401 bad key'), { status: 401 }) },
      OK,
    );
    const { error } = await collect();
    expect(error?.message).toContain('401');
    expect(streamCalls).toHaveBeenCalledTimes(1);
  });
});
