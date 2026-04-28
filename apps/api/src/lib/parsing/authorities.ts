// Phase 18 — extract the pack's JSON authorities sidecar from assistant output.
//
// The system prompt asks the model to emit ```json authorities ... ``` after
// the prose, but in practice the model produces several shapes — the parser
// must accept all of them or the AuthoritiesPanel renders nothing and the
// raw JSON gets stripped from the prose, leaving the user with no citations
// at all. We try, in order:
//
//   1. ```json authorities ... ```         — tagged fence, the spec form
//   2. ```authorities ... ```              — no `json` keyword
//   3. ```json\n{ "authorities": [...] }``` / generic JSON fence whose body
//      contains an `authorities` key
//   4. raw `{ "authorities": [...] }` or `[...]` with no fence
//
// In every case we look for either a top-level array of authority objects
// or an `authorities` array nested inside a top-level object.
import type { Authority } from '@vibe/shared';
import { logger } from '../logger.js';

// Tagged fences (cases 1 + 2). Closing fence is optional so a partial
// streamed message also parses.
const TAGGED_FENCE_RE = /```(?:json|jsonc)?\s*authorities\s*\n([\s\S]*?)(?:```|$)/i;

// Generic ```json fence whose body has an `authorities` key (case 3).
const JSON_FENCE_RE = /```(?:json|jsonc)?\s*\n([\s\S]*?)(?:```|$)/gi;

// Bare top-level JSON object with an authorities key (case 4). Anchored
// with a positive look-back so we don't grab inline mentions.
const BARE_OBJECT_RE =
  /(?:^|\n\s*\n)\s*(\{[\s\S]*?"authorities"\s*:[\s\S]*?\})\s*(?=\n\s*\n|\s*$)/m;

function isAuthority(p: unknown): p is Authority {
  return typeof p === 'object' && p !== null && 'cite' in p;
}

function fromAny(v: unknown): Authority[] | null {
  if (Array.isArray(v)) return v.filter(isAuthority);
  if (v && typeof v === 'object' && Array.isArray((v as { authorities?: unknown }).authorities)) {
    return ((v as { authorities: unknown[] }).authorities ?? []).filter(isAuthority);
  }
  return null;
}

function tryParse(json: string): Authority[] | null {
  try {
    return fromAny(JSON.parse(json));
  } catch {
    return null;
  }
}

export function extractAuthorities(text: string): Authority[] {
  // 1+2: tagged fence
  const tagged = text.match(TAGGED_FENCE_RE);
  if (tagged) {
    const out = tryParse(tagged[1]!.trim());
    if (out) return out;
  }

  // 3: any JSON fence whose body has an authorities key
  for (const m of text.matchAll(JSON_FENCE_RE)) {
    const body = m[1] ?? '';
    if (!/"authorities"\s*:/i.test(body)) continue;
    const out = tryParse(body.trim());
    if (out) return out;
  }

  // 4: bare top-level object
  const bare = text.match(BARE_OBJECT_RE);
  if (bare) {
    const out = tryParse(bare[1]!);
    if (out) return out;
    logger.warn({ snippet: bare[1]!.slice(0, 200) }, 'authorities bare-JSON parse failed');
  }

  return [];
}

// Cross-reference sidecar entries against primary_source_consultations rows for
// this message to compute the verification chip state.
export function decorateVerification(
  authorities: Authority[],
  consultations: Array<{ url?: string | null; domain?: string | null }>,
): Authority[] {
  const fetched = new Set<string>();
  for (const c of consultations) if (c.url) fetched.add(c.url);
  return authorities.map((a) => ({
    ...a,
    verified_this_turn: a.source ? fetched.has(a.source) : false,
  }));
}
