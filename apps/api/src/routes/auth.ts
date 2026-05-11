// Phase 3 — auth routes: /login, /refresh, /logout.
// Phase XX — /forgot-password, /reset-password.
import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import bcrypt from 'bcrypt';
import { z } from 'zod';
import { eq, and, isNull } from 'drizzle-orm';
import { getDb } from '@vibe/db';
import { users, auth_refresh_tokens, password_reset_tokens } from '@vibe/db/schema';
import { signAccess, signRefresh, verifyRefresh, hashToken } from '../lib/jwt.js';
import { loginLimiter, forgotPasswordLimiter, resetPasswordLimiter } from '../lib/rate-limit.js';
import { audit } from '../lib/audit.js';
import { logger } from '../lib/logger.js';
import { requireAuth } from '../middleware/auth.js';
import { ACCESS_COOKIE_NAME, accessCookieOptions } from '../lib/cookies.js';
import { buildMailer } from '../lib/email/index.js';
import { notificationsEmailQueue } from '../jobs/queues.js';

function setAccessCookie(req: Request, res: Response, token: string) {
  res.cookie(ACCESS_COOKIE_NAME, token, accessCookieOptions(req));
}
function clearAccessCookie(req: Request, res: Response) {
  res.clearCookie(ACCESS_COOKIE_NAME, { ...accessCookieOptions(req), maxAge: 0 });
}

export const authRouter = Router();

const loginSchema = z.object({
  email: z.string().email().toLowerCase(),
  password: z.string().min(1),
});

authRouter.post('/login', loginLimiter, async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  const { email, password } = parsed.data;
  const db = getDb();
  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);

  if (!user || !user.is_active || user.deleted_at) {
    await audit({
      action: 'auth.login.failure',
      metadata: { email, reason: 'no_user' },
      ip: req.ip,
    });
    res.status(401).json({ error: 'invalid_credentials' });
    return;
  }
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) {
    await audit({
      actor_user_id: user.id,
      action: 'auth.login.failure',
      metadata: { reason: 'bad_password' },
      ip: req.ip,
    });
    res.status(401).json({ error: 'invalid_credentials' });
    return;
  }

  // Issue refresh
  const refreshRow = await db
    .insert(auth_refresh_tokens)
    .values({
      user_id: user.id,
      token_hash: 'pending',
      expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      user_agent: req.headers['user-agent'] ?? null,
      ip: req.ip ?? null,
    })
    .returning({ id: auth_refresh_tokens.id });
  const jti = refreshRow[0]!.id;
  const refresh_token = signRefresh({ sub: user.id, jti });
  await db
    .update(auth_refresh_tokens)
    .set({ token_hash: hashToken(refresh_token) })
    .where(eq(auth_refresh_tokens.id, jti));

  await db.update(users).set({ last_login_at: new Date() }).where(eq(users.id, user.id));

  const access_token = signAccess({ sub: user.id, role: user.role, email: user.email });
  setAccessCookie(req, res, access_token);
  await audit({ actor_user_id: user.id, action: 'auth.login.success', ip: req.ip });

  res.json({
    access_token,
    refresh_token,
    user: {
      id: user.id,
      email: user.email,
      display_name: user.display_name,
      role: user.role,
      is_active: user.is_active,
      monthly_spend_cap_usd: user.monthly_spend_cap_usd ? Number(user.monthly_spend_cap_usd) : null,
      can_override_model: user.can_override_model,
    },
  });
});

const refreshSchema = z.object({ refresh_token: z.string() });

authRouter.post('/refresh', async (req, res) => {
  const parsed = refreshSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  let claims: { sub: string; jti: string };
  try {
    claims = verifyRefresh(parsed.data.refresh_token);
  } catch {
    res.status(401).json({ error: 'invalid_refresh' });
    return;
  }
  const db = getDb();
  const [row] = await db
    .select()
    .from(auth_refresh_tokens)
    .where(
      and(
        eq(auth_refresh_tokens.id, claims.jti),
        eq(auth_refresh_tokens.token_hash, hashToken(parsed.data.refresh_token)),
        isNull(auth_refresh_tokens.revoked_at),
      ),
    )
    .limit(1);
  if (!row || row.expires_at < new Date()) {
    res.status(401).json({ error: 'invalid_refresh' });
    return;
  }
  const [user] = await db.select().from(users).where(eq(users.id, claims.sub)).limit(1);
  if (!user || !user.is_active) {
    res.status(401).json({ error: 'invalid_refresh' });
    return;
  }

  // Rotate
  await db
    .update(auth_refresh_tokens)
    .set({ revoked_at: new Date(), rotated_at: new Date() })
    .where(eq(auth_refresh_tokens.id, row.id));

  const newRow = await db
    .insert(auth_refresh_tokens)
    .values({
      user_id: user.id,
      token_hash: 'pending',
      expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      user_agent: req.headers['user-agent'] ?? null,
      ip: req.ip ?? null,
    })
    .returning({ id: auth_refresh_tokens.id });
  const newJti = newRow[0]!.id;
  const refresh_token = signRefresh({ sub: user.id, jti: newJti });
  await db
    .update(auth_refresh_tokens)
    .set({ token_hash: hashToken(refresh_token) })
    .where(eq(auth_refresh_tokens.id, newJti));

  const access_token = signAccess({ sub: user.id, role: user.role, email: user.email });
  setAccessCookie(req, res, access_token);
  await audit({ actor_user_id: user.id, action: 'auth.refresh', ip: req.ip });
  res.json({ access_token, refresh_token });
});

authRouter.post('/logout', requireAuth, async (req, res) => {
  const parsed = refreshSchema.safeParse(req.body);
  if (parsed.success) {
    try {
      const claims = verifyRefresh(parsed.data.refresh_token);
      await getDb()
        .update(auth_refresh_tokens)
        .set({ revoked_at: new Date() })
        .where(eq(auth_refresh_tokens.id, claims.jti));
    } catch {
      // ignore
    }
  }
  clearAccessCookie(req, res);
  await audit({ actor_user_id: req.auth?.user_id, action: 'auth.logout', ip: req.ip });
  res.status(204).end();
});

authRouter.get('/me', requireAuth, async (req, res) => {
  const [user] = await getDb().select().from(users).where(eq(users.id, req.auth!.user_id)).limit(1);
  if (!user) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.json({
    id: user.id,
    email: user.email,
    display_name: user.display_name,
    role: user.role,
    is_active: user.is_active,
    monthly_spend_cap_usd: user.monthly_spend_cap_usd ? Number(user.monthly_spend_cap_usd) : null,
    can_override_model: user.can_override_model,
  });
});

// ── Password reset ───────────────────────────────────────────────────────
// /forgot-password is intentionally anti-enumeration: response is identical
// whether or not the email matches an active user, whether or not email is
// configured, and whether or not the enqueue succeeded. The audit log
// records what actually happened for the admin's benefit.

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1h
const RESET_TOKEN_BYTES = 32; // 256-bit token → 43-char base64url

const forgotSchema = z.object({ email: z.string().email().toLowerCase() });

authRouter.post('/forgot-password', forgotPasswordLimiter, async (req, res) => {
  const parsed = forgotSchema.safeParse(req.body);
  // Always respond ok, even on malformed input, so callers can't probe
  // for valid-vs-invalid email shapes via the response.
  if (!parsed.success) {
    res.json({ ok: true });
    return;
  }
  const { email } = parsed.data;
  const db = getDb();
  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  const eligible = Boolean(user && user.is_active && !user.deleted_at);

  await audit({
    actor_user_id: user?.id ?? null,
    action: 'auth.forgot_password.request',
    metadata: { email, eligible },
    ip: req.ip,
  });

  if (eligible && user) {
    const mailer = await buildMailer();
    if (!mailer) {
      // Email transport not configured — log it loudly so the admin can
      // find out via /admin/queues or logs, but don't leak that to the
      // requester. The user will simply never receive an email.
      logger.warn({ email }, 'forgot-password requested but email not configured');
    } else {
      const token = crypto.randomBytes(RESET_TOKEN_BYTES).toString('base64url');
      const tokenHash = hashToken(token);
      const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);
      await db.insert(password_reset_tokens).values({
        user_id: user.id,
        token_hash: tokenHash,
        expires_at: expiresAt,
        created_via: 'self_service',
      });
      await notificationsEmailQueue.add('password-reset', {
        kind: 'password-reset',
        user_id: user.id,
        email: user.email,
        token,
        expires_at: expiresAt.toISOString(),
      });
    }
  }
  res.json({ ok: true });
});

const resetSchema = z.object({
  token: z.string().min(20),
  new_password: z.string().min(8).max(256),
});

authRouter.post('/reset-password', resetPasswordLimiter, async (req, res) => {
  const parsed = resetSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'bad_request', detail: parsed.error.flatten() });
    return;
  }
  const { token, new_password } = parsed.data;
  const tokenHash = hashToken(token);
  const db = getDb();
  const [row] = await db
    .select()
    .from(password_reset_tokens)
    .where(eq(password_reset_tokens.token_hash, tokenHash))
    .limit(1);
  if (!row || row.claimed_at || row.expires_at < new Date()) {
    res.status(400).json({ error: 'invalid_or_expired_token' });
    return;
  }
  const [user] = await db.select().from(users).where(eq(users.id, row.user_id)).limit(1);
  if (!user || !user.is_active || user.deleted_at) {
    res.status(400).json({ error: 'invalid_or_expired_token' });
    return;
  }

  const password_hash = await bcrypt.hash(new_password, 12);
  await db
    .update(users)
    .set({ password_hash, updated_at: new Date() })
    .where(eq(users.id, user.id));
  await db
    .update(password_reset_tokens)
    .set({ claimed_at: new Date() })
    .where(eq(password_reset_tokens.id, row.id));
  // Revoke every active refresh token for this user. If their account was
  // compromised, the attacker's existing sessions are killed; if they
  // simply forgot the password, this is a minor inconvenience.
  await db
    .update(auth_refresh_tokens)
    .set({ revoked_at: new Date() })
    .where(and(eq(auth_refresh_tokens.user_id, user.id), isNull(auth_refresh_tokens.revoked_at)));
  await audit({
    actor_user_id: user.id,
    action: 'auth.password_reset.complete',
    target_type: 'user',
    target_id: user.id,
    metadata: { reset_token_id: row.id, created_via: row.created_via },
    ip: req.ip,
  });
  res.json({ ok: true });
});
