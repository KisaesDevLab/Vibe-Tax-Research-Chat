// TP-9 — licensing entitlement client (licensing.kisaes.com). Config is
// env-driven and OPTIONAL: with no LICENSING_URL the appliance runs the
// PolyForm Internal Use tier — internal/advisor rendering allowed
// (fail-open), client-facing rendering denied (fail-closed). Network
// failures follow the same split so a licensing outage never blocks
// staff work and never silently unlocks client delivery.
import { logger } from './logger.js';

export type EntitlementDirection = 'internal' | 'client-facing';

interface CacheEntry {
  value: boolean;
  expires: number;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000;

export async function checkEntitlement(
  entitlement: string,
  direction: EntitlementDirection,
): Promise<{ allowed: boolean; reason: string }> {
  const url = process.env.LICENSING_URL;
  const key = process.env.LICENSE_KEY;
  if (!url || !key) {
    return direction === 'internal'
      ? { allowed: true, reason: 'unlicensed_internal_fail_open' }
      : { allowed: false, reason: 'license_required' };
  }
  const cacheKey = `${entitlement}`;
  const hit = cache.get(cacheKey);
  if (hit && hit.expires > Date.now()) {
    return hit.value
      ? { allowed: true, reason: 'licensed' }
      : direction === 'internal'
        ? { allowed: true, reason: 'internal_fail_open' }
        : { allowed: false, reason: 'license_missing_entitlement' };
  }
  try {
    const res = await fetch(`${url.replace(/\/+$/, '')}/v1/entitlements/${entitlement}`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(5000),
    });
    const granted = res.ok && ((await res.json()) as { granted?: boolean }).granted === true;
    cache.set(cacheKey, { value: granted, expires: Date.now() + CACHE_TTL_MS });
    if (granted) return { allowed: true, reason: 'licensed' };
    return direction === 'internal'
      ? { allowed: true, reason: 'internal_fail_open' }
      : { allowed: false, reason: 'license_missing_entitlement' };
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'licensing check failed');
    return direction === 'internal'
      ? { allowed: true, reason: 'licensing_unreachable_internal_fail_open' }
      : { allowed: false, reason: 'licensing_unreachable_client_facing_fail_closed' };
  }
}

/** Test hook. */
export function clearEntitlementCache(): void {
  cache.clear();
}
