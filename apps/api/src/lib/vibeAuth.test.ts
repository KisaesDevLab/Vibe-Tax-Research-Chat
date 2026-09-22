// lib/vibeAuth — the product side of the SSO contract: fragment hand-off,
// cookie policy on /auth/*, revocation keys on back-channel logout, SPA
// prefix, local-login policy, rate-limited path set.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Request } from 'express';
import { PgDialect } from 'drizzle-orm/pg-core';
import { auth_refresh_tokens, auth_sessions_oidc } from '@vibe/db/schema';

vi.mock('../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-access-secret-test-access-secret-0000',
    JWT_REFRESH_SECRET: 'test-refresh-secret-test-refresh-secret-0',
    JWT_ACCESS_TTL: '15m',
    JWT_REFRESH_TTL: '30d',
    MASTER_KEY: '00'.repeat(32),
    PUBLIC_BASE_URL: 'http://localhost:5173',
    COOKIE_SECURE: 'false',
    TRUST_PROXY: 1,
  },
}));
vi.mock('./logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('./audit.js', () => ({ audit: vi.fn(async () => undefined) }));
vi.mock('./settings-store.js', () => ({ getSetting: vi.fn(async () => null) }));
vi.mock('./rate-limit.js', () => ({
  ssoLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

type Row = Record<string, unknown>;
const state: {
  deleted: Row[];
  deleteWheres: unknown[];
  updates: Array<{ table: unknown; set: Row; where: unknown }>;
  pool: Array<{ text: string; params: unknown[] }>;
} = { deleted: [], deleteWheres: [], updates: [], pool: [] };

vi.mock('@vibe/db', () => ({
  getDb: () => ({
    delete: () => ({
      where: (cond: unknown) => {
        state.deleteWheres.push(cond);
        const p = Promise.resolve(state.deleted) as Promise<Row[]> & {
          returning: () => Promise<Row[]>;
        };
        p.returning = async () => state.deleted;
        return p;
      },
    }),
    update: (table: unknown) => ({
      set: (set: Row) => ({
        where: async (where: unknown) => {
          state.updates.push({ table, set, where });
        },
      }),
    }),
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
    insert: () => ({ values: async () => undefined }),
  }),
  getPool: () => ({
    unsafe: async (text: string, params: unknown[]) => {
      state.pool.push({ text, params });
      return [];
    },
  }),
}));

import {
  initVibeAuth,
  isRateLimitedAuthPath,
  isTestStartNavigation,
  localLoginRefusal,
  resetVibeAuthForTests,
  sessionFor,
  sweepGraceCutoff,
  withSsoCode,
} from './vibeAuth.js';
import { signAccess } from './jwt.js';

const dialect = new PgDialect();
const paramsOf = (cond: unknown): unknown[] => dialect.sqlToQuery(cond as never).params;
const USER = '11111111-1111-4111-8111-111111111111';
const revokedKeys = () =>
  state.pool.filter((q) => q.text.includes('INSERT INTO auth_revocations')).map((q) => q.params[0]);

function req(o: {
  method?: string;
  path?: string;
  query?: Record<string, string>;
  bearer?: string;
  cookie?: string;
}): Request {
  return {
    method: o.method ?? 'GET',
    path: o.path ?? '/auth/status',
    query: o.query ?? {},
    headers: o.bearer ? { authorization: `Bearer ${o.bearer}` } : {},
    cookies: o.cookie ? { vibe_at: o.cookie } : {},
  } as unknown as Request;
}

beforeEach(() => {
  state.deleted = [];
  state.deleteWheres = [];
  state.updates = [];
  state.pool = [];
  delete process.env.VIBE_AUTH_MODE;
  delete process.env.VIBE_OIDC_PUBLIC_URL;
});
afterEach(() => resetVibeAuthForTests());

describe('hand-off fragment', () => {
  it('appends #sso_code, replacing any fragment the engine put there, keeping the query', () => {
    expect(withSsoCode('/login', 'abc')).toBe('/login#sso_code=abc');
    expect(withSsoCode('/tax/login?x=1#old', 'a b')).toBe('/tax/login?x=1#sso_code=a%20b');
  });
});

describe('cookie policy on /auth/*', () => {
  const token = signAccess({ sub: USER, role: 'admin', email: 'a@firm.test', sid: 's-1' });

  it('bearer wins everywhere', () => {
    expect(sessionFor(req({ path: '/auth/oidc/logout', bearer: token }))?.sid).toBe('s-1');
  });

  it('the vibe_at cookie is accepted ONLY on GET /auth/oidc/start?test=1', () => {
    expect(isTestStartNavigation(req({ path: '/auth/oidc/start', query: { test: '1' } }))).toBe(
      true,
    );
    expect(
      sessionFor(req({ path: '/auth/oidc/start', query: { test: '1' }, cookie: token }))?.sub,
    ).toBe(USER);
    expect(sessionFor(req({ path: '/auth/oidc/start', cookie: token }))).toBeNull();
    expect(sessionFor(req({ path: '/auth/oidc/logout', cookie: token }))).toBeNull();
    expect(sessionFor(req({ method: 'PUT', path: '/auth/settings', cookie: token }))).toBeNull();
    expect(
      sessionFor(
        req({ method: 'POST', path: '/auth/oidc/start', query: { test: '1' }, cookie: token }),
      ),
    ).toBeNull();
  });

  it('a bad bearer is null, not an exception', () => {
    expect(sessionFor(req({ bearer: 'nope' }))).toBeNull();
  });
});

describe('rate-limited path set', () => {
  it('covers the browser-driven steps, never the back-channel', () => {
    for (const p of [
      '/auth/oidc/start',
      '/auth/oidc/callback',
      '/auth/oidc/exchange',
      '/auth/settings/test/',
    ]) {
      expect(isRateLimitedAuthPath(p)).toBe(true);
    }
    for (const p of ['/auth/oidc/backchannel', '/auth/status', '/auth/settings', '/auth/me']) {
      expect(isRateLimitedAuthPath(p)).toBe(false);
    }
  });
});

describe('session sweep grace', () => {
  it('never sweeps a row younger than an hour (unexchanged hand-off, clock skew)', () => {
    const now = Date.UTC(2026, 8, 19, 12, 0, 0);
    expect(sweepGraceCutoff(now).getTime()).toBe(now - 60 * 60 * 1000);
  });
});

describe('engine construction', () => {
  it('derives the SPA prefix from the public URL and re-prefixes the browser-facing paths', async () => {
    const auth = await initVibeAuth({ publicUrl: 'https://firm.example/tax/' });
    expect(auth.loginPath).toBe('/tax/login');
    expect(auth.breakglassLoginPath).toBe('/tax/login/local');
    const s = auth.status();
    expect(s.mode).toBe('local');
    expect(s.oidc.startPath).toBe('/auth/oidc/start'); // engine basePath stays '' — the proxy strips /tax
  });

  it('local mode: every email may log in locally', async () => {
    await initVibeAuth({ publicUrl: 'http://localhost:5173' });
    expect(localLoginRefusal('pat@firm.test')).toBeNull();
  });

  it('oidc_only: only the break-glass address passes, by its package username', async () => {
    process.env.VIBE_AUTH_MODE = 'oidc_only';
    await initVibeAuth({ publicUrl: 'http://localhost:5173' });
    expect(localLoginRefusal('pat@firm.test')).toEqual({
      error: 'local_login_disabled',
      message: 'Local sign-in is disabled for this product. Use single sign-on.',
    });
    expect(localLoginRefusal('VIBE-BREAKGLASS@vibe-tax.local')).toBeNull();
  });
});

describe('destroyByIdentity (back-channel logout)', () => {
  it('sid-only: ends the matching internal sessions and their refresh chains, no user-level revocation', async () => {
    const auth = await initVibeAuth({ publicUrl: 'http://localhost:5173' });
    state.deleted = [{ sid: 'int-1', user_id: USER }];
    const n = await auth.session.destroyByIdentity!({ issuer: 'https://idp/', sid: 'idp-sid-1' });
    expect(n).toBe(1);
    expect(paramsOf(state.deleteWheres[0])).toEqual(['idp-sid-1']);
    expect(revokedKeys()).toEqual(['s:int-1']);
    const refreshRevokes = state.updates.filter((u) => u.table === auth_refresh_tokens);
    expect(refreshRevokes).toHaveLength(1);
    expect(paramsOf(refreshRevokes[0]!.where)).toEqual(['int-1']);
  });

  it('subject / user level: also revokes u:<user> and every refresh row of the user', async () => {
    const auth = await initVibeAuth({ publicUrl: 'http://localhost:5173' });
    state.deleted = [
      { sid: 'int-1', user_id: USER },
      { sid: 'int-2', user_id: USER },
    ];
    const n = await auth.session.destroyByIdentity!({
      issuer: 'https://idp/',
      subject: 'u-100',
      userId: USER,
    });
    expect(n).toBe(2);
    expect(revokedKeys()).toEqual(['s:int-1', 's:int-2', `u:${USER}`]);
    const byUser = state.updates.filter(
      (u) => u.table === auth_refresh_tokens && paramsOf(u.where).includes(USER),
    );
    expect(byUser).toHaveLength(1);
  });

  it('a user-level logout with no live SSO rows still ends the user everywhere', async () => {
    const auth = await initVibeAuth({ publicUrl: 'http://localhost:5173' });
    state.deleted = [];
    const n = await auth.session.destroyByIdentity!({
      issuer: 'https://idp/',
      subject: 'u-100',
      userId: USER,
    });
    expect(n).toBe(0);
    expect(revokedKeys()).toEqual([`u:${USER}`]);
  });

  it('nothing to match → no query at all', async () => {
    const auth = await initVibeAuth({ publicUrl: 'http://localhost:5173' });
    expect(await auth.session.destroyByIdentity!({ issuer: 'https://idp/' })).toBe(0);
    expect(state.deleteWheres).toHaveLength(0);
    expect(state.pool).toHaveLength(0);
  });
});

describe('destroy (RP-initiated logout) and the identity row', () => {
  it('ends the session named by the bearer and clears the cookie', async () => {
    const auth = await initVibeAuth({ publicUrl: 'http://localhost:5173' });
    const token = signAccess({ sub: USER, role: 'user', email: 'p@firm.test', sid: 'int-9' });
    const clearCookie = vi.fn();
    await auth.session.destroy(req({ method: 'GET', path: '/auth/oidc/logout', bearer: token }), {
      clearCookie,
    } as never);
    expect(paramsOf(state.deleteWheres[0])).toEqual(['int-9']);
    expect(revokedKeys()).toEqual(['s:int-9']);
    expect(clearCookie).toHaveBeenCalledWith('vibe_at', expect.objectContaining({ maxAge: 0 }));
    void auth_sessions_oidc;
  });
});
