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
