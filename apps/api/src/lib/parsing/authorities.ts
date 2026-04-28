// Phase 18 — extract the pack's JSON authorities sidecar from assistant output.
//
// The pack convention: assistant emits a fenced ```json block tagged
// `authorities` after the prose answer. This parser is tolerant — missing
// sidecar = empty array, malformed JSON = empty array (with a warning logged).
import type { Authority } from '@vibe/shared';
import { logger } from '../logger.js';

const SIDECAR_RE = /```(?:json)?\s+authorities\s*\n([\s\S]*?)\n```/i;

export function extractAuthorities(text: string): Authority[] {
  const m = text.match(SIDECAR_RE);
  if (!m) return [];
  try {
    const parsed = JSON.parse(m[1]!);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p): p is Authority => typeof p === 'object' && p !== null && 'cite' in p);
  } catch (err) {
    logger.warn({ err }, 'authorities sidecar JSON parse failed');
    return [];
  }
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
