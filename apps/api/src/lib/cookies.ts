// Shared cookie-options builder. Centralizes the Secure-flag policy so
// auth.ts and setup.ts can't drift. The policy is governed by the
// COOKIE_SECURE env var:
//
//   auto  — derive from req.secure (set Secure when the request came in
//           over HTTPS, including via X-Forwarded-Proto from a trusted
//           proxy). This is the right setting for the appliance: primary
//           access via Caddy is HTTPS so cookies get Secure, emergency
//           access on port 5191 is plain HTTP so cookies don't.
//   true  — always Secure. Breaks emergency mode but matches the
//           historical NODE_ENV=production behavior.
//   false — never Secure. Dev / test only.
//
// Requires `app.set('trust proxy', TRUST_PROXY)` for req.secure to reflect
// X-Forwarded-Proto from the proxy in front of the API.
import type { CookieOptions, Request } from 'express';
import { env } from '../config/env.js';

export const ACCESS_COOKIE_NAME = 'vibe_at';

const ACCESS_COOKIE_MAX_AGE_MS = 15 * 60 * 1000;

export function accessCookieOptions(req: Request): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: resolveSecure(req),
    path: '/',
    maxAge: ACCESS_COOKIE_MAX_AGE_MS,
  };
}

function resolveSecure(req: Request): boolean {
  switch (env.COOKIE_SECURE) {
    case 'true':
      return true;
    case 'false':
      return false;
    case 'auto':
    default:
      return Boolean(req.secure);
  }
}
