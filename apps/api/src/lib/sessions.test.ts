// lib/sessions — one INSERT per minted session, sid carried into the access
// token and onto the refresh row, jti === row id.
import { describe, it, expect, vi } from 'vitest';
import { auth_refresh_tokens } from '@vibe/db/schema';

vi.mock('../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-access-secret-test-access-secret-0000',
    JWT_REFRESH_SECRET: 'test-refresh-secret-test-refresh-secret-0',
    JWT_ACCESS_TTL: '15m',
    JWT_REFRESH_TTL: '30d',
  },
}));

import { issueTokens, revokeRefreshBySid, revokeRefreshByUser } from './sessions.js';
import { verifyAccess, verifyRefresh, hashToken } from './jwt.js';

type Row = Record<string, unknown>;

function fakeDb() {
  const inserts: Array<{ table: unknown; values: Row }> = [];
  const updates: Array<{ table: unknown; set: Row }> = [];
  const db = {
    insert: (table: unknown) => ({
      values: async (values: Row) => {
        inserts.push({ table, values });
      },
    }),
    update: (table: unknown) => ({
      set: (set: Row) => ({
        where: async () => {
          updates.push({ table, set });
        },
      }),
    }),
  };
  return { db: db as never, inserts, updates };
}

const user = {
  id: '11111111-1111-4111-8111-111111111111',
  role: 'user' as const,
  email: 'pat@firm.test',
};

describe('issueTokens', () => {
  it('writes ONE refresh row carrying the real hash, with jti === row id', async () => {
    const { db, inserts } = fakeDb();
    const t = await issueTokens(db, user, { user_agent: 'ua', ip: '1.2.3.4' });
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.table).toBe(auth_refresh_tokens);
    const row = inserts[0]!.values;
    expect(row.id).toBe(t.jti);
    expect(row.token_hash).toBe(hashToken(t.refresh_token));
    expect(row.token_hash).not.toBe('pending');
    expect(row.user_id).toBe(user.id);
    expect(row.sid).toBeNull();
    expect(verifyRefresh(t.refresh_token)).toMatchObject({ sub: user.id, jti: t.jti });
    const access = verifyAccess(t.access_token);
    expect(access).toMatchObject({ sub: user.id, role: 'user', email: user.email });
    expect(access.sid).toBeUndefined();
    expect(typeof access.iat).toBe('number');
  });

  it('propagates an SSO sid onto the row and into the access token, never into the refresh JWT', async () => {
    const { db, inserts } = fakeDb();
    const t = await issueTokens(db, user, { sid: 'abc123' });
    expect(inserts[0]!.values.sid).toBe('abc123');
    expect(verifyAccess(t.access_token).sid).toBe('abc123');
    expect(
      (verifyRefresh(t.refresh_token) as unknown as Record<string, unknown>).sid,
    ).toBeUndefined();
  });

  it('mints distinct jtis for concurrent logins (no shared placeholder row)', async () => {
    const { db, inserts } = fakeDb();
    const [a, b] = await Promise.all([issueTokens(db, user), issueTokens(db, user)]);
    expect(a.jti).not.toBe(b.jti);
    expect(new Set(inserts.map((i) => i.values.token_hash)).size).toBe(2);
  });
});

describe('revoke helpers', () => {
  it('stamp revoked_at on the refresh table', async () => {
    const { db, updates } = fakeDb();
    await revokeRefreshBySid(db, 'sid-1');
    await revokeRefreshByUser(db, user.id);
    expect(updates).toHaveLength(2);
    for (const u of updates) {
      expect(u.table).toBe(auth_refresh_tokens);
      expect(u.set.revoked_at).toBeInstanceOf(Date);
    }
  });
});
