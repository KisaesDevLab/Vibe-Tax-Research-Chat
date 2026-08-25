// TP-8a — doc_citations sidecar: extractor shapes, grounding decoration,
// and BOTH strippers removing the new fence.
import { describe, expect, it } from 'vitest';
import { extractDocCitations, decorateGrounding } from './doc-citations.js';
import { stripSidecars } from './sidecars-strip.js';

const DOC_ID = '44444444-4444-4444-8444-444444444444';
const CITATION = {
  documentId: DOC_ID,
  filename: '1040_2024.pdf',
  page: 7,
  claim: 'MACRS basis of $850,000',
};

const TAGGED = `Cost segregation looks viable [Doc: 1040_2024.pdf, p.7].

\`\`\`doc_citations
[${JSON.stringify(CITATION)}]
\`\`\``;

describe('extractDocCitations', () => {
  it('parses the tagged fence (spec form) and the empty array', () => {
    expect(extractDocCitations(TAGGED)).toEqual([CITATION]);
    expect(extractDocCitations('Prose.\n\n```doc_citations\n[]\n```')).toEqual([]);
  });

  it('parses a generic json fence with a doc_citations key', () => {
    const text = `Prose.\n\n\`\`\`json\n{"doc_citations": [${JSON.stringify(CITATION)}]}\n\`\`\``;
    expect(extractDocCitations(text)).toEqual([CITATION]);
  });

  it('parses a bare object and tolerates an unclosed fence', () => {
    const bare = `Prose.\n\n{"doc_citations": [${JSON.stringify(CITATION)}]}`;
    expect(extractDocCitations(bare)).toEqual([CITATION]);
    const unclosed = `Prose.\n\n\`\`\`doc_citations\n[${JSON.stringify(CITATION)}]`;
    expect(extractDocCitations(unclosed)).toEqual([CITATION]);
  });

  it('drops malformed items and returns [] with no sidecar', () => {
    const text = `\`\`\`doc_citations\n[${JSON.stringify(CITATION)}, {"page": "seven"}]\n\`\`\``;
    expect(extractDocCitations(text)).toEqual([CITATION]);
    expect(extractDocCitations('no sidecar here')).toEqual([]);
  });

  it('decorateGrounding marks pairs seen in the retrieved excerpts', () => {
    const decorated = decorateGrounding([CITATION], [{ document_id: DOC_ID, page: 7 }]);
    expect(decorated[0]?.grounded).toBe(true);
    const off = decorateGrounding([CITATION], [{ document_id: DOC_ID, page: 8 }]);
    expect(off[0]?.grounded).toBe(false);
  });
});

describe('stripSidecars removes doc_citations (api side)', () => {
  it('strips the tagged fence but keeps the prose and other fences', () => {
    const stripped = stripSidecars(TAGGED);
    expect(stripped).toContain('Cost segregation looks viable');
    expect(stripped).not.toContain('doc_citations');
    expect(stripped).not.toContain(DOC_ID);
    // Ordinary code fences survive.
    const code = 'Look:\n\n```py\nprint(1)\n```';
    expect(stripSidecars(code)).toContain('print(1)');
  });

  it('strips the bare-object form', () => {
    const bare = `Prose stays.\n\n{"doc_citations": [${JSON.stringify(CITATION)}]}`;
    const stripped = stripSidecars(bare);
    expect(stripped).toBe('Prose stays.');
  });
});
