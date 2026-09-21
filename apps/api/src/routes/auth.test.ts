// routes/auth — the SSO touch points on the existing session routes:
// the oidc_only policy on /login, sid + revocation on /refresh, an SSO-born
// /logout ending its session, the one-time-code /sso/exchange, the bare
// break-glass username on /login, and the self-service reset refusals.
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  auth_refresh_tokens,
  auth_sessions_oidc,
  password_reset_tokens,
  users,
} from '@vibe/db/schema';

vi.mock('../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-access-secret-test-access-secret-0000',
    JWT_REFRESH_SECRET: 'test-refresh-secret-test-refresh-secret-0',
    JWT_ACCESS_TTL: '15m',
    JWT_REFRESH_TTL: '30d',
    COOKIE_SECURE: 'false',
    NODE_ENV: 'test',
  },
}));
vi.mock('../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../lib/audit.js', () => ({ audit: vi.fn(async () => undefined) }));
vi.mock('../lib/email/index.js', () => ({ buildMailer: vi.fn(async () => null) }));
vi.mock('../jobs/queues.js', () => ({ notificationsEmailQueue: { add: vi.fn() } }));
vi.mock('../lib/rate-limit.js', () => {
  const pass = (_req: unknown, _res: unknown, next: () => void) => next();
  return {
    loginLimiter: pass,
    forgotPasswordLimiter: pass,
    resetPasswordLimiter: pass,
    ssoLimiter: pass,
  };
});

const revoked = vi.fn(async (_claims: unknown): Promise<boolean> => false);
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (
    req: { auth?: unknown; headers: Record<string, string> },
    _res: unknown,
    next: () => void,
  ) => {
    req.auth = {
      user_id: USER,
      email: 'pat@firm.test',
      role: 'user',
      ...(req.headers['x-test-sid'] ? { sid: req.headers['x-test-sid'] } : {}),
    };
    next();
  },
  isTokenRevoked: (c: unknown) => revoked(c),
}));

const refusal = vi.fn((_email: string): null | { error: string } => null);
const afterLocalLogin = vi.fn(async (_i: unknown) => undefined);
const endSsoSession = vi.fn(async (_sid: string) => undefined);
vi.mock('../lib/vibeAuth.js', async () => {
  // The addressing / account-kind helpers are pure: use the real ones.
  const real =
    await vi.importActual<typeof import('../lib/vibeAuthUsers.js')>('../lib/vibeAuthUsers.js');
  return {
    BREAKGLASS_USERNAME: real.BREAKGLASS_USERNAME,
    isBreakglassEmail: real.isBreakglassEmail,
    isSsoOnlyAccount: real.isSsoOnlyAccount,
    localLoginIdentifier: real.localLoginIdentifier,
    loginEmailFor: real.loginEmailFor,
    localLoginRefusal: (email: string) => refusal(email),
    getVibeAuth: () => ({ afterLocalLogin }),
    endSsoSession: (sid: string) => endSsoSession(sid),
  };
});

type Row = Record<string, unknown>;
const state: {
  user: Row | null;
  refreshRow: Row | null;
  resetRow: Row | null;
  claimed: Row[];
  inserts: Array<{ table: unknown; values: Row }>;
  updates: Array<{ table: unknown; set: Row; where: unknown }>;
} = { user: null, refreshRow: null, resetRow: null, claimed: [], inserts: [], updates: [] };

vi.mock('@vibe/db', () => ({
  getDb: () => ({
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () => {
            if (table === users) return state.user ? [state.user] : [];
            if (table === auth_refresh_tokens) return state.refreshRow ? [state.refreshRow] : [];
            if (table === password_reset_tokens) return state.resetRow ? [state.resetRow] : [];
            return [];
          },
        }),
      }),
    }),
    insert: (table: unknown) => ({
      values: async (values: Row) => {
        state.inserts.push({ table, values });
      },
    }),
    update: (table: unknown) => ({
      set: (set: Row) => ({
        where: (where: unknown) => {
          state.updates.push({ table, set, where });
          const p = Promise.resolve(undefined) as Promise<undefined> & {
            returning: () => Promise<Row[]>;
          };
          p.returning = async () => (table === auth_sessions_oidc ? state.claimed : []);
          return p;
        },
      }),
    }),
  }),
}));

import { authRouter } from './auth.js';
import { signRefresh, verifyAccess, verifyRefresh, hashToken } from '../lib/jwt.js';
import { audit } from '../lib/audit.js';
import { buildMailer } from '../lib/email/index.js';
import { notificationsEmailQueue } from '../jobs/queues.js';

const USER = '11111111-1111-4111-8111-111111111111';
const dialect = new PgDialect();
const paramsOf = (cond: unknown): unknown[] => dialect.sqlToQuery(cond as never).params;

const app = express();
app.use(express.json());
app.use('/api/auth', authRouter);

let passwordHash: string;
beforeAll(async () => {
  passwordHash = await bcrypt.hash('Correct-horse-1', 4);
});

beforeEach(() => {
  state.user = {
    id: USER,
    email: 'pat@firm.test',
    password_hash: passwordHash,
    has_local_password: true,
    role: 'user',
    display_name: 'Pat',
    is_active: true,
    monthly_spend_cap_usd: null,
    can_override_model: true,
    deleted_at: null,
  };
  state.refreshRow = null;
  state.resetRow = null;
  state.claimed = [];
  state.inserts = [];
  state.updates = [];
  revoked.mockReset().mockResolvedValue(false);
  refusal.mockReset().mockReturnValue(null);
  afterLocalLogin.mockClear();
  endSsoSession.mockClear();
  vi.mocked(audit).mockClear();
  vi.mocked(buildMailer).mockReset().mockResolvedValue(null);
  vi.mocked(notificationsEmailQueue.add).mockClear();
});

describe('POST /api/auth/login (SSO policy)', () => {
  it('403 local_login_disabled when the policy refuses, before any password check', async () => {
    refusal.mockReturnValue({ error: 'local_login_disabled' });
    const r = await request(app)
      .post('/api/auth/login')
      .send({ email: 'pat@firm.test', password: 'Correct-horse-1' });
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: 'local_login_disabled' });
    expect(state.inserts).toHaveLength(0);
  });

  it('a permitted login mints a sid-less session and reports the local login to the engine', async () => {
    const r = await request(app)
      .post('/api/auth/login')
      .send({ email: 'pat@firm.test', password: 'Correct-horse-1' });
    expect(r.status).toBe(200);
    expect(r.body.user).toMatchObject({ id: USER, email: 'pat@firm.test', role: 'user' });
    expect(verifyAccess(r.body.access_token).sid).toBeUndefined();
    expect(state.inserts[0]!.values.sid).toBeNull();
    expect(afterLocalLogin).toHaveBeenCalledWith({
      userId: USER,
      username: 'pat@firm.test',
      email: 'pat@firm.test',
      ip: expect.anything(),
    });
    expect(r.headers['set-cookie']?.[0]).toMatch(/^vibe_at=/);
  });

  it('the break-glass address reaches the engine under its package username', async () => {
    state.user = { ...state.user!, email: 'vibe-breakglass@vibe-tax.local', role: 'admin' };
    const r = await request(app)
      .post('/api/auth/login')
      .send({ email: 'vibe-breakglass@vibe-tax.local', password: 'Correct-horse-1' });
    expect(r.status).toBe(200);
    expect(afterLocalLogin.mock.calls[0]![0]).toMatchObject({ username: 'vibe-breakglass' });
  });

  // The Appliance prints only "username: vibe-breakglass" — that literal must sign in.
  it('accepts the bare break-glass username: policy, lookup and audit all see the account', async () => {
    state.user = { ...state.user!, email: 'vibe-breakglass@vibe-tax.local', role: 'admin' };
    const r = await request(app)
      .post('/api/auth/login')
      .send({ email: 'Vibe-Breakglass', password: 'Correct-horse-1' });
    expect(r.status).toBe(200);
    expect(refusal).toHaveBeenCalledWith('vibe-breakglass@vibe-tax.local');
    expect(afterLocalLogin.mock.calls[0]![0]).toMatchObject({
      username: 'vibe-breakglass',
      email: 'vibe-breakglass@vibe-tax.local',
    });
  });

  it('any other bare word is still a 400, before the policy or the database', async () => {
    const r = await request(app)
      .post('/api/auth/login')
      .send({ email: 'administrator', password: 'Correct-horse-1' });
    expect(r.status).toBe(400);
    expect(refusal).not.toHaveBeenCalled();
  });
});

describe('POST /api/auth/forgot-password (break-glass and SSO-only refusals)', () => {
  const mailer = { send: vi.fn() } as never;
  const forgot = (email: string) => request(app).post('/api/auth/forgot-password').send({ email });
  const requestAudits = () =>
    vi
      .mocked(audit)
      .mock.calls.map((c) => c[0])
      .filter((e) => e.action === 'auth.forgot_password.request');

  it('an ordinary local account gets a token and an email', async () => {
    vi.mocked(buildMailer).mockResolvedValue(mailer);
    const r = await forgot('pat@firm.test');
    expect(r.body).toEqual({ ok: true });
    expect(state.inserts.map((i) => i.table)).toContain(password_reset_tokens);
    expect(notificationsEmailQueue.add).toHaveBeenCalledTimes(1);
    expect(requestAudits()[0]!.metadata).toEqual({ email: 'pat@firm.test', eligible: true });
  });

  it('refuses the break-glass admin exactly like an unknown address, and audits why', async () => {
    vi.mocked(buildMailer).mockResolvedValue(mailer);
    state.user = null;
    const unknown = await forgot('nobody@firm.test');

    state.user = {
      id: USER,
      email: 'vibe-breakglass@vibe-tax.local',
      role: 'admin',
      is_active: true,
      has_local_password: true,
      deleted_at: null,
    };
    const r = await forgot('vibe-breakglass@vibe-tax.local');
    expect([r.status, r.body]).toEqual([unknown.status, unknown.body]);
    expect(state.inserts).toHaveLength(0);
    expect(notificationsEmailQueue.add).not.toHaveBeenCalled();
    expect(requestAudits()[1]).toMatchObject({
      actor_user_id: USER,
      metadata: { eligible: false, refused: 'breakglass' },
    });
  });

  it('refuses an SSO-only (JIT, never had a local password) account the same way', async () => {
    vi.mocked(buildMailer).mockResolvedValue(mailer);
    state.user = { ...state.user!, has_local_password: false };
    const r = await forgot('pat@firm.test');
    expect([r.status, r.body]).toEqual([200, { ok: true }]);
    expect(state.inserts).toHaveLength(0);
    expect(notificationsEmailQueue.add).not.toHaveBeenCalled();
    expect(requestAudits()[0]!.metadata).toEqual({
      email: 'pat@firm.test',
      eligible: false,
      refused: 'sso_only',
    });
  });
});

describe('POST /api/auth/reset-password (refusals hold at redemption too)', () => {
  const token = 't'.repeat(43);
  const redeem = () =>
    request(app).post('/api/auth/reset-password').send({ token, new_password: 'New-password-1' });
  const resetRow = (created_via: string) => ({
    id: '33333333-3333-4333-8333-333333333333',
    user_id: USER,
    claimed_at: null,
    expires_at: new Date(Date.now() + 60_000),
    created_via,
  });

  it('a self-service token cannot give an SSO-only account a password', async () => {
    state.user = { ...state.user!, has_local_password: false };
    state.resetRow = resetRow('self_service');
    const r = await redeem();
    expect([r.status, r.body]).toEqual([400, { error: 'invalid_or_expired_token' }]);
    expect(state.updates).toHaveLength(0);
    expect(vi.mocked(audit).mock.calls[0]![0]).toMatchObject({
      action: 'auth.password_reset.refused',
      metadata: { refused: 'sso_only' },
    });
  });

  it('an ADMIN-sent token does, and the account stops being SSO-only', async () => {
    state.user = { ...state.user!, has_local_password: false };
    state.resetRow = resetRow('admin');
    expect((await redeem()).status).toBe(200);
    const write = state.updates.find((u) => u.table === users)!;
    expect(write.set.has_local_password).toBe(true);
  });

  it('no token of any kind resets the break-glass admin', async () => {
    state.user = { ...state.user!, email: 'vibe-breakglass@vibe-tax.local', role: 'admin' };
    state.resetRow = resetRow('admin');
    expect((await redeem()).status).toBe(400);
    expect(state.updates).toHaveLength(0);
  });
});

describe('POST /api/auth/refresh (sid + revocation)', () => {
  function refreshFor(sid: string | null) {
    const jti = '22222222-2222-4222-8222-222222222222';
    const token = signRefresh({ sub: USER, jti });
    state.refreshRow = {
      id: jti,
      user_id: USER,
      token_hash: hashToken(token),
      revoked_at: null,
      expires_at: new Date(Date.now() + 86_400_000),
      sid,
    };
    return token;
  }

  it('carries the row sid into the new access token and the new row; checks the revocation list with the refresh iat', async () => {
    const token = refreshFor('int-7');
    const r = await request(app).post('/api/auth/refresh').send({ refresh_token: token });
    expect(r.status).toBe(200);
    expect(verifyAccess(r.body.access_token).sid).toBe('int-7');
    expect(state.inserts[0]!.values.sid).toBe('int-7');
    expect(verifyRefresh(r.body.refresh_token).jti).toBe(state.inserts[0]!.values.id);
    expect(revoked).toHaveBeenCalledWith({
      sub: USER,
      sid: 'int-7',
      iat: verifyRefresh(token).iat,
    });
    expect(r.headers['set-cookie']?.[0]).toMatch(/^vibe_at=/);
  });

  it('401 when the revocation list rejects the chain, before rotating', async () => {
    const token = refreshFor('int-7');
    revoked.mockResolvedValue(true);
    const r = await request(app).post('/api/auth/refresh').send({ refresh_token: token });
    expect(r.status).toBe(401);
    expect(state.updates).toHaveLength(0);
    expect(state.inserts).toHaveLength(0);
  });

  it('401 for a soft-deleted user', async () => {
    const token = refreshFor(null);
    state.user = { ...state.user!, deleted_at: new Date() };
    expect(
      (await request(app).post('/api/auth/refresh').send({ refresh_token: token })).status,
    ).toBe(401);
  });
});

describe('POST /api/auth/logout', () => {
  it('ends the SSO session when the access token carries a sid', async () => {
    const r = await request(app)
      .post('/api/auth/logout')
      .set('authorization', 'Bearer x')
      .set('x-test-sid', 'int-3')
      .send({});
    expect(r.status).toBe(204);
    expect(endSsoSession).toHaveBeenCalledWith('int-3');
  });

  it('touches no SSO state for a password session', async () => {
    const r = await request(app).post('/api/auth/logout').set('authorization', 'Bearer x').send({});
    expect(r.status).toBe(204);
    expect(endSsoSession).not.toHaveBeenCalled();
  });
});

describe('POST /api/auth/sso/exchange', () => {
  const code = 'c'.repeat(43);

  it('400 invalid_or_expired_code when nothing is claimed (used, expired, unknown)', async () => {
    const r = await request(app).post('/api/auth/sso/exchange').send({ code });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: 'invalid_or_expired_code' });
    // The claim is one UPDATE keyed by the sha256 of the code, never the code itself.
    const claim = state.updates.find((u) => u.table === auth_sessions_oidc)!;
    expect(claim.set.handoff_claimed_at).toBeInstanceOf(Date);
    expect(paramsOf(claim.where)).toContain(hashToken(code));
    expect(paramsOf(claim.where)).not.toContain(code);
    expect(state.inserts).toHaveLength(0);
  });

  it('a claimed code mints the login shape with sid on the access token and the refresh row', async () => {
    state.claimed = [{ sid: 'int-5', user_id: USER }];
    const r = await request(app).post('/api/auth/sso/exchange').send({ code });
    expect(r.status).toBe(200);
    expect(r.body.user).toMatchObject({ id: USER, role: 'user' });
    expect(verifyAccess(r.body.access_token).sid).toBe('int-5');
    expect(state.inserts[0]!.values.sid).toBe('int-5');
    expect(r.headers['set-cookie']?.[0]).toMatch(/^vibe_at=/);
  });

  it('401 when the claimed row belongs to a disabled user', async () => {
    state.claimed = [{ sid: 'int-5', user_id: USER }];
    state.user = { ...state.user!, is_active: false };
    expect((await request(app).post('/api/auth/sso/exchange').send({ code })).status).toBe(401);
  });

  it('400 bad_request on a malformed body', async () => {
    expect((await request(app).post('/api/auth/sso/exchange').send({ code: 'short' })).status).toBe(
      400,
    );
  });
});
