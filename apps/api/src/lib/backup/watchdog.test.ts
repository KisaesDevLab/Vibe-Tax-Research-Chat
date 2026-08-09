// DR v2 — deadline and stall behavior with injected clocks.
import { describe, expect, it, vi } from 'vitest';
import { withDeadline, StallDetector, DeadlineExceededError, StallError } from './watchdog.js';

describe('withDeadline', () => {
  it('resolves when the work finishes in time', async () => {
    await expect(withDeadline(Promise.resolve('ok'), 1000, 'fast')).resolves.toBe('ok');
  });

  it('rejects with DeadlineExceededError when the work outlives the budget', async () => {
    vi.useFakeTimers();
    try {
      const never = new Promise(() => {});
      const p = withDeadline(never, 5000, 'hung-phase');
      const assertion = expect(p).rejects.toBeInstanceOf(DeadlineExceededError);
      await vi.advanceTimersByTimeAsync(5001);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('propagates the work error unchanged when it fails before the deadline', async () => {
    const boom = new Error('boom');
    await expect(withDeadline(Promise.reject(boom), 1000, 'x')).rejects.toBe(boom);
  });
});

describe('StallDetector', () => {
  function harness(quietMs: number) {
    let now = 0;
    const fired: StallError[] = [];
    const detector = new StallDetector({
      label: 'pg_restore',
      quietMs,
      onStall: (e) => fired.push(e),
      now: () => now,
      // No real timer — tests drive check() manually.
      setTimer: (() => 0) as unknown as typeof setInterval,
      clearTimer: (() => {}) as unknown as typeof clearInterval,
    });
    return { detector, fired, advance: (ms: number) => (now += ms) };
  }

  it('fires only after the quiet period with no touches', () => {
    const { detector, fired, advance } = harness(300_000);
    advance(299_999);
    detector.check();
    expect(fired).toHaveLength(0);
    advance(2);
    detector.check();
    expect(fired).toHaveLength(1);
    expect(fired[0]).toBeInstanceOf(StallError);
  });

  it('touch() defers the stall', () => {
    const { detector, fired, advance } = harness(300_000);
    advance(299_000);
    detector.touch();
    advance(299_000);
    detector.check();
    expect(fired).toHaveLength(0);
    advance(2_000);
    detector.check();
    expect(fired).toHaveLength(1);
  });

  it('fires at most once', () => {
    const { detector, fired, advance } = harness(1_000);
    advance(5_000);
    detector.check();
    detector.check();
    expect(fired).toHaveLength(1);
  });
});
