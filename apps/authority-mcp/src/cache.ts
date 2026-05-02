// Phase 34 — read-through cache for upstream authority lookups.
//
// Every tool call goes through `cachedLookup(source, cacheKey, ttlSeconds, fetchFn)`.
// The cache lives in the shared `authority_cache` Postgres table (schema
// is in @vibe/db). On a hit, we serve the parsed text with a freshness
// hint; on a miss we call the upstream fetch fn, persist, and return.
//
// TTL invariants (from BUILD_PLAN §34):
//   - USC + CFR + IRB:     30 days
//   - Federal Register:    24 hours
//   - DAWSON + state DOR:  7 days
//   - Public Law / popular-name table: 90 days
//
// Cache misses on transient upstream failure are NOT persisted as
// negative cache entries — better to retry next time than to lock in
// a bad fetch. Errors propagate to the caller.
import { and, eq, gt } from 'drizzle-orm';
import { getDb, schema } from '@vibe/db';
import { logger } from './logger.js';

export type AuthoritySource =
  | 'usc'
  | 'cfr'
  | 'irb'
  | 'fr'
  | 'dawson'
  | 'govinfo'
  | 'state_dor'
  | 'pl';

export const TTL_SECONDS: Record<AuthoritySource, number> = {
  usc: 30 * 24 * 60 * 60,
  cfr: 30 * 24 * 60 * 60,
  irb: 30 * 24 * 60 * 60,
  fr: 24 * 60 * 60,
  dawson: 7 * 24 * 60 * 60,
  govinfo: 30 * 24 * 60 * 60,
  state_dor: 7 * 24 * 60 * 60,
  pl: 90 * 24 * 60 * 60,
};

export interface FetchResult {
  /** Canonical URL for the upstream resource — surfaced as a citation. */
  canonicalUrl: string;
  /** Raw upstream payload (XML/JSON). Used for re-parsing on schema bumps. */
  rawText?: string | null;
  /** Cleaned text suited for the chat's context window. */
  parsedText: string;
  metadata?: Record<string, unknown>;
  upstreamStatus?: string;
  upstreamEtag?: string;
  upstreamLastModified?: string;
}

export interface CachedResult extends FetchResult {
  /** True when served from the cache without an upstream call. */
  fromCache: boolean;
  /** Seconds since the cached entry was fetched, or 0 on a fresh miss. */
  cacheAgeSeconds: number;
}

export async function cachedLookup(
  source: AuthoritySource,
  cacheKey: string,
  fetchFn: () => Promise<FetchResult>,
): Promise<CachedResult> {
  const ttlSeconds = TTL_SECONDS[source];
  const db = getDb();
  const now = new Date();

  const [hit] = await db
    .select()
    .from(schema.authority_cache)
    .where(
      and(
        eq(schema.authority_cache.source, source),
        eq(schema.authority_cache.cache_key, cacheKey),
        gt(schema.authority_cache.ttl_until, now),
      ),
    )
    .orderBy(schema.authority_cache.fetched_at)
    .limit(1);

  if (hit && hit.parsed_text) {
    const ageMs = now.getTime() - hit.fetched_at.getTime();
    logger.info(
      { source, cache_key: cacheKey, age_seconds: Math.round(ageMs / 1000) },
      'authority cache hit',
    );
    return {
      canonicalUrl: hit.canonical_url,
      rawText: hit.raw_text,
      parsedText: hit.parsed_text,
      metadata: (hit.metadata as Record<string, unknown> | null) ?? undefined,
      upstreamStatus: hit.upstream_status ?? undefined,
      upstreamEtag: hit.upstream_etag ?? undefined,
      upstreamLastModified: hit.upstream_last_modified ?? undefined,
      fromCache: true,
      cacheAgeSeconds: Math.round(ageMs / 1000),
    };
  }

  logger.info({ source, cache_key: cacheKey }, 'authority cache miss — fetching upstream');
  const fetched = await fetchFn();
  const ttlUntil = new Date(now.getTime() + ttlSeconds * 1000);
  await db.insert(schema.authority_cache).values({
    source,
    cache_key: cacheKey,
    canonical_url: fetched.canonicalUrl,
    raw_text: fetched.rawText ?? null,
    parsed_text: fetched.parsedText,
    metadata: fetched.metadata ?? {},
    fetched_at: now,
    ttl_until: ttlUntil,
    upstream_status: fetched.upstreamStatus ?? null,
    upstream_etag: fetched.upstreamEtag ?? null,
    upstream_last_modified: fetched.upstreamLastModified ?? null,
  });
  return {
    ...fetched,
    fromCache: false,
    cacheAgeSeconds: 0,
  };
}
