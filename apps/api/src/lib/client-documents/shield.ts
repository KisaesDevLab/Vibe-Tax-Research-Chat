// TP-3a — the Shield pass for client documents. Applied default vs. the
// addendum's "tokenized" language: this appliance has no tokenize/detokenize
// service, so redaction is IRREVERSIBLE ([REDACTED-SSN] etc.) and runs with
// every hit auto-accepted, BEFORE any derived text is stored and BEFORE any
// LLM call. The fact schema structurally excludes PII, so nothing is lost
// downstream. Raw PDF bytes at rest are untouched (existing storage rules).
import { detectPii } from '../pii/detect.js';
import { applyRedactions } from '../pii/redact.js';
import type { DocumentPage } from './pages.js';

export interface ShieldResult {
  pages: DocumentPage[];
  hitCount: number;
}

export function shieldPages(pages: DocumentPage[]): ShieldResult {
  const hits = detectPii(pages.map((p) => p.text));
  if (hits.length === 0) return { pages, hitCount: 0 };
  const redacted = applyRedactions(
    pages.map((p) => p.text),
    hits,
  );
  return {
    pages: pages.map((p, i) => ({ page: p.page, text: redacted[i] ?? p.text })),
    hitCount: hits.length,
  };
}
