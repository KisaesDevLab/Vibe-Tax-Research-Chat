// Classifies a failed streaming chat call into something a researcher can
// read and act on.
//
// Two shapes reach us from the SDK:
//   - HTTP-level failure: APIError with `.status` and a parsed `.error` body;
//     the message is "<status> <json>".
//   - Mid-stream failure: the API already answered 200 and then sent an SSE
//     `error` event. The SDK (0.40.1) raises that as an APIConnectionError
//     with NO status and the raw event JSON as the message — so the type has
//     to be recovered by parsing the message.
//
// The raw payload is for the log, never for the transcript.

export type StreamErrorKind =
  | 'sandbox_unavailable'
  | 'overloaded'
  | 'rate_limited'
  | 'upstream_error'
  | 'timeout'
  | 'network'
  | 'auth'
  | 'billing'
  | 'request_too_large'
  | 'invalid_request'
  | 'disabled'
  | 'not_configured'
  | 'unknown';

export interface StreamErrorInfo {
  kind: StreamErrorKind;
  /** Plain-language explanation, safe to show and persist. */
  userMessage: string;
  /** True when sending the same question again can reasonably succeed. */
  retryable: boolean;
  /** Anthropic request id, when the payload carried one. */
  requestId: string | null;
}

interface ApiErrorBody {
  type?: string;
  message?: string;
  requestId: string | null;
}

const RESEND = 'Re-send your question to retry.';

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : null;
}

function bodyFrom(payload: unknown): ApiErrorBody | null {
  const outer = asRecord(payload);
  if (!outer) return null;
  // Envelope is {type:'error', error:{type, message}, request_id}; tolerate
  // being handed the inner object directly.
  const inner = asRecord(outer.error) ?? outer;
  const type = typeof inner.type === 'string' ? inner.type : undefined;
  const message = typeof inner.message === 'string' ? inner.message : undefined;
  if (!type && !message) return null;
  const requestId = typeof outer.request_id === 'string' ? outer.request_id : null;
  return { type, message, requestId };
}

function parseBody(err: unknown): ApiErrorBody | null {
  const e = asRecord(err);
  if (!e) return null;
  const parsed = bodyFrom(e.error);
  if (parsed) return parsed;
  const message = typeof e.message === 'string' ? e.message : '';
  const start = message.indexOf('{');
  if (start < 0) return null;
  try {
    return bodyFrom(JSON.parse(message.slice(start)));
  } catch {
    return null;
  }
}

function kindOf(err: unknown, body: ApiErrorBody | null): StreamErrorKind {
  const e = asRecord(err) ?? {};
  if (e.code === 'claude_disabled') return 'disabled';
  const message = typeof e.message === 'string' ? e.message : '';
  if (/API key is not configured/i.test(message)) return 'not_configured';

  const status = typeof e.status === 'number' ? e.status : undefined;
  const type = body?.type;

  if (type === 'overloaded_error' || status === 529) {
    return /container|code execution/i.test(body?.message ?? '')
      ? 'sandbox_unavailable'
      : 'overloaded';
  }
  if (type === 'rate_limit_error' || status === 429) return 'rate_limited';
  if (type === 'timeout_error' || status === 504 || e.name === 'APIConnectionTimeoutError') {
    return 'timeout';
  }
  if (type === 'api_error' || (status !== undefined && status >= 500)) return 'upstream_error';
  if (type === 'authentication_error' || type === 'permission_error') return 'auth';
  if (status === 401 || status === 403) return 'auth';
  if (type === 'billing_error' || status === 402) return 'billing';
  if (type === 'request_too_large' || status === 413) return 'request_too_large';
  if (type === 'invalid_request_error' || type === 'not_found_error') return 'invalid_request';
  if (status === 400 || status === 404) return 'invalid_request';
  // No status and no recognizable body → the connection itself failed.
  if (status === undefined && !type) return 'network';
  return 'unknown';
}

const MESSAGES: Record<StreamErrorKind, { text: string; retryable: boolean }> = {
  sandbox_unavailable: {
    text: `Anthropic's code-execution sandbox, which the research skills run in, was temporarily unavailable. This is an outage on Anthropic's side, not a problem with your question. ${RESEND}`,
    retryable: true,
  },
  overloaded: {
    text: `Anthropic's service was temporarily overloaded. This is on Anthropic's side, not a problem with your question. ${RESEND}`,
    retryable: true,
  },
  rate_limited: {
    text: `The firm's Anthropic account hit its rate limit. Wait a minute, then re-send your question to retry.`,
    retryable: true,
  },
  upstream_error: {
    text: `Anthropic's service returned an internal error. ${RESEND}`,
    retryable: true,
  },
  timeout: {
    text: `The request to Anthropic timed out. ${RESEND}`,
    retryable: true,
  },
  network: {
    text: `The connection to Anthropic failed before a reply arrived. ${RESEND}`,
    retryable: true,
  },
  auth: {
    text: `Anthropic rejected the firm's API key. An administrator needs to check it under Admin → Settings.`,
    retryable: false,
  },
  billing: {
    text: `Anthropic declined the request for a billing reason. An administrator needs to check the firm's Anthropic account.`,
    retryable: false,
  },
  request_too_large: {
    text: `This conversation is too large to send. Start a new chat, or remove attachments, and ask again.`,
    retryable: false,
  },
  invalid_request: {
    text: `Anthropic rejected the request as invalid. Sending it again will not help — please report this to an administrator.`,
    retryable: false,
  },
  disabled: {
    text: `AI calls are switched off on this server (kill switch). An administrator needs to re-enable them.`,
    retryable: false,
  },
  not_configured: {
    text: `No Anthropic API key is configured. An administrator needs to set it under Admin → Settings.`,
    retryable: false,
  },
  unknown: {
    text: `The request failed for a reason the server could not classify. ${RESEND}`,
    retryable: true,
  },
};

export function describeStreamError(err: unknown): StreamErrorInfo {
  const body = parseBody(err);
  const kind = kindOf(err, body);
  const { text, retryable } = MESSAGES[kind];
  // `request-id` header on HTTP-level errors; payload field on SSE ones.
  const headerId = asRecord(err)?.request_id;
  const requestId = body?.requestId ?? (typeof headerId === 'string' ? headerId : null);
  return { kind, userMessage: text, retryable, requestId };
}

/** The persisted system_note / SSE error text for a failed turn. */
export function streamErrorNote(info: StreamErrorInfo): string {
  const ref = info.requestId ? ` (Reference: ${info.requestId})` : '';
  return `⚠ The assistant could not complete this turn. ${info.userMessage}${ref}`;
}

/**
 * Transient upstream failures worth an automatic second attempt. Narrower
 * than `retryable`: a rate limit is user-retryable after a wait, but
 * hammering it from a retry loop only extends the limit.
 */
export function isAutoRetryable(info: StreamErrorInfo): boolean {
  return (
    info.kind === 'sandbox_unavailable' ||
    info.kind === 'overloaded' ||
    info.kind === 'upstream_error' ||
    info.kind === 'network'
  );
}
