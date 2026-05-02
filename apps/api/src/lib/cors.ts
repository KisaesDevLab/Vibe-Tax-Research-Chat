// Parse the ALLOWED_ORIGIN env entry into a CORS origin matcher function.
//
// Format: comma-separated. Each entry is one of:
//   - literal: `https://tax.firm.com`
//   - regex:   `regex:^https://tax-[a-z0-9]+\.ts\.net$`
//   - emergency / dev IP: `http://192.168.1.42:5191`
//
// The appliance triplet (primary, Tailscale, emergency-IP) all need to be
// allowed simultaneously for the same browser session. Returning the first
// matched value (rather than `*`) keeps `credentials: true` working.
//
// Falls back to the single `PUBLIC_BASE_URL` value when ALLOWED_ORIGIN is
// unset or empty — preserves the standalone behavior unchanged.
import type { CorsOptions } from 'cors';
import { env } from '../config/env.js';

type OriginMatcher = (origin: string) => boolean;

// Trailing slash on a configured origin would make literal-equality miss
// the browser's Origin header (which never carries a trailing slash). Strip
// before comparing.
function normalize(entry: string): string {
  return entry.replace(/\/+$/, '');
}

export function buildOriginMatchers(raw: string): OriginMatcher[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map<OriginMatcher>((entry) => {
      if (entry.startsWith('regex:')) {
        const pattern = entry.slice('regex:'.length);
        try {
          const re = new RegExp(pattern);
          return (origin) => re.test(origin);
        } catch (err) {
          // Fail fast at startup with a clear message rather than crashing
          // on the first request that triggers the matcher.
          throw new Error(`ALLOWED_ORIGIN: invalid regex "${pattern}" — ${(err as Error).message}`);
        }
      }
      const literal = normalize(entry);
      return (origin) => origin === literal;
    });
}

export function corsOptions(): CorsOptions {
  // `||` (not `??`) so empty-string ALLOWED_ORIGIN= falls through to
  // PUBLIC_BASE_URL — empty is functionally identical to unset.
  const raw = env.ALLOWED_ORIGIN || env.PUBLIC_BASE_URL;
  const matchers = buildOriginMatchers(raw);
  return {
    credentials: true,
    origin(origin, cb) {
      // Same-origin and non-browser requests have no Origin header — let
      // them through unconditionally. CORS only matters when the browser
      // is sending one.
      if (!origin) {
        cb(null, true);
        return;
      }
      const ok = matchers.some((m) => m(origin));
      cb(null, ok ? origin : false);
    },
  };
}
