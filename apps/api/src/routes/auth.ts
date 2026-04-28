// Phase 3 — auth routes: /login, /refresh, /logout.
import { Router, type CookieOptions, type Response } from 'express';
import bcrypt from 'bcrypt';
import { z } from 'zod';
import { eq, and, isNull } from 'drizzle-orm';
import { getDb } from '@vibe/db';
import { users, auth_refresh_tokens } from '@vibe/db/schema';
import { signAccess, signRefresh, verifyRefresh, hashToken } from '../lib/jwt.js';
import { loginLimiter } from '../lib/rate-limit.js';
import { audit } from '../lib/audit.js';
import { requireAuth } from '../middleware/auth.js';
import { env } from '../config/env.js';

// httpOnly cookie that mirrors the access token. Used by routes that get
// hit via plain browser navigation (Bull Board) rather than the SPA's
// fetch-with-Authorization-header flow. Lifetime mirrors JWT_ACCESS_TTL
// loosely — re-set on every refresh.
const COOKIE_NAME = 'vibe_at';
function cookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    // In dev (http://localhost) Secure must be off or the browser drops
    // the cookie. In prod we serve over the appliance's TLS terminator.
    secure: env.NODE_ENV === 'production',
    path: '/',
    // 15-minute window; the SPA refreshes tokens itself, and refresh
    // updates the cookie too.
    maxAge: 15 * 60 * 1000,
  };
}
function setAccessCookie(res: Response, token: string) {
  res.cookie(COOKIE_NAME, token, cookieOptions());
}
function clearAccessCookie(res: Response) {
  res.clearCookie(COOKIE_NAME, { ...cookieOptions(), maxAge: 0 });
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
  setAccessCookie(res, access_token);
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
  setAccessCookie(res, access_token);
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
  clearAccessCookie(res);
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
