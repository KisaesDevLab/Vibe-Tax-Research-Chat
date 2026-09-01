// Error-path coverage for the SSE consumer: the initial fetch can reject
// before any response (offline / DNS / server down / pre-response abort).
// send() is invoked as `void send(...)` by callers, so a throw would become
// an unhandled rejection and hang the UI — it must finish with an error.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useChatStream } from './useChatStream';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useChatStream reset() vs straggling events', () => {
  it('does not resurrect a phantom in-flight turn after reset()', async () => {
    // A body that yields `done`, then keeps the socket open long enough
    // for the page to reset(), then delivers one more event.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(enc.encode('event: text\ndata: {"delta":"hi"}\n\n'));
        controller.enqueue(
          enc.encode('event: done\ndata: {"cost":0.01,"usage":{"output_tokens":3}}\n\n'),
        );
        await gate;
        controller.enqueue(enc.encode('event: usage\ndata: {"input_tokens":9}\n\n'));
        controller.close();
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { status: 200 })),
    );

    const { result } = renderHook(() => useChatStream());
    let sending!: Promise<void>;
    await act(async () => {
      sending = result.current.send('chat-1', 'hello');
      // Let the first two events land.
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(result.current.streaming?.done).toBe(true);

    await act(async () => {
      result.current.reset();
    });
    expect(result.current.streaming).toBeNull();

    await act(async () => {
      release();
      await sending;
    });
    // The straggling usage event must not bring the turn back to life.
    expect(result.current.streaming).toBeNull();
  });
});

describe('useChatStream send() error paths', () => {
  it('finishes with a user-facing error when the initial fetch rejects', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );

    const { result } = renderHook(() => useChatStream());

    // Must not reject — a throw here would be an unhandled rejection for
    // the `void send(...)` callers.
    await act(async () => {
      await expect(result.current.send('chat-1', 'hello')).resolves.toBeUndefined();
    });

    expect(result.current.streaming?.done).toBe(true);
    expect(result.current.streaming?.error).toMatch(/could not reach the server/i);
  });

  it('does not show an error banner when the initial fetch is aborted', async () => {
    const abortErr = new Error('aborted');
    abortErr.name = 'AbortError';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw abortErr;
      }),
    );

    const { result } = renderHook(() => useChatStream());

    await act(async () => {
      await expect(result.current.send('chat-1', 'hello')).resolves.toBeUndefined();
    });

    expect(result.current.streaming?.done).toBe(true);
    expect(result.current.streaming?.error).toBeUndefined();
  });
});
