// lib/vibeAuthUsers — the UserAdapter over `users` and the audit sink.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import bcrypt from 'bcrypt';
import { PgDialect } from 'drizzle-orm/pg-core';
import { users } from '@vibe/db/schema';

vi.mock('./audit.js', () => ({ audit: vi.fn(async () => undefined) }));

type Row = Record<string, unknown>;
const state: {
  rows: Row[];
  otherAdmins: number;
  inserts: Row[];
  updates: Row[];
  wheres: unknown[];
} = {
  rows: [],
  otherAdmins: 0,
  inserts: [],
  updates: [],
  wheres: [],
};

vi.mock('@vibe/db', () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        // `.limit()` ends a row lookup; awaited bare it is the admin count.
        where: (cond: unknown) => {
          state.wheres.push(cond);
          return Object.assign(Promise.resolve([{ value: state.otherAdmins }]), {
            limit: async () => state.rows,
          });
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
  isSsoOnlyAccount,
  localLoginIdentifier,
  loginEmailFor,
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
  has_local_password: true,
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
  state.otherAdmins = 0;
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

  it('the login identifier may be the bare username; anything else is already an email', () => {
    expect(loginEmailFor('vibe-breakglass')).toBe('vibe-breakglass@vibe-tax.local');
    expect(loginEmailFor(' Vibe-Breakglass ')).toBe('vibe-breakglass@vibe-tax.local');
    expect(loginEmailFor('vibe-breakglass@vibe-tax.local')).toBe('vibe-breakglass@vibe-tax.local');
    expect(loginEmailFor('Pat@Firm.test')).toBe('pat@firm.test');
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
  });

  // I8: explicit, never the package's guess (`defaultRoleMapFor` falls back to
  // the LEAST privileged role — `viewer` here — for a group it cannot match).
  it('pins the explicit defaultRoleMap for all five Vibe groups', () => {
    expect(VIBE_TRC_ROLES.roles).toEqual(['admin', 'user', 'viewer']);
    expect(VIBE_TRC_ROLES.defaultRoleMap).toEqual({
      'vibe-admin': 'admin',
      'vibe-it': 'admin',
      'vibe-partner': 'admin',
      'vibe-manager': 'user',
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
    // SSO-only until an admin gives it a password: self-service reset is refused.
    expect(row.has_local_password).toBe(false);
    expect(isSsoOnlyAccount(row as never)).toBe(true);
    expect(isSsoOnlyAccount(baseRow as never)).toBe(false);
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
    expect(row.has_local_password).toBe(true);
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
    expect(state.updates[0]!.has_local_password).toBe(true);
  });
});

describe('role sync guards (I8)', () => {
  const admin = { ...baseRow, role: 'admin' };
  const roleChanged = (to: string) =>
    vibeAuditSink.emit({
      type: 'vibe.auth.role.changed',
      at: 'now',
      user_id: baseRow.id,
      from: 'admin',
      to,
      source: 'groups',
    });

  it('never demotes the last active admin: no write, no throw, the engine event is stamped refused', async () => {
    state.rows = [admin];
    state.otherAdmins = 0;
    await expect(createVibeUsers().setRole(baseRow.id, 'user')).resolves.toBeUndefined();
    expect(state.updates).toHaveLength(0);
    // The count ignores the break-glass row — it is not "another admin".
    expect(paramsOf(state.wheres[1])).toContain('vibe-breakglass@vibe-tax.local');
    expect(paramsOf(state.wheres[1])).toContain(baseRow.id);

    await roleChanged('user');
    expect(vi.mocked(audit).mock.calls[0]![0]).toMatchObject({
      action: 'vibe.auth.role.changed',
      target_id: baseRow.id,
      metadata: { from: 'admin', to: 'user', refused: true, reason: 'last_admin' },
    });
    // One refusal stamps one event; a later genuine change is recorded as is.
    await roleChanged('user');
    expect(vi.mocked(audit).mock.calls[1]![0].metadata).not.toHaveProperty('refused');
  });

  it('demotes an admin when another active admin remains', async () => {
    state.rows = [admin];
    state.otherAdmins = 1;
    await createVibeUsers().setRole(baseRow.id, 'user');
    expect(state.updates[0]).toMatchObject({ role: 'user' });
    await roleChanged('user');
    expect(vi.mocked(audit).mock.calls[0]![0].metadata).not.toHaveProperty('refused');
  });

  it('promotions and non-admin changes never consult the admin count', async () => {
    state.rows = [baseRow];
    await createVibeUsers().setRole(baseRow.id, 'admin');
    expect(state.updates[0]).toMatchObject({ role: 'admin' });
    expect(state.wheres).toHaveLength(1);
  });

  it('the break-glass row never changes role, however many admins exist', async () => {
    state.rows = [{ ...admin, email: 'vibe-breakglass@vibe-tax.local' }];
    state.otherAdmins = 3;
    await createVibeUsers().setRole(baseRow.id, 'viewer');
    expect(state.updates).toHaveLength(0);
    await roleChanged('viewer');
    expect(vi.mocked(audit).mock.calls[0]![0].metadata).toMatchObject({
      refused: true,
      reason: 'breakglass',
    });
  });

  it('exposes countOtherActiveAdmins for package versions that ask before syncing', async () => {
    state.otherAdmins = 2;
    expect(await createVibeUsers().countOtherActiveAdmins(baseRow.id)).toBe(2);
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
