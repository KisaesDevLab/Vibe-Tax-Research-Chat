// middleware/auth — the revocation hook (SSO back-channel logout) sits after
// signature verification: no hook → no DB read; revoked → 401; hook failure
// → fail closed (503); bearer and `vibe_at` cookie both still accepted.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Request, Response } from 'express';

vi.mock('../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-access-secret-test-access-secret-0000',
    JWT_REFRESH_SECRET: 'test-refresh-secret-test-refresh-secret-0',
    JWT_ACCESS_TTL: '15m',
    JWT_REFRESH_TTL: '30d',
  },
}));

import { requireAuth, setRevocationCheck, isTokenRevoked } from './auth.js';
import { signAccess } from '../lib/jwt.js';

const USER = '11111111-1111-4111-8111-111111111111';

function call(opts: { bearer?: string; cookie?: string }) {
  const req = {
    headers: opts.bearer ? { authorization: `Bearer ${opts.bearer}` } : {},
    cookies: opts.cookie ? { vibe_at: opts.cookie } : {},
  } as unknown as Request;
  const json = vi.fn();
  const res = { status: vi.fn(() => ({ json })) } as unknown as Response;
  const next = vi.fn();
  return { req, res, next, json, status: res.status as unknown as ReturnType<typeof vi.fn> };
}

describe('requireAuth + revocation hook', () => {
  beforeEach(() => setRevocationCheck(null));
  afterEach(() => setRevocationCheck(null));

  it('passes a valid bearer with no hook registered (no DB read) and exposes sid', async () => {
    const token = signAccess({ sub: USER, role: 'user', email: 'pat@firm.test', sid: 's-1' });
    const c = call({ bearer: token });
    await requireAuth(c.req, c.res, c.next);
    expect(c.next).toHaveBeenCalledOnce();
    expect(c.req.auth).toEqual({ user_id: USER, email: 'pat@firm.test', role: 'user', sid: 's-1' });
  });

  it('omits sid from req.auth for password sessions', async () => {
    const token = signAccess({ sub: USER, role: 'admin', email: 'a@firm.test' });
    const c = call({ bearer: token });
    await requireAuth(c.req, c.res, c.next);
    expect(c.req.auth).toEqual({ user_id: USER, email: 'a@firm.test', role: 'admin' });
  });

  it('accepts the vibe_at cookie when no bearer is present', async () => {
    const token = signAccess({ sub: USER, role: 'admin', email: 'a@firm.test' });
    const c = call({ cookie: token });
    await requireAuth(c.req, c.res, c.next);
    expect(c.next).toHaveBeenCalledOnce();
  });

  it('401 token_revoked when the hook says the token predates the revocation', async () => {
    const hook = vi.fn(async () => true);
    setRevocationCheck(hook);
    const token = signAccess({ sub: USER, role: 'user', email: 'pat@firm.test', sid: 's-1' });
    const c = call({ bearer: token });
    await requireAuth(c.req, c.res, c.next);
    expect(c.next).not.toHaveBeenCalled();
    expect(c.status).toHaveBeenCalledWith(401);
    expect(c.json).toHaveBeenCalledWith({ error: 'token_revoked' });
    // Key + iat in ms, as the package's isRevoked expects.
    const [key, iatMs] = hook.mock.calls[0] as unknown as [
      { userId: string; sid?: string },
      number,
    ];
    expect(key).toEqual({ userId: USER, sid: 's-1' });
    expect(iatMs).toBeGreaterThan(Date.now() - 60_000);
    expect(iatMs % 1000).toBe(0);
  });

  it('503 auth_unavailable when the hook throws (fail closed)', async () => {
    setRevocationCheck(async () => {
      throw new Error('pg down');
    });
    const token = signAccess({ sub: USER, role: 'user', email: 'pat@firm.test' });
    const c = call({ bearer: token });
    await requireAuth(c.req, c.res, c.next);
    expect(c.status).toHaveBeenCalledWith(503);
    expect(c.json).toHaveBeenCalledWith({ error: 'auth_unavailable' });
  });

  it('401 invalid_token on a bad signature before consulting the hook', async () => {
    const hook = vi.fn(async () => true);
    setRevocationCheck(hook);
    const c = call({ bearer: 'not-a-jwt' });
    await requireAuth(c.req, c.res, c.next);
    expect(c.status).toHaveBeenCalledWith(401);
    expect(c.json).toHaveBeenCalledWith({ error: 'invalid_token' });
    expect(hook).not.toHaveBeenCalled();
  });

  it('isTokenRevoked is false with no hook and forwards iat in milliseconds otherwise', async () => {
    expect(await isTokenRevoked({ sub: USER, iat: 100 })).toBe(false);
    const hook = vi.fn(async () => false);
    setRevocationCheck(hook);
    await isTokenRevoked({ sub: USER, sid: 'x', iat: 1_700_000_000 });
    expect(hook).toHaveBeenCalledWith({ userId: USER, sid: 'x' }, 1_700_000_000_000);
  });
});
