// TP-11 — local PII detector for the archival pass (applied default per
// QUESTIONS.md: no Shield/Presidio in this appliance yet; this module is
// the seam a Presidio-backed detector would replace).
//
// Kinds detected:
//   ssn     — 123-45-6789, plus bare 9-digit runs near an SSN-ish label
//   ein     — 12-3456789 (only near an EIN-ish label; the format is
//             otherwise ambiguous with phone fragments etc.)
//   account — 8–17 digit runs near an account/routing label
//
// Context guards keep false positives down: bare digit runs only count
// when labelled, and anything already matched is not re-matched.

export type PiiKind = 'ssn' | 'ein' | 'account';

export interface PiiHit {
  id: string;
  kind: PiiKind;
  match: string;
  /** ±40 chars around the match for the review UI. */
  context: string;
  location: { message_index: number; start: number; end: number };
}

const SSN_DASHED = /\b\d{3}-\d{2}-\d{4}\b/g;
const EIN_DASHED = /\b\d{2}-\d{7}\b/g;
const BARE_9 = /\b\d{9}\b/g;
const ACCOUNT_RUN = /\b\d{8,17}\b/g;

const SSN_LABEL = /\b(ssn|social security)\b/i;
const EIN_LABEL = /\b(ein|employer identification|fein|tax id)\b/i;
const ACCOUNT_LABEL = /\b(account|acct|routing|iban)\b/i;

const CONTEXT_RADIUS = 40;

function contextAround(text: string, start: number, end: number): string {
  return text.slice(
    Math.max(0, start - CONTEXT_RADIUS),
    Math.min(text.length, end + CONTEXT_RADIUS),
  );
}

function labelNear(text: string, start: number, end: number, label: RegExp): boolean {
  return label.test(contextAround(text, start, end));
}

export function detectPii(texts: string[]): PiiHit[] {
  const hits: PiiHit[] = [];
  let seq = 0;

  for (let messageIndex = 0; messageIndex < texts.length; messageIndex++) {
    const text = texts[messageIndex]!;
    // Spans already claimed by a higher-precision pattern; lower-precision
    // patterns skip anything overlapping them.
    const claimed: Array<[number, number]> = [];
    const overlaps = (s: number, e: number) => claimed.some(([cs, ce]) => s < ce && e > cs);

    const push = (kind: PiiKind, m: RegExpExecArray) => {
      const start = m.index!;
      const end = start + m[0].length;
      if (overlaps(start, end)) return;
      claimed.push([start, end]);
      hits.push({
        id: `pii-${messageIndex}-${seq++}`,
        kind,
        match: m[0],
        context: contextAround(text, start, end),
        location: { message_index: messageIndex, start, end },
      });
    };

    for (const m of text.matchAll(SSN_DASHED)) push('ssn', m as RegExpExecArray);
    for (const m of text.matchAll(EIN_DASHED)) {
      const start = m.index!;
      const end = start + m[0].length;
      if (labelNear(text, start, end, EIN_LABEL)) push('ein', m as RegExpExecArray);
    }
    for (const m of text.matchAll(BARE_9)) {
      const start = m.index!;
      const end = start + m[0].length;
      if (labelNear(text, start, end, SSN_LABEL)) push('ssn', m as RegExpExecArray);
      else if (labelNear(text, start, end, EIN_LABEL)) push('ein', m as RegExpExecArray);
    }
    for (const m of text.matchAll(ACCOUNT_RUN)) {
      const start = m.index!;
      const end = start + m[0].length;
      if (labelNear(text, start, end, ACCOUNT_LABEL)) push('account', m as RegExpExecArray);
    }
  }
  return hits;
}
