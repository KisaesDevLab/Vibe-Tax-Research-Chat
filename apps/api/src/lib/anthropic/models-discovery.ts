// Anthropic Models API discovery.
//
// Calls GET https://api.anthropic.com/v1/models with the admin-stored
// API key. Anthropic's response is the source of truth for which models
// the appliance's key can actually invoke — including newly-released
// models that have not yet been baked into our bundled seed.
//
// Anthropic does NOT return pricing through this endpoint. Pricing comes
// from a separate manifest (bundled seed, or an upstream CDN if/when one
// exists). The admin/models refresh handler joins this discovery result
// with the pricing manifest before computing the DB diff.

import { getSetting } from '../settings-store.js';
import { SETTING_KEYS } from '@vibe/db/schema';
import { logger } from '../logger.js';

// Subset of the /v1/models response we actually consume. The full shape
// is larger (capabilities, types, etc.) — we keep the fields we use
// today and let the rest pass through untyped on `raw_capabilities`.
export interface DiscoveredModel {
  id: string;
  display_name: string;
  created_at: string;
  max_input_tokens?: number;
  max_tokens?: number;
  // Pass-through for the capabilities sub-tree so admins can later
  // surface supports-thinking, supports-code-execution, etc. We don't
  // narrow the shape — capabilities evolve quickly and any unknown
  // field would otherwise be dropped.
  capabilities?: Record<string, unknown>;
}

interface ListResponse {
  data: DiscoveredModel[];
  first_id: string;
  last_id: string;
  has_more: boolean;
}

const ANTHROPIC_API_BASE = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';
const PAGE_LIMIT = 100; // API supports up to 1000; 100 is plenty and pages defensively

export interface DiscoveryResult {
  ok: boolean;
  models: DiscoveredModel[];
  error?: string;
}

// Fetch the full list of available models from Anthropic. Returns
// { ok: false, error } on any failure (missing key, network error,
// non-2xx response, bad JSON). Callers decide whether to fall back to
// a bundled / upstream manifest.
export async function discoverAnthropicModels(): Promise<DiscoveryResult> {
  const key = await getSetting<string>(SETTING_KEYS.ANTHROPIC_API_KEY);
  if (!key) {
    return { ok: false, models: [], error: 'anthropic_api_key_not_set' };
  }

  const headers = {
    'x-api-key': key,
    'anthropic-version': ANTHROPIC_VERSION,
  };

  const all: DiscoveredModel[] = [];
  let cursor: string | undefined;
  let pageCount = 0;
  const MAX_PAGES = 20; // hard ceiling — > 2000 models would be unprecedented

  try {
    while (pageCount < MAX_PAGES) {
      const url = new URL('/v1/models', ANTHROPIC_API_BASE);
      url.searchParams.set('limit', String(PAGE_LIMIT));
      if (cursor) url.searchParams.set('after_id', cursor);

      const r = await fetch(url.toString(), {
        headers,
        signal: AbortSignal.timeout(10_000),
      });
      if (!r.ok) {
        return {
          ok: false,
          models: [],
          error: `HTTP ${r.status} ${r.statusText}`.trim(),
        };
      }
      const body = (await r.json()) as ListResponse;
      if (!Array.isArray(body.data)) {
        return { ok: false, models: [], error: 'malformed_response_missing_data_array' };
      }
      all.push(...body.data);
      if (!body.has_more || !body.last_id) break;
      cursor = body.last_id;
      pageCount++;
    }
    if (pageCount >= MAX_PAGES) {
      logger.warn({ pageCount }, 'anthropic models discovery hit max pages');
    }
    return { ok: true, models: all };
  } catch (err) {
    return { ok: false, models: [], error: (err as Error).message };
  }
}
