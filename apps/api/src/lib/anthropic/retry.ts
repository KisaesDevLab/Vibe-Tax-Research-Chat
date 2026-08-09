// Shared retry loop for both Claude call paths (direct in client.ts, router
// in router-mode.ts): bounded attempts, exponential backoff with full jitter,
// an optional server-suggested initial delay, and an optional overall
// deadline that bounds attempts AND backoff sleeps so the configured timeout
// stays a hard ceiling on the logical call.

import { logger } from '../logger.js';

export const MAX_ATTEMPTS = 3;
export const BASE_BACKOFF_MS = 500;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface WithRetryOptions {
  /** Job name for the retry warn log. */
  job: string;
  /** Log-line prefix, e.g. 'claude.call' or 'claude.call (router)'. */
  label: string;
  isRetryable: (err: unknown) => boolean;
  /** Server-suggested delay in ms for this error (e.g. retry-after); null → jittered backoff. */
  retryAfterMs?: (err: unknown) => number | null;
  /**
   * Overall wall-clock budget covering every attempt and every backoff sleep.
   * When the remaining budget cannot fit the next sleep, the error is thrown
   * instead of retried.
   */
  deadlineMs?: number;
  maxAttempts?: number;
}

export async function withRetry<T>(
  fn: (attempt: number, remainingMs: number | null) => Promise<T>,
  opts: WithRetryOptions,
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? MAX_ATTEMPTS;
  const startedAt = Date.now();
  const remaining = (): number | null =>
    opts.deadlineMs === undefined ? null : opts.deadlineMs - (Date.now() - startedAt);
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn(attempt, remaining());
    } catch (err) {
      if (!opts.isRetryable(err) || attempt >= maxAttempts) throw err;
      const backoff =
        opts.retryAfterMs?.(err) ?? BASE_BACKOFF_MS * 2 ** (attempt - 1) * (0.5 + Math.random());
      const left = remaining();
      if (left !== null && left <= backoff) throw err;
      logger.warn(
        { job: opts.job, attempt, backoff_ms: Math.round(backoff), err: (err as Error).message },
        `${opts.label} retrying`,
      );
      await sleep(backoff);
    }
  }
}
