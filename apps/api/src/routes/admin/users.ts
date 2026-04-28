// Phase 4 — admin user CRUD + spend cap.
import { Router } from 'express';
import bcrypt from 'bcrypt';
import crypto from 'node:crypto';
import { z } from 'zod';
import { eq, ilike, or, isNull, and, ne, count } from 'drizzle-orm';
import { getDb } from '@vibe/db';
import { users } from '@vibe/db/schema';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { audit } from '../../lib/audit.js';

export const adminUsersRouter = Router();

adminUsersRouter.use(requireAuth, requireRole('admin'));

const uuidSchema = z.string().uuid();

const listSchema = z.object({
  q: z.string().optional(),
  active: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

adminUsersRouter.get('/', async (req, res) => {
  const parsed = listSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  const { q, active, limit, offset } = parsed.data;
  const db = getDb();
  const conditions = [isNull(users.deleted_at)];
  if (q) conditions.push(or(ilike(users.email, `%${q}%`), ilike(users.display_name, `%${q}%`))!);
  if (active === 'true') conditions.push(eq(users.is_active, true));
  if (active === 'false') conditions.push(eq(users.is_active, false));

  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      display_name: users.display_name,
      role: users.role,
      is_active: users.is_active,
      monthly_spend_cap_usd: users.monthly_spend_cap_usd,
      can_override_model: users.can_override_model,
      last_login_at: users.last_login_at,
      created_at: users.created_at,
    })
    .from(users)
    .where(and(...conditions))
    .limit(limit)
    .offset(offset);
  res.json({ users: rows, limit, offset });
});

const createSchema = z.object({
  email: z.string().email().toLowerCase(),
  display_name: z.string().min(1).max(120),
  role: z.enum(['admin', 'user', 'viewer']).default('user'),
  password: z.string().min(8),
  monthly_spend_cap_usd: z.number().nonnegative().nullable().default(null),
  can_override_model: z.boolean().default(true),
});

adminUsersRouter.post('/', async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'bad_request', detail: parsed.error.flatten() });
    return;
  }
  const password_hash = await bcrypt.hash(parsed.data.password, 12);
  const inserted = await getDb()
    .insert(users)
    .values({
      email: parsed.data.email,
      display_name: parsed.data.display_name,
      role: parsed.data.role,
      password_hash,
      monthly_spend_cap_usd: parsed.data.monthly_spend_cap_usd?.toString() ?? null,
      can_override_model: parsed.data.can_override_model,
    })
    .returning({ id: users.id });
  await audit({
    actor_user_id: req.auth!.user_id,
    action: 'admin.user.create',
    target_type: 'user',
    target_id: inserted[0]!.id,
    metadata: { email: parsed.data.email, role: parsed.data.role },
    ip: req.ip,
  });
  res.status(201).json({ id: inserted[0]!.id });
});

const patchSchema = z.object({
  display_name: z.string().min(1).max(120).optional(),
  role: z.enum(['admin', 'user', 'viewer']).optional(),
  is_active: z.boolean().optional(),
  monthly_spend_cap_usd: z.number().nonnegative().nullable().optional(),
  can_override_model: z.boolean().optional(),
});

// Count of active admins NOT including the supplied user-id. Used to guard
// against demoting / disabling / deleting the last remaining admin which
// would lock the appliance out of its own admin surface.
async function otherActiveAdminCount(excludeId: string): Promise<number> {
  const db = getDb();
  const rows = await db
    .select({ value: count() })
    .from(users)
    .where(
      and(
        eq(users.role, 'admin'),
        eq(users.is_active, true),
        isNull(users.deleted_at),
        ne(users.id, excludeId),
      ),
    );
  return Number(rows[0]?.value ?? 0);
}

adminUsersRouter.patch('/:id', async (req, res) => {
  if (!uuidSchema.safeParse(req.params.id).success) {
    res.status(400).json({ error: 'bad_request', detail: 'invalid id' });
    return;
  }
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  const db = getDb();
  const [target] = await db.select().from(users).where(eq(users.id, req.params.id)).limit(1);
  if (!target || target.deleted_at) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  // Self-protection: never let the actor demote, disable, or change their own role
  // to a non-admin / disable themselves. Admin can update display_name / cap etc.
  const isSelf = target.id === req.auth!.user_id;
  if (isSelf) {
    if (parsed.data.role !== undefined && parsed.data.role !== 'admin') {
      res.status(409).json({ error: 'cannot_demote_self' });
      return;
    }
    if (parsed.data.is_active === false) {
      res.status(409).json({ error: 'cannot_disable_self' });
      return;
    }
  }

  // Last-admin protection: any change that removes admin powers from `target`
  // must leave at least one other active admin standing.
  const removesAdminPower =
    (parsed.data.role !== undefined && parsed.data.role !== 'admin' && target.role === 'admin') ||
    (parsed.data.is_active === false && target.role === 'admin' && target.is_active);
  if (removesAdminPower) {
    const others = await otherActiveAdminCount(target.id);
    if (others === 0) {
      res.status(409).json({ error: 'last_admin_protected' });
      return;
    }
  }

  const update: Record<string, unknown> = { updated_at: new Date() };
  if (parsed.data.display_name !== undefined) update.display_name = parsed.data.display_name;
  if (parsed.data.role !== undefined) update.role = parsed.data.role;
  if (parsed.data.is_active !== undefined) update.is_active = parsed.data.is_active;
  if (parsed.data.monthly_spend_cap_usd !== undefined)
    update.monthly_spend_cap_usd = parsed.data.monthly_spend_cap_usd?.toString() ?? null;
  if (parsed.data.can_override_model !== undefined)
    update.can_override_model = parsed.data.can_override_model;

  await db.update(users).set(update).where(eq(users.id, req.params.id));
  await audit({
    actor_user_id: req.auth!.user_id,
    action: 'admin.user.update',
    target_type: 'user',
    target_id: req.params.id,
    metadata: parsed.data,
    ip: req.ip,
  });
  res.status(204).end();
});

adminUsersRouter.post('/:id/reset-password', async (req, res) => {
  if (!uuidSchema.safeParse(req.params.id).success) {
    res.status(400).json({ error: 'bad_request', detail: 'invalid id' });
    return;
  }
  // Cryptographically-random 32 bytes encoded url-safe base64 (~43 chars).
  // TODO Phase 4 follow-up: persist this in a `password_resets` table with
  // expiry + one-time use, and deliver via email.
  const reset_token = crypto.randomBytes(32).toString('base64url');
  await audit({
    actor_user_id: req.auth!.user_id,
    action: 'admin.user.reset_password',
    target_type: 'user',
    target_id: req.params.id,
    ip: req.ip,
  });
  res.json({ reset_token, note: 'TODO: deliver via email/SMS in Phase 4 follow-up.' });
});

adminUsersRouter.delete('/:id', async (req, res) => {
  if (!uuidSchema.safeParse(req.params.id).success) {
    res.status(400).json({ error: 'bad_request', detail: 'invalid id' });
    return;
  }
  const db = getDb();
  const [target] = await db.select().from(users).where(eq(users.id, req.params.id)).limit(1);
  if (!target || target.deleted_at) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  if (target.id === req.auth!.user_id) {
    res.status(409).json({ error: 'cannot_delete_self' });
    return;
  }
  if (target.role === 'admin' && target.is_active) {
    const others = await otherActiveAdminCount(target.id);
    if (others === 0) {
      res.status(409).json({ error: 'last_admin_protected' });
      return;
    }
  }

  await db
    .update(users)
    .set({ deleted_at: new Date(), is_active: false })
    .where(eq(users.id, req.params.id));
  await audit({
    actor_user_id: req.auth!.user_id,
    action: 'admin.user.delete',
    target_type: 'user',
    target_id: req.params.id,
    ip: req.ip,
  });
  res.status(204).end();
});
