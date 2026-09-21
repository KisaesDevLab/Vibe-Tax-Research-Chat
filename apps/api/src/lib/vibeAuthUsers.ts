// SSO (Vibe Auth) — the two adapters that only need the database: the
// UserAdapter over `users` and the audit sink over `audit_log`. They live
// apart from lib/vibeAuth.ts because the break-glass CLI
// (src/vibeAuthAdapter.ts) loads them in a process that has no Express app
// and never starts the engine.
import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import { and, count, eq, isNull, ne } from 'drizzle-orm';
import type {
  AuditSink,
  CreateLocalUserInput,
  CreateUserInput,
  RoleVocabulary,
  UserAdapter,
  VibeUser,
} from '@kisaesdevlab/vibe-auth';
import { getDb } from '@vibe/db';
import { users, type User } from '@vibe/db/schema';
import { audit } from './audit.js';

/** Same cost as routes/auth.ts and the seed — one policy for every password hash. */
const BCRYPT_COST = 12;

/** Product roles, most privileged first (the package's `mostPrivileged`
 *  picks the earliest entry). Vibe groups map per the Vibe-Auth per-product
 *  plan: admin / IT / partner → admin, manager and staff → user. Nothing maps
 *  to viewer by default; an operator can from Settings → Authentication. */
export const VIBE_TRC_ROLES: RoleVocabulary = {
  roles: ['admin', 'user', 'viewer'],
  adminRole: 'admin',
  defaultRoleMap: {
    'vibe-admin': 'admin',
    'vibe-it': 'admin',
    'vibe-partner': 'admin',
    'vibe-manager': 'user',
    'vibe-staff': 'user',
  },
};

export const BREAKGLASS_USERNAME =
  process.env.VIBE_BREAKGLASS_USERNAME?.trim() || 'vibe-breakglass';

/** `users` has no username column, so the package's break-glass user is
 *  addressed by the email its username implies. Not `@localhost` (the
 *  package's own default): the login route's zod `.email()` wants a TLD. */
export function breakglassEmailFor(username: string): string {
  return `${username.trim().toLowerCase()}@vibe-tax.local`;
}

/** The break-glass row's address. Reserved: Admin → Users can neither create
 *  an account on it nor disable, demote or delete the one that holds it. */
export function breakglassEmail(): string {
  return breakglassEmailFor(BREAKGLASS_USERNAME);
}

export function isBreakglassEmail(email: string): boolean {
  return email.trim().toLowerCase() === breakglassEmail();
}

/** What the engine's `localLoginAllowed()` compares against the break-glass
 *  USERNAME: the username itself for that one account, the email otherwise. */
export function localLoginIdentifier(email: string): string {
  const e = email.trim().toLowerCase();
  return e === breakglassEmail() ? BREAKGLASS_USERNAME : e;
}

/** The login form's identifier → the `users.email` to look up. The Appliance
 *  prints only `username: vibe-breakglass`, so the literal username must work
 *  as well as the address it implies; everything else is already an email. */
export function loginEmailFor(identifier: string): string {
  const id = identifier.trim().toLowerCase();
  return id === BREAKGLASS_USERNAME.toLowerCase() ? breakglassEmail() : id;
}

/** An account that exists only because a single sign-on login provisioned it
 *  and that never held a usable local password (I7). Self-service reset is
 *  refused for it: otherwise whoever reads the mailbox mints a local
 *  credential for an account the identity provider governs — and keeps it
 *  after the IdP disables the person. An admin can still set one. */
export function isSsoOnlyAccount(user: Pick<User, 'has_local_password'>): boolean {
  return !user.has_local_password;
}

/** Active admins other than `excludeUserId`, NOT counting the break-glass row:
 *  an emergency account nobody signs in with day to day is not "another
 *  admin" when deciding whether someone may lose the role (I8). */
export async function countOtherActiveAdmins(excludeUserId: string): Promise<number> {
  const rows = await getDb()
    .select({ value: count() })
    .from(users)
    .where(
      and(
        eq(users.role, VIBE_TRC_ROLES.adminRole as User['role']),
        eq(users.is_active, true),
        isNull(users.deleted_at),
        ne(users.id, excludeUserId),
        ne(users.email, breakglassEmail()),
      ),
    );
  return Number(rows[0]?.value ?? 0);
}

/** Role syncs this adapter refused, waiting for the engine's audit event.
 *  Package ≤1.0.x treats `setRole` as infallible and emits
 *  `vibe.auth.role.changed` right after it; the audit sink below stamps that
 *  event `refused` so the log never claims a demotion that did not happen. */
const REFUSAL_MATCH_MS = 30_000;
const refusedRoleSyncs = new Map<string, { to: string; reason: string; at: number }>();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function toVibeUser(row: User): VibeUser {
  return {
    id: row.id,
    email: row.email,
    name: row.display_name,
    role: row.role,
    // A soft-deleted row keeps its (unique) email, so an IdP login for that
    // address must resolve to "inactive", never to a fresh JIT insert.
    active: row.is_active && !row.deleted_at,
    local: true,
    username: row.email.split('@')[0] ?? row.email,
  };
}

/** A bcrypt hash of random bytes nobody knows: satisfies NOT NULL, can never be logged in with. */
async function unusablePasswordHash(): Promise<string> {
  return bcrypt.hash(crypto.randomBytes(48).toString('base64url'), BCRYPT_COST);
}

/** `countOtherActiveAdmins` is what newer package versions ask before a role
 *  sync; on the pinned one only this adapter's own `setRole` guard uses it. */
export type VibeTrcUserAdapter = UserAdapter & {
  countOtherActiveAdmins(excludeUserId: string): Promise<number>;
};

export function createVibeUsers(): VibeTrcUserAdapter {
  const db = () => getDb();
  const byEmail = async (email: string): Promise<VibeUser | null> => {
    const [row] = await db()
      .select()
      .from(users)
      .where(eq(users.email, email.trim().toLowerCase()))
      .limit(1);
    return row ? toVibeUser(row) : null;
  };
  return {
    async findById(id) {
      if (!UUID_RE.test(id)) return null;
      const [row] = await db().select().from(users).where(eq(users.id, id)).limit(1);
      return row ? toVibeUser(row) : null;
    },

    findByEmail: byEmail,

    async findByUsername(username) {
      return byEmail(username.includes('@') ? username : breakglassEmailFor(username));
    },

    /** Just-in-time provisioning from a verified IdP identity (I7): an
     *  unusable password, no forced rotation — the IdP is the credential. */
    async create(input: CreateUserInput) {
      const email = input.email.trim().toLowerCase();
      const [row] = await db()
        .insert(users)
        .values({
          email,
          display_name: (input.name ?? email).slice(0, 255),
          password_hash: await unusablePasswordHash(),
          has_local_password: false,
          role: input.role as User['role'],
          is_active: true,
        })
        .returning();
      return toVibeUser(row!);
    },

    countOtherActiveAdmins,

    /** Role sync (I8). Two writes are refused — silently, because a throw here
     *  would fail the person's sign-in — and audited instead:
     *   - the break-glass row never changes role (an IdP account on its
     *     address must not be able to demote the emergency admin);
     *   - the last active admin is never demoted. Role sync runs on the first
     *     SSO sign-in of an existing account too, so the seeded admin whose
     *     IdP groups map lower would otherwise lock the firm out of Admin. */
    async setRole(userId, role) {
      const [current] = await db().select().from(users).where(eq(users.id, userId)).limit(1);
      if (current && current.role !== role) {
        const reason = isBreakglassEmail(current.email)
          ? 'breakglass'
          : current.role === VIBE_TRC_ROLES.adminRole &&
              (await countOtherActiveAdmins(userId)) === 0
            ? 'last_admin'
            : null;
        if (reason) {
          refusedRoleSyncs.set(userId, { to: role, reason, at: Date.now() });
          return;
        }
      }
      await db()
        .update(users)
        .set({ role: role as User['role'], updated_at: new Date() })
        .where(eq(users.id, userId));
    },

    /** Break-glass provisioning (D12): an ACTIVE local admin with a real
     *  password. The email is derived from the username, never taken from
     *  the input — the CLI's default is `@localhost`, which cannot log in. */
    async createLocalUser(input: CreateLocalUserInput) {
      const [row] = await db()
        .insert(users)
        .values({
          email: breakglassEmailFor(input.username),
          display_name: input.name.slice(0, 255),
          password_hash: await bcrypt.hash(input.password, BCRYPT_COST),
          has_local_password: true,
          role: input.role as User['role'],
          is_active: true,
          deleted_at: null,
        })
        .returning();
      return toVibeUser(row!);
    },

    async setLocalPassword(userId, password) {
      await db()
        .update(users)
        .set({
          password_hash: await bcrypt.hash(password, BCRYPT_COST),
          has_local_password: true,
          updated_at: new Date(),
        })
        .where(eq(users.id, userId));
    },

    /** `ensure` reactivates a disabled break-glass account — including one
     *  an admin soft-deleted from Admin → Users. */
    async setActive(userId, active) {
      await db()
        .update(users)
        .set(
          active
            ? { is_active: true, deleted_at: null, updated_at: new Date() }
            : { is_active: false, updated_at: new Date() },
        )
        .where(eq(users.id, userId));
    },
  };
}

function uuidOrNull(v: unknown): string | null {
  return typeof v === 'string' && UUID_RE.test(v) ? v : null;
}

function stringOrUndefined(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : typeof v === 'number' ? String(v) : undefined;
}

/** Every package event lands in audit_log as one row: action = the event
 *  type (vibe.auth.*), target 'auth' + the user id, the payload as metadata
 *  (never contains tokens or secrets — see the package's audit schema).
 *  actor_user_id is a uuid column, so only uuid-shaped actors are recorded. */
export const vibeAuditSink: AuditSink = {
  async emit(event) {
    const { type, at, ...rest } = event;
    if (type === 'vibe.auth.role.changed' && typeof rest.user_id === 'string' && !rest.refused) {
      const refusal = refusedRoleSyncs.get(rest.user_id);
      if (refusal) {
        refusedRoleSyncs.delete(rest.user_id);
        if (refusal.to === rest.to && Date.now() - refusal.at < REFUSAL_MATCH_MS) {
          rest.refused = true;
          rest.reason = refusal.reason;
        }
      }
    }
    await audit({
      actor_user_id: uuidOrNull(rest.actor) ?? uuidOrNull(rest.user_id),
      action: type,
      target_type: 'auth',
      target_id: stringOrUndefined(rest.user_id),
      metadata: { ...rest, at },
      ip: stringOrUndefined(rest.ip),
    });
  },
};
