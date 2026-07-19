// TP-11 — seeded SSN/EIN fixtures; also feeds the TP-15 security
// checklist item "archive PII detect-pass exercised".
import { describe, it, expect } from 'vitest';
import { detectPii } from './detect.js';
import { applyRedactions } from './redact.js';

describe('detectPii', () => {
  it('finds dashed SSNs anywhere', () => {
    const hits = detectPii(['The taxpayer, SSN 123-45-6789, filed jointly.']);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.kind).toBe('ssn');
    expect(hits[0]!.match).toBe('123-45-6789');
  });

  it('finds EINs only near a label', () => {
    expect(detectPii(['Their EIN is 12-3456789.'])).toHaveLength(1);
    // Unlabelled — ambiguous with phone/date fragments, must NOT match.
    expect(detectPii(['Ref 12-3456789 on the invoice.'])).toHaveLength(0);
  });

  it('finds bare 9-digit runs only when labelled', () => {
    const ssn = detectPii(['social security number: 123456789']);
    expect(ssn).toHaveLength(1);
    expect(ssn[0]!.kind).toBe('ssn');
    expect(detectPii(['Order number 123456789 shipped.'])).toHaveLength(0);
  });

  it('finds account numbers only near account/routing labels', () => {
    const hits = detectPii(['Wire to account 123456789012, routing 021000021.']);
    expect(hits.map((h) => h.kind)).toEqual(['account', 'account']);
    expect(detectPii(['The year 20250101120000 appears here.'])).toHaveLength(0);
  });

  it('does not double-claim a span already matched as SSN', () => {
    const hits = detectPii(['SSN 123-45-6789 for the account holder.']);
    expect(hits).toHaveLength(1);
  });

  it('reports per-message locations', () => {
    const hits = detectPii(['clean text', 'SSN 123-45-6789']);
    expect(hits[0]!.location.message_index).toBe(1);
  });
});

describe('applyRedactions', () => {
  it('replaces accepted hits with typed placeholders', () => {
    const texts = ['SSN 123-45-6789 and EIN 12-3456789 on file.'];
    const hits = detectPii(texts);
    expect(hits).toHaveLength(2);
    const out = applyRedactions(texts, hits);
    expect(out[0]).toBe('SSN [REDACTED-SSN] and EIN [REDACTED-EIN] on file.');
  });

  it('handles multiple hits in one message end-to-start', () => {
    const texts = ['SSN 111-22-3333 then SSN 444-55-6666.'];
    const out = applyRedactions(texts, detectPii(texts));
    expect(out[0]).toBe('SSN [REDACTED-SSN] then SSN [REDACTED-SSN].');
  });

  it('leaves unaccepted hits in place', () => {
    const texts = ['SSN 111-22-3333 then SSN 444-55-6666.'];
    const hits = detectPii(texts);
    const out = applyRedactions(texts, [hits[0]!]);
    expect(out[0]).toBe('SSN [REDACTED-SSN] then SSN 444-55-6666.');
  });
});
