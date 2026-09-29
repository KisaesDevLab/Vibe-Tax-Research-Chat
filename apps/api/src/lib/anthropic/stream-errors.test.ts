import { describe, it, expect } from 'vitest';
import { describeStreamError, isAutoRetryable, streamErrorNote } from './stream-errors.js';

// The exact payload a researcher saw printed into the transcript: a mid-stream
// SSE `error` event, which the SDK raises with no status and the raw JSON as
// the message.
const SANDBOX_SSE =
  '{"type":"error","error":{"details":null,"type":"overloaded_error","message":"Code execution container setup is temporarily unavailable. Please try again."},"request_id":"req_011CfXt7KAzbkMMy4tCqnSwa" }';

describe('describeStreamError', () => {
  it('names the code-execution sandbox for a container-setup overload', () => {
    const info = describeStreamError(new Error(SANDBOX_SSE));
    expect(info.kind).toBe('sandbox_unavailable');
    expect(info.retryable).toBe(true);
    expect(info.requestId).toBe('req_011CfXt7KAzbkMMy4tCqnSwa');
    expect(isAutoRetryable(info)).toBe(true);
  });

  it('never leaks the raw payload into the note, and invites a re-send', () => {
    const note = streamErrorNote(describeStreamError(new Error(SANDBOX_SSE)));
    expect(note).not.toContain('{');
    expect(note).not.toContain('overloaded_error');
    expect(note).toContain('req_011CfXt7KAzbkMMy4tCqnSwa');
    // The web client keys its "Re-send question" button on this wording.
    expect(note).toMatch(/re-?send|retry/i);
  });

  it('classifies a plain overload from an HTTP-level error body', () => {
    const err = Object.assign(new Error('529 {"type":"error"}'), {
      status: 529,
      error: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
    });
    expect(describeStreamError(err).kind).toBe('overloaded');
  });

  it('parses a status-prefixed message when no parsed body is attached', () => {
    const err = Object.assign(
      new Error('429 {"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}'),
      { status: 429 },
    );
    const info = describeStreamError(err);
    expect(info.kind).toBe('rate_limited');
    expect(info.retryable).toBe(true);
    // Re-sendable by a person after a wait, but not from a retry loop.
    expect(isAutoRetryable(info)).toBe(false);
  });

  it('does not offer a re-send for failures a re-send cannot fix', () => {
    const auth = describeStreamError(Object.assign(new Error('401 nope'), { status: 401 }));
    expect(auth.kind).toBe('auth');
    expect(auth.retryable).toBe(false);
    expect(streamErrorNote(auth)).not.toMatch(/re-?send|retry|try again/i);

    const disabled = describeStreamError(
      Object.assign(new Error('Claude calls are disabled'), { code: 'claude_disabled' }),
    );
    expect(disabled.kind).toBe('disabled');
    expect(streamErrorNote(disabled)).not.toMatch(/re-?send|retry|try again/i);

    const noKey = describeStreamError(new Error('Anthropic API key is not configured.'));
    expect(noKey.kind).toBe('not_configured');
    expect(noKey.retryable).toBe(false);
  });

  it('treats a status-less, body-less failure as a connection error', () => {
    const info = describeStreamError(new Error('Connection error.'));
    expect(info.kind).toBe('network');
    expect(isAutoRetryable(info)).toBe(true);
  });

  it('survives non-Error throwables', () => {
    expect(describeStreamError(undefined).kind).toBe('network');
    expect(describeStreamError('boom').kind).toBe('network');
  });
});
