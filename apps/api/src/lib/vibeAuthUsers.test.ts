// lib/vibeAuthUsers — the UserAdapter over `users` and the audit sink.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import bcrypt from 'bcrypt';
import { PgDialect } from 'drizzle-orm/pg-core';
import { users } from '@vibe/db/schema';

vi.mock('./audit.js', () => ({ audit: vi.fn(async () => undefined) }));

type Row = Record<string, unknown>;
const state: { rows: Row[]; inserts: Row[]; updates: Row[]; wheres: unknown[] } = {
  rows: [],
  inserts: [],
  updates: [],
  wheres: [],
};

vi.mock('@vibe/db', () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: (cond: unknown) => {
          state.wheres.push(cond);
          return { limit: async () => state.rows };
        },
      }),
    }),
    insert: () => ({
      values: (v: Row) => {
        state.inserts.push(v);
        return { returning: async () => [{ ...baseRow, ...v }] };
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

import {
  breakglassEmailFor,
  createVibeUsers,
  localLoginIdentifier,
  toVibeUser,
  vibeAuditSink,
  VIBE_TRC_ROLES,
} from './vibeAuthUsers.js';
import { audit } from './audit.js';

const dialect = new PgDialect();
const paramsOf = (cond: unknown): unknown[] => dialect.sqlToQuery(cond as never).params;

const baseRow = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'pat@firm.test',
  password_hash: '$2b$12$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ012345678',
  role: 'user',
  display_name: 'Pat',
  is_active: true,
  monthly_spend_cap_usd: null,
  can_override_model: true,
  created_at: new Date(),
  updated_at: new Date(),
  last_login_at: null,
  deleted_at: null,
};

beforeEach(() => {
  state.rows = [];
  state.inserts = [];
  state.updates = [];
  state.wheres = [];
  vi.mocked(audit).mockClear();
});

describe('break-glass addressing', () => {
  it('maps the package username to a TLD-bearing email and back', () => {
    expect(breakglassEmailFor('vibe-breakglass')).toBe('vibe-breakglass@vibe-tax.local');
    expect(localLoginIdentifier('VIBE-BREAKGLASS@vibe-tax.local')).toBe('vibe-breakglass');
    expect(localLoginIdentifier('Pat@Firm.test')).toBe('pat@firm.test');
  });

  it('findByUsername queries the implied email; an email passes through', async () => {
    const u = createVibeUsers();
    await u.findByUsername('vibe-breakglass');
    expect(paramsOf(state.wheres[0])).toEqual(['vibe-breakglass@vibe-tax.local']);
    await u.findByUsername('Someone@Firm.test');
    expect(paramsOf(state.wheres[1])).toEqual(['someone@firm.test']);
  });

  it('roles vocabulary is most-privileged-first with admin as the break-glass role', () => {
    expect(VIBE_TRC_ROLES.roles[0]).toBe('admin');
    expect(VIBE_TRC_ROLES.adminRole).toBe('admin');
    expect(VIBE_TRC_ROLES.defaultRoleMap).toMatchObject({
      'vibe-partner': 'admin',
      'vibe-staff': 'user',
    });
  });
});

describe('row mapping', () => {
  it('a soft-deleted row is inactive, never a candidate for a fresh JIT insert', () => {
    expect(toVibeUser({ ...baseRow, deleted_at: new Date() } as never).active).toBe(false);
    expect(toVibeUser({ ...baseRow, is_active: false } as never).active).toBe(false);
    expect(toVibeUser(baseRow as never)).toMatchObject({
      id: baseRow.id,
      email: 'pat@firm.test',
      name: 'Pat',
      role: 'user',
      active: true,
    });
  });

  it('findById refuses non-uuid ids without touching the database', async () => {
    const u = createVibeUsers();
    expect(await u.findById('42')).toBeNull();
    expect(state.wheres).toHaveLength(0);
  });
});

describe('provisioning', () => {
  it('JIT create inserts an unusable bcrypt hash, active, display_name from name or email', async () => {
    const u = createVibeUsers();
    const created = await u.create({
      email: 'New@Firm.test',
      role: 'user',
      emailVerified: true,
      issuer: 'i',
      subject: 's',
    });
    const row = state.inserts[0]!;
    expect(row.email).toBe('new@firm.test');
    expect(row.display_name).toBe('new@firm.test');
    expect(row.is_active).toBe(true);
    expect(row.role).toBe('user');
    expect(String(row.password_hash)).toMatch(/^\$2[aby]\$12\$/);
    expect(await bcrypt.compare('', String(row.password_hash))).toBe(false);
    expect(created.email).toBe('new@firm.test');
  });

  it('createLocalUser derives the email from the username and ignores the CLI default', async () => {
    const u = createVibeUsers();
    await u.createLocalUser({
      username: 'vibe-breakglass',
      email: 'vibe-breakglass@localhost',
      name: 'Break glass',
      role: 'admin',
      password: 'Sup3r-secret!',
    });
    const row = state.inserts[0]!;
    expect(row.email).toBe('vibe-breakglass@vibe-tax.local');
    expect(row.role).toBe('admin');
    expect(row.is_active).toBe(true);
    expect(row.deleted_at).toBeNull();
    expect(await bcrypt.compare('Sup3r-secret!', String(row.password_hash))).toBe(true);
  });

  it('setActive(true) also clears deleted_at; setActive(false) only disables', async () => {
    const u = createVibeUsers();
    await u.setActive!(baseRow.id, true);
    await u.setActive!(baseRow.id, false);
    expect(state.updates[0]).toMatchObject({ is_active: true, deleted_at: null });
    expect(state.updates[1]).toMatchObject({ is_active: false });
    expect(state.updates[1]).not.toHaveProperty('deleted_at');
  });

  it('setLocalPassword hashes with cost 12', async () => {
    const u = createVibeUsers();
    await u.setLocalPassword(baseRow.id, 'n3w-pass-word');
    expect(String(state.updates[0]!.password_hash)).toMatch(/^\$2[aby]\$12\$/);
  });
});

describe('audit sink', () => {
  it('maps a package event onto audit_log: action = type, target auth/user, uuid-only actor', async () => {
    await vibeAuditSink.emit({
      type: 'vibe.auth.login.success',
      at: '2026-09-19T00:00:00Z',
      user_id: baseRow.id,
      method: 'oidc',
      ip: '10.0.0.1',
    });
    expect(audit).toHaveBeenCalledWith({
      actor_user_id: baseRow.id,
      action: 'vibe.auth.login.success',
      target_type: 'auth',
      target_id: baseRow.id,
      metadata: { user_id: baseRow.id, method: 'oidc', ip: '10.0.0.1', at: '2026-09-19T00:00:00Z' },
      ip: '10.0.0.1',
    });
  });

  it('a non-uuid actor (the CLI, "system") never reaches the uuid column', async () => {
    await vibeAuditSink.emit({
      type: 'vibe.auth.breakglass.rotated',
      at: 'now',
      actor: 'cli',
      user_id: baseRow.id,
    });
    expect(vi.mocked(audit).mock.calls[0]![0]).toMatchObject({
      actor_user_id: baseRow.id,
      target_id: baseRow.id,
    });
    await vibeAuditSink.emit({
      type: 'vibe.auth.idp.unreachable',
      at: 'now',
      issuer: 'https://idp',
    });
    expect(vi.mocked(audit).mock.calls[1]![0]).toMatchObject({
      actor_user_id: null,
      target_id: undefined,
      ip: undefined,
    });
  });
});
