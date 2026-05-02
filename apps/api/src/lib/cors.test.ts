// Appliance packaging — CORS allowlist parser. The list-form ALLOWED_ORIGIN
// has to handle the full appliance triplet (primary HTTPS, Tailscale TLS,
// emergency :5191 plain HTTP) without falling back to wildcard, which would
// break credentials: true.
import { describe, expect, it, beforeAll } from 'vitest';
import crypto from 'node:crypto';

beforeAll(() => {
  process.env.MASTER_KEY = crypto.randomBytes(32).toString('hex');
  process.env.JWT_SECRET = crypto.randomBytes(64).toString('hex');
  process.env.JWT_REFRESH_SECRET = crypto.randomBytes(64).toString('hex');
  process.env.DATABASE_URL = 'postgres://x/x';
  process.env.REDIS_URL = 'redis://localhost:6379';
});

describe('buildOriginMatchers', () => {
  it('matches a single literal origin', async () => {
    const { buildOriginMatchers } = await import('./cors.js');
    const ms = buildOriginMatchers('https://tax.firm.com');
    expect(ms.some((m) => m('https://tax.firm.com'))).toBe(true);
    expect(ms.some((m) => m('https://evil.com'))).toBe(false);
  });

  it('matches all three origins in the appliance triplet', async () => {
    const { buildOriginMatchers } = await import('./cors.js');
    const ms = buildOriginMatchers(
      'https://tax.firm.com, https://tax.tailnet-x.ts.net, http://192.168.1.42:5191',
    );
    for (const o of [
      'https://tax.firm.com',
      'https://tax.tailnet-x.ts.net',
      'http://192.168.1.42:5191',
    ]) {
      expect(ms.some((m) => m(o))).toBe(true);
    }
    expect(ms.some((m) => m('https://other.firm.com'))).toBe(false);
  });

  it('strips trailing slashes on configured entries', async () => {
    const { buildOriginMatchers } = await import('./cors.js');
    const ms = buildOriginMatchers('https://tax.firm.com/');
    // Browser Origin header never carries a trailing slash; without
    // normalization this match would silently fail.
    expect(ms.some((m) => m('https://tax.firm.com'))).toBe(true);
  });

  it('honors regex: entries', async () => {
    const { buildOriginMatchers } = await import('./cors.js');
    const ms = buildOriginMatchers('regex:^https://tax-[a-z0-9]+\\.ts\\.net$');
    expect(ms.some((m) => m('https://tax-acme.ts.net'))).toBe(true);
    expect(ms.some((m) => m('https://tax-acme.example.com'))).toBe(false);
  });

  it('throws a clear error on a malformed regex', async () => {
    const { buildOriginMatchers } = await import('./cors.js');
    expect(() => buildOriginMatchers('regex:[broken')).toThrow(/ALLOWED_ORIGIN: invalid regex/);
  });

  it('drops empty list entries', async () => {
    const { buildOriginMatchers } = await import('./cors.js');
    const ms = buildOriginMatchers(' , https://tax.firm.com , ');
    expect(ms).toHaveLength(1);
    expect(ms.some((m) => m('https://tax.firm.com'))).toBe(true);
  });
});
