// routes/admin/users — SSO (Vibe Auth) protection of the break-glass admin:
// Admin → Users can neither disable, demote, delete, re-address nor mail a
// reset to it, in any sign-in mode (nothing here reads the mode), and the
// break-glass row is not "another admin" for last-admin protection.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { PgDialect } from 'drizzle-orm/pg-core';

vi.mock('../../lib/audit.js', () => ({ audit: vi.fn(async () => undefined) }));
vi.mock('../../lib/email/index.js', () => ({ buildMailer: vi.fn(async () => ({})) }));
vi.mock('../../jobs/queues.js', () => ({ notificationsEmailQueue: { add: vi.fn() } }));
vi.mock('../../lib/jwt.js', () => ({ hashToken: (t: string) => `hash:${t}` }));
vi.mock('../../middleware/auth.js', () => ({
  requireAuth: (req: { auth?: unknown }, _res: unknown, next: () => void) => {
    req.auth = { user_id: ACTOR, email: 'admin@firm.test', role: 'admin' };
    next();
  },
  requireRole: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

type Row = Record<string, unknown>;
const state: {
  target: Row | null;
  otherAdmins: number;
  countWhere: unknown;
  inserts: Row[];
  updates: Row[];
} = { target: null, otherAdmins: 0, countWhere: null, inserts: [], updates: [] };

vi.mock('@vibe/db', () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        // `.limit()` ends the target lookup; awaited bare it is the admin count.
        where: (cond: unknown) =>
          Object.assign(
            Promise.resolve().then(() => {
              state.countWhere = cond;
              return [{ value: state.otherAdmins }];
            }),
            { limit: async () => (state.target ? [state.target] : []) },
          ),
      }),
    }),
    insert: () => ({
      values: (v: Row) => {
        state.inserts.push(v);
        return Object.assign(Promise.resolve(undefined), {
          returning: async () => [{ id: TARGET }],
        });
      },
    }),
    update: () => ({
      set: (v: Row) => {
        state.updates.push(v);
        return { where: async () => undefined };
      },
    }),
  }),
}));

import { adminUsersRouter } from './users.js';
import { audit } from '../../lib/audit.js';

const ACTOR = '11111111-1111-4111-8111-111111111111';
const TARGET = '22222222-2222-4222-8222-222222222222';
const BREAKGLASS = 'vibe-breakglass@vibe-tax.local';
const dialect = new PgDialect();
const paramsOf = (cond: unknown): unknown[] => dialect.sqlToQuery(cond as never).params;

const app = express();
app.use(express.json());
app.use('/api/admin/users', adminUsersRouter);

const PROTECTED = expect.objectContaining({ error: 'breakglass_protected' });

beforeEach(() => {
  state.target = {
    id: TARGET,
    email: BREAKGLASS,
    role: 'admin',
    is_active: true,
    deleted_at: null,
  };
  state.otherAdmins = 5;
  state.countWhere = null;
  state.inserts = [];
  state.updates = [];
  vi.mocked(audit).mockClear();
});

describe('the break-glass admin is protected in Admin → Users', () => {
  it('409 breakglass_protected on disable, with an audit row and no write', async () => {
    const r = await request(app).patch(`/api/admin/users/${TARGET}`).send({ is_active: false });
    expect(r.status).toBe(409);
    expect(r.body).toEqual(PROTECTED);
    expect(state.updates).toHaveLength(0);
    expect(vi.mocked(audit).mock.calls[0]![0]).toMatchObject({
      actor_user_id: ACTOR,
      action: 'admin.user.breakglass_protected',
      target_id: TARGET,
    });
  });

  it('409 on demotion, however many other admins exist', async () => {
    for (const role of ['user', 'viewer']) {
      const r = await request(app).patch(`/api/admin/users/${TARGET}`).send({ role });
      expect([r.status, r.body]).toEqual([409, PROTECTED]);
    }
    expect(state.updates).toHaveLength(0);
  });

  it('409 on delete', async () => {
    const r = await request(app).delete(`/api/admin/users/${TARGET}`);
    expect([r.status, r.body]).toEqual([409, PROTECTED]);
    expect(state.updates).toHaveLength(0);
  });

  it('409 on an emailed reset — its address is not a mailbox', async () => {
    const r = await request(app).post(`/api/admin/users/${TARGET}/send-reset`);
    expect([r.status, r.body]).toEqual([409, PROTECTED]);
    expect(state.inserts).toHaveLength(0);
  });

  it('cannot be re-addressed: PATCH has no email field, so one is ignored', async () => {
    const r = await request(app)
      .patch(`/api/admin/users/${TARGET}`)
      .send({ email: 'moved@firm.test', display_name: 'Emergency admin' });
    expect(r.status).toBe(204);
    expect(state.updates[0]).toMatchObject({ display_name: 'Emergency admin' });
    expect(state.updates[0]).not.toHaveProperty('email');
  });

  it('its address is reserved: no ordinary account can be created on it', async () => {
    const r = await request(app).post('/api/admin/users').send({
      email: 'Vibe-Breakglass@vibe-tax.local',
      display_name: 'Impostor',
      role: 'user',
      password: 'long-enough-1',
    });
    expect([r.status, r.body]).toEqual([409, PROTECTED]);
    expect(state.inserts).toHaveLength(0);
  });

  it('harmless edits (keep admin, keep active) still work', async () => {
    const r = await request(app)
      .patch(`/api/admin/users/${TARGET}`)
      .send({ role: 'admin', is_active: true });
    expect(r.status).toBe(204);
  });
});

describe('last-admin protection does not count the break-glass row', () => {
  it('demoting the only real admin is refused even though break-glass is an active admin', async () => {
    state.target = { ...state.target!, email: 'partner@firm.test' };
    state.otherAdmins = 0; // what the query returns once break-glass is excluded
    const r = await request(app).patch(`/api/admin/users/${TARGET}`).send({ role: 'user' });
    expect([r.status, r.body]).toEqual([409, { error: 'last_admin_protected' }]);
    expect(paramsOf(state.countWhere)).toContain(BREAKGLASS);
    expect(paramsOf(state.countWhere)).toContain(TARGET);
  });
});

describe('an admin-set password ends the SSO-only state', () => {
  it('set-password marks has_local_password', async () => {
    state.target = { ...state.target!, email: 'jit@firm.test', role: 'user' };
    const r = await request(app)
      .post(`/api/admin/users/${TARGET}/set-password`)
      .send({ password: 'long-enough-1' });
    expect(r.status).toBe(204);
    expect(state.updates[0]).toMatchObject({ has_local_password: true });
  });
});
