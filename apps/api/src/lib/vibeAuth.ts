// SSO (Vibe Auth) — single sign-on for Vibe Tax Research Chat.
//
// The package (@kisaesdevlab/vibe-auth) owns the OIDC flow (Authorization
// Code + PKCE), the Settings → Authentication API and the break-glass rules;
// this module is the product side of the contract:
//
//   - UserAdapter over `users` (lib/vibeAuthUsers.ts, shared with the CLI).
//   - SessionAdapter for a stateless-JWT product. There is no cookie session
//     to create: an SSO login parks the identity (issuer, subject, IdP
//     session id, ID token) in auth_sessions_oidc under a fresh `sid`, and
//     hands the SPA a ONE-TIME CODE on the fragment of the post-login
//     redirect — `/login#sso_code=<code>` — which POST /api/auth/sso/exchange
//     turns into the ordinary access + refresh pair (the access token carries
//     `sid`; every refresh rotation copies it). Tokens never ride a URL.
//   - Revocation list (D16): back-channel logout and local sign-out revoke by
//     user / sid; middleware/auth.ts consults the list on every verify.
//   - Identity / settings stores on the package tables, client secrets
//     wrapped with MASTER_KEY (lib/crypto.ts), audit events into audit_log.
//
// Paths. Every deployment strips the SPA prefix before the API sees a
// request (the Vite proxy, the web image's nginx, the appliance Caddy), so the
// engine routes on `/auth/*` with an empty basePath. The browser-facing
// prefix (`/tax` in multi-app mode) comes from the public URL and is applied
// to the paths the engine hands the browser: the login / break-glass pages,
// the post-login return and the test-connection popup.
import crypto from 'node:crypto';
import type { Request, RequestHandler, Response } from 'express';
import { and, eq, gt, isNull, lt, notExists, or, sql } from 'drizzle-orm';
import {
  createPgStores,
  createVibeAuth,
  sendHttpResponse,
  toHttpRequest,
  type HttpRequest,
  type HttpResponse,
  type SessionAdapter,
  type SessionIdentity,
  type VibeAuth,
  type VibeUser,
} from '@kisaesdevlab/vibe-auth';
import { getDb, getPool } from '@vibe/db';
import { auth_refresh_tokens, auth_sessions_oidc, users, SETTING_KEYS } from '@vibe/db/schema';
import { env } from '../config/env.js';
import { ACCESS_COOKIE_NAME, accessCookieOptions } from './cookies.js';
import { verifyAccess, type VerifiedAccess } from './jwt.js';
import { logger } from './logger.js';
import { ssoLimiter } from './rate-limit.js';
import { revokeRefreshBySid, revokeRefreshByUser } from './sessions.js';
import { unwrapClientSecretWith, wrapClientSecretWith } from './vibeAuthSecret.js';
import { getSetting } from './settings-store.js';
import { isTokenRevoked, setRevocationCheck } from '../middleware/auth.js';
import {
  VIBE_TRC_ROLES,
  createVibeUsers,
  localLoginIdentifier,
  vibeAuditSink,
} from './vibeAuthUsers.js';

export {
  BREAKGLASS_USERNAME,
  breakglassEmailFor,
  isBreakglassEmail,
  isSsoOnlyAccount,
  localLoginIdentifier,
  loginEmailFor,
} from './vibeAuthUsers.js';

/** Server-side prefix of the engine's routes. Always '/auth/...' — see the header comment. */
const AUTH_PREFIX = '/auth';

/** The one-time hand-off code lives this long after the callback. */
export const HANDOFF_TTL_MS = 60 * 1000;

/** Revocation records for a single session outlive the longest access token comfortably. */
const SID_REVOKE_TTL_MS = 24 * 60 * 60 * 1000;

function bearerFrom(req: Request): string | null {
  const h = req.headers.authorization;
  return h?.startsWith('Bearer ') ? h.slice(7) : null;
}

function verifySession(token: string): VerifiedAccess | null {
  try {
    return verifyAccess(token);
  } catch {
    return null;
  }
}

/** The settings page opens the test-connection popup by plain navigation,
 *  so no bearer header travels with it. That ONE route may authenticate with
 *  the `vibe_at` cookie; nothing else under /auth may — a Lax cookie honoured
 *  on GET /auth/oidc/logout would be a logout-CSRF. */
export function isTestStartNavigation(req: Pick<Request, 'method' | 'path' | 'query'>): boolean {
  return req.method === 'GET' && req.path === `${AUTH_PREFIX}/oidc/start` && req.query.test === '1';
}

export function sessionFor(req: Request): VerifiedAccess | null {
  const bearer = bearerFrom(req);
  if (bearer) return verifySession(bearer);
  if (isTestStartNavigation(req)) {
    const cookie = (req as Request & { cookies?: Record<string, string> }).cookies?.[
      ACCESS_COOKIE_NAME
    ];
    if (cookie) return verifySession(cookie);
  }
  return null;
}

/**
 * The package's stores speak parameterised SQL with $1..$n placeholders;
 * postgres.js runs those verbatim through `unsafe`. Two seams:
 *
 * - Dates are serialised HERE. The pool is the one drizzle owns, and
 *   drizzle-orm/postgres-js replaces the client's timestamp serializers with
 *   an identity function (it pre-serialises its own Date params), so a raw
 *   Date from the package would reach the wire as an object and blow up in
 *   Buffer.byteLength. ISO strings survive both paths.
 * - The RowList is spread into a plain array so the package sees exactly what
 *   it types.
 */
export function toPgParam(v: unknown): unknown {
  return v instanceof Date ? v.toISOString() : v;
}
const pgStores = createPgStores({
  query: async (text, params = []) =>
    [...(await getPool().unsafe(text, params.map(toPgParam) as never[]))] as Array<
      Record<string, unknown>
    >,
});

/**
 * A session row younger than this is never swept, however its chain looks:
 * the hand-off code may not have been exchanged yet (no refresh row exists
 * until it is), and clocks may disagree by a little.
 */
export function sweepGraceCutoff(nowMs: number): Date {
  return new Date(nowMs - 60 * 60 * 1000);
}

/** Ends one SSO-born session everywhere it lives: the identity row, its refresh
 *  chain, and — via the revocation list — the access token still in flight. */
export async function endSsoSession(sid: string): Promise<void> {
  const db = getDb();
  await db.delete(auth_sessions_oidc).where(eq(auth_sessions_oidc.sid, sid));
  await revokeRefreshBySid(db, sid);
  const now = new Date();
  await pgStores.revocations.revoke({ sid }, now, new Date(now.getTime() + SID_REVOKE_TTL_MS));
}

const sessions: SessionAdapter = {
  /** Park the identity under a fresh sid and stash the one-time code for the
   *  post-login redirect; vibeAuthMiddleware() appends it to the Location. */
  async create(_req: Request, res: Response, user: VibeUser, identity: SessionIdentity) {
    const db = getDb();
    const sid = crypto.randomBytes(16).toString('hex');
    const code = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    await db.insert(auth_sessions_oidc).values({
      sid,
      user_id: user.id,
      issuer: identity.issuer,
      subject: identity.subject,
      oidc_sid: identity.sid ?? null,
      id_token: identity.idToken ?? null,
      handoff_hash: crypto.createHash('sha256').update(code).digest('hex'),
      handoff_expires_at: new Date(now + HANDOFF_TTL_MS),
    });
    res.locals.vibeSsoCode = code;
    // Sweep rows whose session can no longer be used: no live refresh row
    // carries their sid (the chain expired, was revoked, or the hand-off was
    // never exchanged), past the grace hour. Keyed on chain liveness rather
    // than the row's age — every rotation pushes expires_at out another 30
    // days, so an actively used session must keep its identity row for as
    // long as it lives. The table is small; no scheduler needed.
    await db.delete(auth_sessions_oidc).where(
      and(
        lt(auth_sessions_oidc.created_at, sweepGraceCutoff(now)),
        notExists(
          db
            .select({ one: sql`1` })
            .from(auth_refresh_tokens)
            .where(
              and(
                eq(auth_refresh_tokens.sid, auth_sessions_oidc.sid),
                isNull(auth_refresh_tokens.revoked_at),
                gt(auth_refresh_tokens.expires_at, new Date(now)),
              ),
            ),
        ),
      ),
    );
  },

  async destroy(req: Request, res: Response) {
    const s = sessionFor(req);
    if (s?.sid) await endSsoSession(s.sid);
    res.clearCookie(ACCESS_COOKIE_NAME, { ...accessCookieOptions(req), maxAge: 0 });
  },

  async currentUserId(req: Request) {
    return sessionFor(req)?.sub ?? null;
  },

  async currentIdentity(req: Request) {
    const s = sessionFor(req);
    if (!s?.sid) return null;
    const [row] = await getDb()
      .select()
      .from(auth_sessions_oidc)
      .where(eq(auth_sessions_oidc.sid, s.sid))
      .limit(1);
    if (!row) return null;
    return {
      issuer: row.issuer,
      subject: row.subject,
      sid: row.oidc_sid ?? undefined,
      idToken: row.id_token ?? undefined,
    };
  },

  /**
   * Back-channel logout. The engine revokes `u:<user>` when the logout token
   * names a subject it can resolve, and `s:<IdP sid>` — which can never match
   * our tokens (their `sid` is our own id). So: every row we drop has its
   * internal sid revoked here (covers sid-only tokens), and a user-level
   * logout (sub / userId present) also ends the user's local-password
   * sessions — the person is signed out at the RP, full stop (I6; matches 1099).
   */
  async destroyByIdentity(i) {
    const conds = [];
    if (i.sid) conds.push(eq(auth_sessions_oidc.oidc_sid, i.sid));
    if (i.subject)
      conds.push(
        and(eq(auth_sessions_oidc.issuer, i.issuer), eq(auth_sessions_oidc.subject, i.subject)),
      );
    if (i.userId) conds.push(eq(auth_sessions_oidc.user_id, i.userId));
    if (!conds.length) return 0;
    const db = getDb();
    const deleted = await db
      .delete(auth_sessions_oidc)
      .where(conds.length === 1 ? conds[0] : or(...conds))
      .returning({ sid: auth_sessions_oidc.sid, user_id: auth_sessions_oidc.user_id });
    const now = new Date();
    for (const row of deleted) {
      await revokeRefreshBySid(db, row.sid);
      await pgStores.revocations.revoke(
        { sid: row.sid },
        now,
        new Date(now.getTime() + SID_REVOKE_TTL_MS),
      );
    }
    if (i.userId || i.subject) {
      const userIds = new Set(deleted.map((d) => d.user_id));
      if (i.userId) userIds.add(i.userId);
      for (const userId of userIds) {
        await revokeRefreshByUser(db, userId);
        await pgStores.revocations.revoke(
          { userId },
          now,
          new Date(now.getTime() + SID_REVOKE_TTL_MS),
        );
      }
    }
    return deleted.length;
  },
};

/** Settings → Authentication API + the test-connection popup: active admins
 *  whose token has not been revoked. */
async function authorizeAdmin(req: HttpRequest): Promise<{ userId: string } | null> {
  const s = sessionFor(req.raw.req as Request);
  if (!s || s.role !== VIBE_TRC_ROLES.adminRole) return null;
  if (await isTokenRevoked(s)) return null;
  const [row] = await getDb()
    .select({ is_active: users.is_active, deleted_at: users.deleted_at })
    .from(users)
    .where(eq(users.id, s.sub))
    .limit(1);
  if (!row?.is_active || row.deleted_at) return null;
  return { userId: s.sub };
}

let instance: VibeAuth | null = null;
let spaPrefix = '';

/** The browser-facing SPA prefix ('' or e.g. '/tax') the engine's paths are rewritten with. */
export function getSpaPrefix(): string {
  return spaPrefix;
}

/**
 * The product's public URL INCLUDING its prefix: the console's
 * VIBE_OIDC_PUBLIC_URL wins (written at registration), then the admin's
 * Settings → App base URL, then PUBLIC_BASE_URL. Changing it needs a restart,
 * like the other URL-derived config.
 */
export async function resolvePublicUrl(): Promise<string> {
  const fromEnv = process.env.VIBE_OIDC_PUBLIC_URL?.trim().replace(/\/+$/, '');
  if (fromEnv) return fromEnv;
  const fromSetting = await getSetting<string>(SETTING_KEYS.APP_BASE_URL).catch(() => null);
  if (typeof fromSetting === 'string' && fromSetting.trim())
    return fromSetting.trim().replace(/\/+$/, '');
  return env.PUBLIC_BASE_URL.replace(/\/+$/, '');
}

/**
 * Build the engine. index.ts calls this after migrations (the settings read
 * needs the schema); tests pass `publicUrl` to skip the database entirely.
 */
export async function initVibeAuth(opts: { publicUrl?: string } = {}): Promise<VibeAuth> {
  if (instance) return instance;
  const publicUrl = opts.publicUrl ?? (await resolvePublicUrl());
  try {
    spaPrefix = new URL(publicUrl).pathname.replace(/\/+$/, '');
  } catch {
    spaPrefix = '';
  }

  instance = createVibeAuth({
    product: { slug: 'vibe-tax-research', name: 'Vibe Tax Research Chat', roles: VIBE_TRC_ROLES },
    users: createVibeUsers(),
    session: sessions,
    identities: pgStores.identities,
    settings: pgStores.settings,
    revocations: pgStores.revocations,
    secretWrap: {
      wrap: async (plaintext) => wrapClientSecretWith(env.MASTER_KEY, plaintext),
      unwrap: async (wrapped) => unwrapClientSecretWith(env.MASTER_KEY, wrapped),
    },
    audit: vibeAuditSink,
    basePath: '',
    loginPath: `${spaPrefix}/login`,
    breakglassLoginPath: `${spaPrefix}/login/local`,
    // The login page reads the code off the fragment, so SSO always lands there.
    defaultReturnTo: `${spaPrefix}/login`,
    publicUrl,
    trustProxy: true,
    syncRoles: true,
    authorizeAdmin,
    logger: {
      info: (m, meta) => logger.info(meta ?? {}, `[vibe-auth] ${m}`),
      warn: (m, meta) => logger.warn(meta ?? {}, `[vibe-auth] ${m}`),
      error: (m, meta) => logger.error(meta ?? {}, `[vibe-auth] ${m}`),
    },
  });

  const auth = instance;
  setRevocationCheck((key, issuedAtMs) => auth.isRevoked(key, issuedAtMs));
  return instance;
}

export function getVibeAuth(): VibeAuth {
  if (!instance) throw new Error('vibe-auth: initVibeAuth() has not run');
  return instance;
}

/** Test seam: forget the engine so the next initVibeAuth() rebuilds it. */
export function resetVibeAuthForTests(): void {
  instance?.stop();
  instance = null;
  spaPrefix = '';
  setRevocationCheck(null);
}

/**
 * Boot: resolve config and begin IdP discovery. Throws only for the one
 * refusal the package makes at startup — oidc_only with no active break-glass
 * user — which index.ts turns into a fatal exit with the package's message.
 */
export async function startVibeAuth(): Promise<void> {
  const auth = getVibeAuth();
  await auth.start();
  const s = auth.status();
  logger.info(
    { mode: s.mode, sso: s.oidc.enabled ? s.oidc.issuer : 'off', prefix: spaPrefix || '/' },
    'vibe-auth ready',
  );
}

export const LOCAL_LOGIN_DISABLED = {
  error: 'local_login_disabled',
  message: 'Local sign-in is disabled for this product. Use single sign-on.',
} as const;

/** The sign-in policy for the password login route: `null` when the user may
 *  sign in locally, else the 403 body. In oidc_only only the break-glass user
 *  gets through. */
export function localLoginRefusal(email: string): typeof LOCAL_LOGIN_DISABLED | null {
  return getVibeAuth().localLoginAllowed(localLoginIdentifier(email)).allowed
    ? null
    : LOCAL_LOGIN_DISABLED;
}

/** The post-login hand-off: the one-time code rides the redirect's fragment, replacing any fragment already there. */
export function withSsoCode(location: string, code: string): string {
  return `${location.split('#')[0]}#sso_code=${encodeURIComponent(code)}`;
}

/**
 * Which /auth/* paths the rate limiter covers: the browser-driven OIDC steps
 * and the admin test-connection popup. NOT the back-channel logout — the
 * identity provider posts those from ONE address for every user — and not
 * the status / me / settings reads.
 */
const RATE_LIMITED_AUTH_PATHS = new Set([
  `${AUTH_PREFIX}/oidc/start`,
  `${AUTH_PREFIX}/oidc/callback`,
  `${AUTH_PREFIX}/oidc/exchange`,
  `${AUTH_PREFIX}/settings/test`,
]);
export function isRateLimitedAuthPath(path: string): boolean {
  return RATE_LIMITED_AUTH_PATHS.has(path.replace(/\/+$/, ''));
}

function isHtml(r: HttpResponse): boolean {
  return String(r.headers['content-type'] ?? '').startsWith('text/html');
}

function isJsonObject(body: unknown): body is Record<string, unknown> {
  return !!body && typeof body === 'object' && !Buffer.isBuffer(body) && !Array.isArray(body);
}

/** Prefix a path the engine built for the browser with the SPA prefix. */
function withPrefix(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  return v.startsWith(AUTH_PREFIX) ? spaPrefix + v : v;
}

async function handleAuthRequest(req: Request, res: Response): Promise<boolean> {
  const auth = getVibeAuth();
  const r = await auth.handle(toHttpRequest(req, res));
  if (!r) return false;

  // Post-login hand-off: the session adapter minted a one-time code; the SPA
  // reads it off the fragment, which never reaches a server or a log.
  const code = res.locals.vibeSsoCode as string | undefined;
  if (code && r.status >= 300 && r.status < 400 && typeof r.headers.location === 'string') {
    r.headers.location = withSsoCode(r.headers.location, code);
  }

  // Test-connection popup: the page calls POST /auth/settings/test with the
  // bearer, then opens the returned URL by plain navigation — which carries
  // only cookies. Refresh `vibe_at` from the bearer so the popup's
  // GET /auth/oidc/start?test=1 authenticates even if the cookie went stale.
  if (req.method === 'POST' && req.path === `${AUTH_PREFIX}/settings/test` && r.status === 200) {
    const bearer = bearerFrom(req);
    if (bearer) res.cookie(ACCESS_COOKIE_NAME, bearer, accessCookieOptions(req));
  }

  // Browser-facing paths in JSON answers get the SPA prefix (multi-app mode).
  if (spaPrefix && isJsonObject(r.body)) {
    if ('url' in r.body) r.body.url = withPrefix(r.body.url);
    const oidc = r.body.oidc;
    if (isJsonObject(oidc)) oidc.startPath = withPrefix(oidc.startPath);
    if ('breakglassPath' in r.body) r.body.breakglassPath = withPrefix(r.body.breakglassPath);
  }

  // The engine's own pages (logged out, sign-in error, test result) carry an
  // inline style and, for the popup, an inline postMessage script. Give them
  // a CSP that permits exactly that, and let the popup keep window.opener
  // (helmet's COOP would sever it).
  if (isHtml(r)) {
    r.headers['content-security-policy'] =
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
    res.removeHeader('Cross-Origin-Opener-Policy');
  }

  sendHttpResponse(res, r);
  return true;
}

/**
 * Express middleware for the engine's routes. Mount at app level, after the
 * body parsers and cookie-parser, before any router that applies requireAuth;
 * it passes every path outside /auth/* straight through.
 */
export function vibeAuthMiddleware(): RequestHandler {
  return (req, res, next) => {
    if (req.path !== AUTH_PREFIX && !req.path.startsWith(`${AUTH_PREFIX}/`)) return next();
    const run = () =>
      handleAuthRequest(req, res)
        .then((handled) => {
          if (!handled) next();
        })
        .catch(next);
    if (isRateLimitedAuthPath(req.path)) {
      ssoLimiter(req, res, (err?: unknown) => (err ? next(err) : run()));
      return;
    }
    run();
  };
}
