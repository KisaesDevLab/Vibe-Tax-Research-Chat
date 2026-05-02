// Phase 28 — first-run wizard endpoints. Auth-free, but only available when
// zero admins exist in the DB. Safe to call any time after setup — returns 409.
//
// Race safety: the `count(admins) > 0` check and the INSERT are wrapped in a
// SERIALIZABLE transaction so two simultaneous bootstrap requests can't both
// "see no admins" and both succeed.
import { Router } from 'express';
import bcrypt from 'bcrypt';
import { z } from 'zod';
import { eq, count, sql } from 'drizzle-orm';
import { getDb } from '@vibe/db';
import { users, auth_refresh_tokens } from '@vibe/db/schema';
import { audit } from '../lib/audit.js';
import { signAccess, signRefresh, hashToken } from '../lib/jwt.js';
import { setupBootstrapLimiter } from '../lib/rate-limit.js';
import { ACCESS_COOKIE_NAME, accessCookieOptions } from '../lib/cookies.js';

export const setupRouter = Router();

setupRouter.get('/status', async (_req, res) => {
  const rows = await getDb().select({ value: count() }).from(users).where(eq(users.role, 'admin'));
  const value = rows[0]?.value ?? 0;
  res.json({ admin_exists: Number(value) > 0 });
});

const bootstrapSchema = z.object({
  email: z.string().email().toLowerCase(),
  password: z.string().min(8),
  display_name: z.string().min(1).default('Administrator'),
});

setupRouter.post('/bootstrap', setupBootstrapLimiter, async (req, res) => {
  const parsed = bootstrapSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  const password_hash = await bcrypt.hash(parsed.data.password, 12);
  const db = getDb();

  let inserted: { id: string } | undefined;
  try {
    inserted = await db.transaction(async (tx) => {
      // Lock against concurrent bootstraps. A SERIALIZABLE isolation level
      // means a second concurrent transaction will fail-and-retry rather
      // than both seeing zero admins.
      await tx.execute(sql`SET LOCAL TRANSACTION ISOLATION LEVEL SERIALIZABLE`);
      const rows = await tx.select({ value: count() }).from(users).where(eq(users.role, 'admin'));
      const existing = Number(rows[0]?.value ?? 0);
      if (existing > 0) return undefined;
      const [row] = await tx
        .insert(users)
        .values({
          email: parsed.data.email,
          password_hash,
          role: 'admin',
          display_name: parsed.data.display_name,
          is_active: true,
        })
        .returning({ id: users.id });
      return row;
    });
  } catch (err) {
    // Unique-constraint collision (email already in use) — treat as conflict.
    res.status(409).json({ error: 'admin_already_exists', detail: (err as Error).message });
    return;
  }

  if (!inserted) {
    res.status(409).json({ error: 'admin_already_exists' });
    return;
  }

  // Issue an access + refresh token immediately so the wizard can call the
  // admin endpoints (key save, default model, sync) without a separate login.
  const refreshRow = await db
    .insert(auth_refresh_tokens)
    .values({
      user_id: inserted.id,
      token_hash: 'pending',
      expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      user_agent: req.headers['user-agent'] ?? null,
      ip: req.ip ?? null,
    })
    .returning({ id: auth_refresh_tokens.id });
  const jti = refreshRow[0]!.id;
  const refresh_token = signRefresh({ sub: inserted.id, jti });
  await db
    .update(auth_refresh_tokens)
    .set({ token_hash: hashToken(refresh_token) })
    .where(eq(auth_refresh_tokens.id, jti));
  const access_token = signAccess({
    sub: inserted.id,
    role: 'admin',
    email: parsed.data.email,
  });
  // Mirror into a cookie too, so /admin/queues (Bull Board) is reachable
  // immediately after bootstrap without a separate login.
  res.cookie(ACCESS_COOKIE_NAME, access_token, accessCookieOptions(req));

  await audit({
    actor_user_id: inserted.id,
    action: 'setup.bootstrap',
    metadata: { email: parsed.data.email },
    ip: req.ip,
  });

  res.status(201).json({
    ok: true,
    access_token,
    refresh_token,
    user: {
      id: inserted.id,
      email: parsed.data.email,
      display_name: parsed.data.display_name,
      role: 'admin' as const,
      is_active: true,
      monthly_spend_cap_usd: null,
      can_override_model: true,
    },
  });
});
