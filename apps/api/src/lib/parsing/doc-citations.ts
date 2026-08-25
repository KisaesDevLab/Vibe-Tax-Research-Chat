// TP-8a — extract the plan-mode doc_citations sidecar ({documentId, page,
// claim}[]) from assistant output. Same shape tolerance as the authorities
// parser: tagged fence, generic JSON fence with a doc_citations key, bare
// object/array. Closing fences optional (truncated streams still parse).
import type { DocCitation } from '@vibe/shared';

const TAGGED_FENCE_RE = /```(?:json|jsonc)?\s*doc_citations\s*\n([\s\S]*?)(?:```|$)/i;
const JSON_FENCE_RE = /```(?:json|jsonc)?\s*\n([\s\S]*?)(?:```|$)/gi;
const BARE_OBJECT_RE =
  /(?:^|\n\s*\n)\s*(\{[\s\S]*?"doc_citations"\s*:[\s\S]*?\})\s*(?=\n\s*\n|\s*$)/m;

function isDocCitation(p: unknown): p is DocCitation {
  return (
    typeof p === 'object' &&
    p !== null &&
    typeof (p as { documentId?: unknown }).documentId === 'string' &&
    typeof (p as { page?: unknown }).page === 'number' &&
    typeof (p as { claim?: unknown }).claim === 'string'
  );
}

function fromAny(v: unknown): DocCitation[] | null {
  if (Array.isArray(v)) {
    // A bare array only counts when it holds citation-shaped items (or is
    // empty INSIDE a tagged fence — the caller decides tagged context).
    const filtered = v.filter(isDocCitation);
    return filtered.length === v.length ? filtered : filtered.length > 0 ? filtered : null;
  }
  if (
    v &&
    typeof v === 'object' &&
    Array.isArray((v as { doc_citations?: unknown }).doc_citations)
  ) {
    return ((v as { doc_citations: unknown[] }).doc_citations ?? []).filter(isDocCitation);
  }
  return null;
}

function tryParse(json: string): DocCitation[] | null {
  try {
    return fromAny(JSON.parse(json));
  } catch {
    return null;
  }
}

export function extractDocCitations(text: string): DocCitation[] {
  const tagged = text.match(TAGGED_FENCE_RE);
  if (tagged) {
    const body = tagged[1]!.trim();
    try {
      const parsed = JSON.parse(body);
      if (Array.isArray(parsed)) return parsed.filter(isDocCitation); // [] allowed in tagged form
    } catch {
      /* fall through */
    }
    const out = tryParse(body);
    if (out) return out;
  }

  for (const m of text.matchAll(JSON_FENCE_RE)) {
    if (!/"doc_citations"/.test(m[1]!.slice(0, 200))) continue;
    const out = tryParse(m[1]!.trim());
    if (out) return out;
  }

  const bare = text.match(BARE_OBJECT_RE);
  if (bare) {
    const out = tryParse(bare[1]!);
    if (out) return out;
  }
  return [];
}

/** Marks citations whose {documentId, page} pair appeared in this turn's
 *  retrieved excerpts — ungrounded citations render with a warning chip. */
export function decorateGrounding(
  citations: DocCitation[],
  excerpts: Array<{ document_id: string; page: number }>,
): DocCitation[] {
  const seen = new Set(excerpts.map((e) => `${e.document_id}:${e.page}`));
  return citations.map((c) => ({ ...c, grounded: seen.has(`${c.documentId}:${c.page}`) }));
}
