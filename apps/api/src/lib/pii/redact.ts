// TP-11 — applies accepted PII hits to the message texts before the
// snapshot freezes. Replacements happen end-to-start per message so the
// recorded offsets stay valid while editing.
import type { PiiHit, PiiKind } from './detect.js';

const PLACEHOLDER: Record<PiiKind, string> = {
  ssn: '[REDACTED-SSN]',
  ein: '[REDACTED-EIN]',
  account: '[REDACTED-ACCOUNT]',
};

export function applyRedactions(texts: string[], accepted: PiiHit[]): string[] {
  const byMessage = new Map<number, PiiHit[]>();
  for (const hit of accepted) {
    const list = byMessage.get(hit.location.message_index) ?? [];
    list.push(hit);
    byMessage.set(hit.location.message_index, list);
  }
  return texts.map((text, i) => {
    const hitsHere = byMessage.get(i);
    if (!hitsHere || hitsHere.length === 0) return text;
    let out = text;
    for (const hit of [...hitsHere].sort((a, b) => b.location.start - a.location.start)) {
      out = out.slice(0, hit.location.start) + PLACEHOLDER[hit.kind] + out.slice(hit.location.end);
    }
    return out;
  });
}
