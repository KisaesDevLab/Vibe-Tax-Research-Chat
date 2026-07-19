// TP-12 — unit tests for the semver-collision resolver. The unique index
// on (strategy_id, semver) covers deprecated rows from rejected drafts,
// so the resolver must bump past the numeric max, not just the current
// published version.
import { describe, it, expect, beforeAll } from 'vitest';
import crypto from 'node:crypto';

beforeAll(() => {
  process.env.MASTER_KEY = crypto.randomBytes(32).toString('hex');
  process.env.DATABASE_URL ??= 'postgres://x:x@localhost:9/x';
  process.env.REDIS_URL ??= 'redis://localhost:9';
});

describe('resolveDraftSemver', () => {
  it('keeps the desired version when unused', async () => {
    const { resolveDraftSemver } = await import('./strategy-author.js');
    expect(resolveDraftSemver('1.3.0', ['1.0.0', '1.1.0', '1.2.0'])).toBe('1.3.0');
  });

  it('bumps minor past the max on collision', async () => {
    const { resolveDraftSemver } = await import('./strategy-author.js');
    expect(resolveDraftSemver('1.2.0', ['1.0.0', '1.1.0', '1.2.0'])).toBe('1.3.0');
  });

  it('bumps past a deprecated row above the desired version', async () => {
    // 1.3.0 was drafted and rejected (deprecated) earlier; a fresh draft
    // desiring 1.2.0 must land beyond it, not at 1.2.x again.
    const { resolveDraftSemver } = await import('./strategy-author.js');
    expect(resolveDraftSemver('1.2.0', ['1.1.0', '1.2.0', '1.3.0'])).toBe('1.4.0');
  });

  it('compares numerically, not lexicographically', async () => {
    const { resolveDraftSemver } = await import('./strategy-author.js');
    expect(resolveDraftSemver('1.9.0', ['1.9.0', '1.10.0'])).toBe('1.11.0');
  });

  it('resets patch on the bump', async () => {
    const { resolveDraftSemver } = await import('./strategy-author.js');
    expect(resolveDraftSemver('2.1.3', ['2.1.3'])).toBe('2.2.0');
  });

  it('bumps past a higher major version', async () => {
    const { resolveDraftSemver } = await import('./strategy-author.js');
    expect(resolveDraftSemver('1.5.0', ['1.5.0', '3.0.1'])).toBe('3.1.0');
  });
});
