// Question mode — `clarify` sidecar: extractor shapes, confidence
// normalization, and the api-side stripper removing the new fence.
import { describe, expect, it } from 'vitest';
import { extractClarification } from './clarify.js';
import { stripSidecars } from './sidecars-strip.js';

const ASKING = {
  status: 'asking',
  confidence: 0.6,
  question: 'Which tax year does the sale fall in?',
  options: ['2025', '2026'],
};
const READY = {
  status: 'ready',
  confidence: 0.95,
  summary: 'You confirmed a 2026 sale of a Missouri rental held by an S corporation.',
  plan: ['Verify §1250 recapture and the Missouri conformity position.', 'Draft the answer.'],
};

const TAGGED_ASKING = `Before I research this, one question.

Which tax year does the sale fall in?

\`\`\`clarify
${JSON.stringify(ASKING)}
\`\`\``;

describe('extractClarification', () => {
  it('parses the tagged fence (spec form) for both states', () => {
    expect(extractClarification(TAGGED_ASKING)).toEqual(ASKING);
    const ready = `Summary.\n\n\`\`\`json clarify\n${JSON.stringify(READY)}\n\`\`\``;
    expect(extractClarification(ready)).toEqual(READY);
  });

  it('parses a generic json fence and a bare object', () => {
    const generic = `Prose.\n\n\`\`\`json\n${JSON.stringify(ASKING)}\n\`\`\``;
    expect(extractClarification(generic)).toEqual(ASKING);
    const wrapped = `Prose.\n\n\`\`\`json\n{"clarify": ${JSON.stringify(READY)}}\n\`\`\``;
    expect(extractClarification(wrapped)).toEqual(READY);
    const bare = `Prose.\n\n${JSON.stringify(ASKING)}`;
    expect(extractClarification(bare)).toEqual(ASKING);
  });

  it('tolerates an unclosed fence (truncated stream)', () => {
    const unclosed = `Prose.\n\n\`\`\`clarify\n${JSON.stringify(ASKING)}`;
    expect(extractClarification(unclosed)).toEqual(ASKING);
  });

  it('normalizes percentage confidences and caps options / plan length', () => {
    const pct = extractClarification(
      `\`\`\`clarify\n${JSON.stringify({ ...ASKING, confidence: '95%' })}\n\`\`\``,
    );
    expect(pct?.confidence).toBe(0.95);
    const many = extractClarification(
      `\`\`\`clarify\n${JSON.stringify({ ...ASKING, options: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] })}\n\`\`\``,
    );
    expect(many?.options).toHaveLength(5);
    const longPlan = extractClarification(
      `\`\`\`clarify\n${JSON.stringify({ ...READY, plan: ['1', '2', '3'] })}\n\`\`\``,
    );
    expect(longPlan?.plan).toEqual(['1', '2']);
  });

  it('returns null for malformed or absent sidecars', () => {
    expect(extractClarification('no sidecar here')).toBeNull();
    // asking without a question is not a card
    expect(
      extractClarification(`\`\`\`clarify\n{"status": "asking", "confidence": 0.5}\n\`\`\``),
    ).toBeNull();
    // an unrelated status-bearing object (e.g. an API response the model quoted)
    expect(
      extractClarification(`\`\`\`json\n{"status": "ok", "question": "?"}\n\`\`\``),
    ).toBeNull();
    // the other sidecars are not mistaken for a card
    expect(extractClarification(`\`\`\`json compliance\n{"ssts_1_1": true}\n\`\`\``)).toBeNull();
  });
});

describe('stripSidecars removes clarify (api side)', () => {
  it('strips the tagged fence but keeps the prose', () => {
    const stripped = stripSidecars(TAGGED_ASKING);
    expect(stripped).toContain('Which tax year does the sale fall in?');
    expect(stripped).not.toContain('"status"');
    expect(stripped).not.toContain('clarify');
  });

  it('strips an untagged ```json fence and a bare object by their status value', () => {
    // The live failure: the model dropped the "clarify" tag and the card
    // rendered as a JSON wall under the prose.
    const untagged = `What type of mileage rate?\n\n\`\`\`json\n${JSON.stringify(ASKING, null, 2)}\n\`\`\``;
    expect(stripSidecars(untagged)).toBe('What type of mileage rate?');
    const bare = `Prose stays.\n\n${JSON.stringify(READY)}`;
    expect(stripSidecars(bare)).toBe('Prose stays.');
    // An unrelated status object is NOT a sidecar.
    const other = 'See:\n\n```json\n{"status": "ok", "id": 1}\n```';
    expect(stripSidecars(other)).toContain('"status": "ok"');
  });

  it('strips the wrapped bare-object form', () => {
    const bare = `Prose stays.\n\n{"clarify": ${JSON.stringify(READY)}}`;
    expect(stripSidecars(bare)).toBe('Prose stays.');
  });
});
