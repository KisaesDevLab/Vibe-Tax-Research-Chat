// One place that mints a session: access + refresh pair with the refresh row
// written in a single INSERT. Used by password login, refresh rotation, the
// first-run bootstrap and the SSO hand-off exchange.
//
// The previous insert-'pending'-then-update dance (insert a placeholder to
// learn the row id, sign the refresh with it as `jti`, then write the real
// hash) collided on the UNIQUE token_hash whenever two logins raced: both
// rows carried 'pending' at the same instant. Minting the jti up front with
// randomUUID() lets the row land with its real hash the first time.
import crypto from 'node:crypto';
import { and, eq, isNull, ne } from 'drizzle-orm';
import type { Db } from '@vibe/db';
import { auth_refresh_tokens } from '@vibe/db/schema';
import { signAccess, signRefresh, hashToken, type AccessClaims } from './jwt.js';

/** Matches the refresh JWT's 30d default; the DB row is the authority. */
export const REFRESH_ROW_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface IssuedTokens {
  access_token: string;
  refresh_token: string;
  jti: string;
}

export async function issueTokens(
  db: Db,
  user: { id: string; role: AccessClaims['role']; email: string },
  meta: { user_agent?: string | null; ip?: string | null; sid?: string | null } = {},
): Promise<IssuedTokens> {
  const jti = crypto.randomUUID();
  const refresh_token = signRefresh({ sub: user.id, jti });
  await db.insert(auth_refresh_tokens).values({
    id: jti,
    user_id: user.id,
    token_hash: hashToken(refresh_token),
    expires_at: new Date(Date.now() + REFRESH_ROW_TTL_MS),
    user_agent: meta.user_agent ?? null,
    ip: meta.ip ?? null,
    sid: meta.sid ?? null,
  });
  const access_token = signAccess({
    sub: user.id,
    role: user.role,
    email: user.email,
    ...(meta.sid ? { sid: meta.sid } : {}),
  });
  return { access_token, refresh_token, jti };
}

/** Ends an SSO-born refresh chain (every rotation kept the same sid). */
export async function revokeRefreshBySid(db: Db, sid: string): Promise<void> {
  await db
    .update(auth_refresh_tokens)
    .set({ revoked_at: new Date() })
    .where(and(eq(auth_refresh_tokens.sid, sid), isNull(auth_refresh_tokens.revoked_at)));
}

/** Ends every live refresh chain of a user (local and SSO alike), optionally
 *  sparing one row — the caller's own session on a password change. */
export async function revokeRefreshByUser(
  db: Db,
  userId: string,
  opts: { exceptJti?: string | null } = {},
): Promise<void> {
  const live = and(eq(auth_refresh_tokens.user_id, userId), isNull(auth_refresh_tokens.revoked_at));
  await db
    .update(auth_refresh_tokens)
    .set({ revoked_at: new Date() })
    .where(opts.exceptJti ? and(live, ne(auth_refresh_tokens.id, opts.exceptJti)) : live);
}
