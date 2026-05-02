// Appliance packaging — cookie Secure-flag policy. Emergency mode (plain
// HTTP on :5191) breaks if cookies always carry Secure; standalone HTTPS
// behind a TLS proxy breaks if Secure is auto'd off when the proxy doesn't
// forward proto. The COOKIE_SECURE env knob mediates both.
//
// The env loader memoizes on first read, so we set COOKIE_SECURE before
// any module imports occur and stick to one mode per test file.
import { describe, expect, it, beforeAll } from 'vitest';
import crypto from 'node:crypto';
import type { Request } from 'express';

const fakeReq = (secure: boolean): Request => ({ secure }) as Request;

beforeAll(() => {
  process.env.MASTER_KEY = crypto.randomBytes(32).toString('hex');
  process.env.JWT_SECRET = crypto.randomBytes(64).toString('hex');
  process.env.JWT_REFRESH_SECRET = crypto.randomBytes(64).toString('hex');
  process.env.DATABASE_URL = 'postgres://x/x';
  process.env.REDIS_URL = 'redis://localhost:6379';
  process.env.COOKIE_SECURE = 'auto';
});

describe('accessCookieOptions (auto policy)', () => {
  it('derives Secure from req.secure when COOKIE_SECURE=auto', async () => {
    const { accessCookieOptions } = await import('./cookies.js');
    expect(accessCookieOptions(fakeReq(true)).secure).toBe(true);
    expect(accessCookieOptions(fakeReq(false)).secure).toBe(false);
  });

  it('always sets httpOnly + sameSite=lax + 15-minute maxAge + root path', async () => {
    const { accessCookieOptions } = await import('./cookies.js');
    const opts = accessCookieOptions(fakeReq(true));
    expect(opts.httpOnly).toBe(true);
    expect(opts.sameSite).toBe('lax');
    expect(opts.maxAge).toBe(15 * 60 * 1000);
    expect(opts.path).toBe('/');
  });
});
