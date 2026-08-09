// DR v2 — no phase may hang forever. The v1 restore sat 20+ minutes at
// "loading database" with psql idle on stdin and nothing to interrupt it;
// every engine phase now runs under a deadline, and the load phase gets a
// stall detector keyed on ACTIVITY (any stderr line, any byte) rather than
// total duration, because a big restore is legitimately slow but is never
// legitimately silent.

export class DeadlineExceededError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} did not finish within ${Math.round(ms / 1000)}s`);
    this.name = 'DeadlineExceededError';
  }
}

export class StallError extends Error {
  constructor(label: string, quietMs: number) {
    super(`${label} produced no activity for ${Math.round(quietMs / 1000)}s — treating as stalled`);
    this.name = 'StallError';
  }
}

/** Reject with DeadlineExceededError if `promise` outlives `ms`. The
 *  underlying work is NOT cancelled — callers own cleanup (killing a
 *  child, dropping a scratch db) from the catch. */
export function withDeadline<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
  setTimer: typeof setTimeout = setTimeout,
  clearTimer: typeof clearTimeout = clearTimeout,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimer(() => reject(new DeadlineExceededError(label, ms)), ms);
    (t as { unref?: () => void }).unref?.();
    promise.then(
      (v) => {
        clearTimer(t);
        resolve(v);
      },
      (e) => {
        clearTimer(t);
        reject(e);
      },
    );
  });
}

export interface StallDetectorOptions {
  label: string;
  /** Silence longer than this fires onStall (once). */
  quietMs: number;
  onStall: (err: StallError) => void;
  now?: () => number;
  /** Poll cadence; tests inject a manual tick instead. */
  checkEveryMs?: number;
  setTimer?: typeof setInterval;
  clearTimer?: typeof clearInterval;
}

/**
 * Fires onStall after `quietMs` of no touch() calls. touch() on every unit
 * of observed progress (a stderr line, a chunk of bytes) defers it.
 */
export class StallDetector {
  private lastActivity: number;
  private fired = false;
  private timer?: ReturnType<typeof setInterval>;
  private readonly opts: Required<Pick<StallDetectorOptions, 'label' | 'quietMs' | 'onStall'>> &
    StallDetectorOptions;

  constructor(opts: StallDetectorOptions) {
    this.opts = opts;
    this.lastActivity = (opts.now ?? Date.now)();
    const every = opts.checkEveryMs ?? 5_000;
    const setT = opts.setTimer ?? setInterval;
    this.timer = setT(() => this.check(), every);
    (this.timer as { unref?: () => void }).unref?.();
  }

  touch(): void {
    this.lastActivity = (this.opts.now ?? Date.now)();
  }

  /** Exposed for injected-clock tests. */
  check(): void {
    if (this.fired) return;
    const now = (this.opts.now ?? Date.now)();
    if (now - this.lastActivity >= this.opts.quietMs) {
      this.fired = true;
      this.stop();
      this.opts.onStall(new StallError(this.opts.label, now - this.lastActivity));
    }
  }

  stop(): void {
    if (this.timer !== undefined) {
      (this.opts.clearTimer ?? clearInterval)(this.timer);
      this.timer = undefined;
    }
  }
}
