// Phase 3 — auth routes: /login, /refresh, /logout.
// Phase XX — /forgot-password, /reset-password.
// SSO — /sso/exchange (Vibe Auth hand-off), local-login policy, revocation.
import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import bcrypt from 'bcrypt';
import { z } from 'zod';
import { eq, and, isNull, ne, sql } from 'drizzle-orm';
import { getDb } from '@vibe/db';
import {
  users,
  auth_refresh_tokens,
  auth_sessions_oidc,
  password_reset_tokens,
  type User,
} from '@vibe/db/schema';
import { verifyRefresh, hashToken } from '../lib/jwt.js';
import { issueTokens } from '../lib/sessions.js';
import {
  loginLimiter,
  forgotPasswordLimiter,
  resetPasswordLimiter,
  ssoLimiter,
} from '../lib/rate-limit.js';
import { audit } from '../lib/audit.js';
import { logger } from '../lib/logger.js';
import { requireAuth, isTokenRevoked } from '../middleware/auth.js';
import { ACCESS_COOKIE_NAME, accessCookieOptions } from '../lib/cookies.js';
import { buildMailer } from '../lib/email/index.js';
import { notificationsEmailQueue } from '../jobs/queues.js';
import {
  endSsoSession,
  getVibeAuth,
  localLoginIdentifier,
  localLoginRefusal,
} from '../lib/vibeAuth.js';

function setAccessCookie(req: Request, res: Response, token: string) {
  res.cookie(ACCESS_COOKIE_NAME, token, accessCookieOptions(req));
}
function clearAccessCookie(req: Request, res: Response) {
  res.clearCookie(ACCESS_COOKIE_NAME, { ...accessCookieOptions(req), maxAge: 0 });
}

export const authRouter = Router();

/** The user shape every session-minting response carries (login, SSO exchange, /me). */
function publicUser(
  user: Pick<
    User,
    | 'id'
    | 'email'
    | 'display_name'
    | 'role'
    | 'is_active'
    | 'monthly_spend_cap_usd'
    | 'can_override_model'
  >,
) {
  return {
    id: user.id,
    email: user.email,
    display_name: user.display_name,
    role: user.role,
    is_active: user.is_active,
    monthly_spend_cap_usd: user.monthly_spend_cap_usd ? Number(user.monthly_spend_cap_usd) : null,
    can_override_model: user.can_override_model,
  };
}

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
  // SSO policy (I5): in oidc_only mode only the break-glass admin may use a
  // password. Inline rather than the package's guardLocalLogin so the
  // product's error envelope is kept.
  const refusal = localLoginRefusal(email);
  if (refusal) {
    res.status(403).json(refusal);
    return;
  }
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

  const { access_token, refresh_token } = await issueTokens(db, user, {
    user_agent: req.headers['user-agent'],
    ip: req.ip,
  });
  await db.update(users).set({ last_login_at: new Date() }).where(eq(users.id, user.id));

  setAccessCookie(req, res, access_token);
  await audit({ actor_user_id: user.id, action: 'auth.login.success', ip: req.ip });
  // vibe.auth.breakglass.used when this was the break-glass admin (D12 audit).
  await getVibeAuth().afterLocalLogin({
    userId: user.id,
    username: localLoginIdentifier(email),
    email: user.email,
    ip: req.ip,
  });

  res.json({ access_token, refresh_token, user: publicUser(user) });
});

// ── SSO hand-off ─────────────────────────────────────────────────────────
// The Vibe Auth callback (lib/vibeAuth.ts) parks the identity under a fresh
// `sid` and lands the SPA on /login#sso_code=<code>. The code is single-use
// and lives 60 s; claiming it here is one atomic UPDATE, so a replay (or two
// tabs racing) gets exactly one session. The response is the login shape,
// so the SPA stores it exactly as a password login. Rate-limited with the
// other browser-driven SSO steps (not the 5-per-window password limiter: the
// code is 256 random bits and single-use, and every SSO sign-in lands here).

const ssoExchangeSchema = z.object({ code: z.string().min(20).max(256) });

authRouter.post('/sso/exchange', ssoLimiter, async (req, res) => {
  const parsed = ssoExchangeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  const db = getDb();
  const handoffHash = hashToken(parsed.data.code);
  const [claimed] = await db
    .update(auth_sessions_oidc)
    .set({ handoff_claimed_at: new Date() })
    .where(
      and(
        eq(auth_sessions_oidc.handoff_hash, handoffHash),
        isNull(auth_sessions_oidc.handoff_claimed_at),
        sql`${auth_sessions_oidc.handoff_expires_at} > now()`,
      ),
    )
    .returning({ sid: auth_sessions_oidc.sid, user_id: auth_sessions_oidc.user_id });
  if (!claimed) {
    res.status(400).json({ error: 'invalid_or_expired_code' });
    return;
  }
  const [user] = await db.select().from(users).where(eq(users.id, claimed.user_id)).limit(1);
  if (!user || !user.is_active || user.deleted_at) {
    res.status(401).json({ error: 'invalid_credentials' });
    return;
  }

  const { access_token, refresh_token } = await issueTokens(db, user, {
    user_agent: req.headers['user-agent'],
    ip: req.ip,
    sid: claimed.sid,
  });
  await db.update(users).set({ last_login_at: new Date() }).where(eq(users.id, user.id));
  setAccessCookie(req, res, access_token);
  await audit({
    actor_user_id: user.id,
    action: 'auth.login.success',
    metadata: { method: 'oidc', sid: claimed.sid },
    ip: req.ip,
  });
  res.json({ access_token, refresh_token, user: publicUser(user) });
});

const refreshSchema = z.object({ refresh_token: z.string() });

authRouter.post('/refresh', async (req, res) => {
  const parsed = refreshSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  let claims;
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
  // Revocation list (SSO back-channel logout / sign-out): a refresh token
  // issued at or before the user's (or session's) revocation moment must
  // not mint a fresh pair — that is exactly how the SPA would otherwise
  // silently re-establish a session the identity provider ended.
  if (await isTokenRevoked({ sub: claims.sub, sid: row.sid ?? undefined, iat: claims.iat })) {
    res.status(401).json({ error: 'invalid_refresh' });
    return;
  }
  const [user] = await db.select().from(users).where(eq(users.id, claims.sub)).limit(1);
  if (!user || !user.is_active || user.deleted_at) {
    res.status(401).json({ error: 'invalid_refresh' });
    return;
  }

  // Rotate. An SSO-born chain keeps its sid so every later token stays
  // revocable by session.
  await db
    .update(auth_refresh_tokens)
    .set({ revoked_at: new Date(), rotated_at: new Date() })
    .where(eq(auth_refresh_tokens.id, row.id));
  const { access_token, refresh_token } = await issueTokens(db, user, {
    user_agent: req.headers['user-agent'],
    ip: req.ip,
    sid: row.sid,
  });
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
  // An SSO-born session is also ended server-side: identity row, the whole
  // refresh chain by sid, and the access token via the revocation list.
  if (req.auth?.sid) await endSsoSession(req.auth.sid);
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
  res.json(publicUser(user));
});

// ── Password change (logged-in self-service) ─────────────────────────────
// Requires the CURRENT password even though the caller holds a valid
// access token: a stolen/left-open session must not be enough to lock the
// real owner out. All other refresh tokens are revoked on success — the
// caller's own session survives by passing its refresh_token.

const changePasswordSchema = z.object({
  current_password: z.string().min(1),
  new_password: z.string().min(8).max(256),
  /** The caller's own refresh token; its session is kept alive. */
  refresh_token: z.string().optional(),
});

authRouter.post('/change-password', requireAuth, resetPasswordLimiter, async (req, res) => {
  const parsed = changePasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'bad_request', detail: parsed.error.flatten() });
    return;
  }
  const db = getDb();
  const [user] = await db.select().from(users).where(eq(users.id, req.auth!.user_id)).limit(1);
  if (!user || !user.is_active || user.deleted_at) {
    res.status(401).json({ error: 'invalid_credentials' });
    return;
  }
  const ok = await bcrypt.compare(parsed.data.current_password, user.password_hash);
  if (!ok) {
    await audit({
      actor_user_id: user.id,
      action: 'auth.password_change.failure',
      metadata: { reason: 'bad_current_password' },
      ip: req.ip,
    });
    res.status(403).json({ error: 'invalid_current_password' });
    return;
  }

  const password_hash = await bcrypt.hash(parsed.data.new_password, 12);
  await db
    .update(users)
    .set({ password_hash, updated_at: new Date() })
    .where(eq(users.id, user.id));

  // Kill every OTHER session. If the caller supplied its own (valid)
  // refresh token, that row is spared so they stay logged in here.
  let keepJti: string | null = null;
  if (parsed.data.refresh_token) {
    try {
      const claims = verifyRefresh(parsed.data.refresh_token);
      if (claims.sub === user.id) keepJti = claims.jti;
    } catch {
      // Unverifiable token: revoke everything, including this session.
    }
  }
  const revokeWhere = keepJti
    ? and(
        eq(auth_refresh_tokens.user_id, user.id),
        isNull(auth_refresh_tokens.revoked_at),
        ne(auth_refresh_tokens.id, keepJti),
      )
    : and(eq(auth_refresh_tokens.user_id, user.id), isNull(auth_refresh_tokens.revoked_at));
  await db.update(auth_refresh_tokens).set({ revoked_at: new Date() }).where(revokeWhere);

  await audit({
    actor_user_id: user.id,
    action: 'auth.password_change.success',
    target_type: 'user',
    target_id: user.id,
    metadata: { other_sessions_revoked: true, own_session_kept: Boolean(keepJti) },
    ip: req.ip,
  });
  res.json({ ok: true });
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
