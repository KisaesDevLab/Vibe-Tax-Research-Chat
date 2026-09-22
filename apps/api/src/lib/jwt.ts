// Phase 3 — JWT helpers. Access (15m) + refresh (30d) with separate secrets.
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { env } from '../config/env.js';

export interface AccessClaims {
  sub: string; // user id
  role: 'admin' | 'user' | 'viewer';
  email: string;
  /** SSO (Vibe Auth): internal session id of an SSO-born session. Absent
   *  for password logins. Carried across refresh rotation from the refresh
   *  ROW (never the refresh JWT), and consulted by the revocation list. */
  sid?: string;
}

export interface RefreshClaims {
  sub: string;
  jti: string; // refresh-token id (matches auth_refresh_tokens.id)
}

/** What verify() hands back: the claims plus the registered timestamps
 *  jsonwebtoken always stamps. `iat` is the revocation-list comparison key. */
export type VerifiedAccess = AccessClaims & { iat: number; exp: number };
export type VerifiedRefresh = RefreshClaims & { iat: number; exp: number };

export function signAccess(claims: AccessClaims): string {
  return jwt.sign(claims, env.JWT_SECRET, {
    expiresIn: env.JWT_ACCESS_TTL as jwt.SignOptions['expiresIn'],
  });
}

export function verifyAccess(token: string): VerifiedAccess {
  return jwt.verify(token, env.JWT_SECRET) as VerifiedAccess;
}

export function signRefresh(claims: RefreshClaims): string {
  return jwt.sign(claims, env.JWT_REFRESH_SECRET, {
    expiresIn: env.JWT_REFRESH_TTL as jwt.SignOptions['expiresIn'],
  });
}

export function verifyRefresh(token: string): VerifiedRefresh {
  return jwt.verify(token, env.JWT_REFRESH_SECRET) as VerifiedRefresh;
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}
