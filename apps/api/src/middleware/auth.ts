// Phase 3 — auth middleware: requireAuth + requireRole.
import type { Request, Response, NextFunction } from 'express';
import { verifyAccess } from '../lib/jwt.js';
import type { Role } from '@vibe/shared';

// Augment Express Request with auth context. Global form works with
// @types/express 4 + 5 alike.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: {
        user_id: string;
        email: string;
        role: Role;
        /** SSO session id when the token was minted by a Vibe Auth login. */
        sid?: string;
      };
    }
  }
}

// ── Revocation list (Vibe Auth, D16) ─────────────────────────────────────────
// Sessions are stateless JWTs, so an identity-provider back-channel logout
// (or a local sign-out that wants the access token dead NOW rather than in
// ≤15 min) can only take effect through a revocation list consulted at
// verify time — one indexed read of auth_revocations per request.
// lib/vibeAuth.ts registers the check at boot; until then nothing is
// revoked and no DB read happens. It is a hook rather than an import so
// this module (and every route test that mocks it) stays free of the SSO
// package.
export type RevocationCheck = (
  key: { userId: string; sid?: string },
  issuedAtMs: number,
) => Promise<boolean>;
let revocationCheck: RevocationCheck | null = null;

export function setRevocationCheck(fn: RevocationCheck | null): void {
  revocationCheck = fn;
}

/** `true` when the revocation list says this token was issued at or before
 *  the user's (or session's) last revocation moment. */
export async function isTokenRevoked(claims: {
  sub: string;
  sid?: string;
  iat?: number;
}): Promise<boolean> {
  if (!revocationCheck) return false;
  const iat = typeof claims.iat === 'number' ? claims.iat : 0;
  return revocationCheck({ userId: claims.sub, sid: claims.sid }, iat * 1000);
}

// Accept the access token from EITHER the Authorization header (the SPA's
// default path; tokens come from token-store / localStorage) OR a cookie
// named `vibe_at` (Bull Board / direct browser navigation, since browsers
// don't send Authorization on plain link clicks). The cookie is set by
// /api/auth/login (and refreshed by /api/auth/refresh) and cleared by
// /api/auth/logout.
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  let token: string | undefined;
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    token = header.slice('Bearer '.length);
  } else {
    const cookies = (req as Request & { cookies?: Record<string, string> }).cookies;
    if (cookies && typeof cookies.vibe_at === 'string') {
      token = cookies.vibe_at;
    }
  }
  if (!token) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  let claims;
  try {
    claims = verifyAccess(token);
  } catch {
    res.status(401).json({ error: 'invalid_token' });
    return;
  }
  // A revocation-list outage must fail closed, not hang or crash the
  // request: an IdP-initiated logout that we cannot verify is not honoured
  // by letting everyone through.
  try {
    if (await isTokenRevoked(claims)) {
      res.status(401).json({ error: 'token_revoked' });
      return;
    }
  } catch {
    res.status(503).json({ error: 'auth_unavailable' });
    return;
  }
  req.auth = {
    user_id: claims.sub,
    email: claims.email,
    role: claims.role,
    ...(claims.sid ? { sid: claims.sid } : {}),
  };
  next();
}

export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.auth) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    if (!roles.includes(req.auth.role)) {
      res.status(403).json({ error: 'forbidden', required_role: roles });
      return;
    }
    next();
  };
}
