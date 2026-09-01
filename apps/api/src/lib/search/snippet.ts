// Chat history search — snippet + pattern helpers shared by the search
// route and its tests. Pure functions; no DB access.
import { stripSidecars } from '../parsing/sidecars-strip.js';

/** Escape a user query for use inside an ILIKE pattern (`%…%`). */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/**
 * A short excerpt of `content` centred on the first case-insensitive hit
 * of `q`. Sidecar JSON and markdown noise are stripped first so the excerpt
 * reads as prose, whitespace is collapsed, and ellipses mark the cut edges.
 * Falls back to the leading `radius * 2` chars when the hit vanished with
 * the sidecars (e.g. the term only appeared in a JSON block).
 */
export function buildSnippet(content: string, q: string, radius = 70): string {
  const prose = stripSidecars(content)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#>*_`|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const needle = q.trim().toLowerCase();
  const idx = needle ? prose.toLowerCase().indexOf(needle) : -1;
  if (idx < 0) {
    const head = prose.slice(0, radius * 2);
    return prose.length > head.length ? `${head}…` : head;
  }
  const start = Math.max(0, idx - radius);
  const end = Math.min(prose.length, idx + needle.length + radius);
  // Snap to word boundaries so the excerpt doesn't open or close mid-word.
  const s = start > 0 ? prose.lastIndexOf(' ', start) + 1 || start : 0;
  const eSpace = prose.indexOf(' ', end);
  const e = end < prose.length && eSpace > 0 ? eSpace : end;
  return `${s > 0 ? '…' : ''}${prose.slice(s, e)}${e < prose.length ? '…' : ''}`;
}
