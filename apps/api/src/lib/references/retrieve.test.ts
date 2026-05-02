// Phase 32 — formatExcerptsForPrompt unit tests. The retrieval network
// path needs a real DB + Voyage; tested via end-to-end smoke. The pure
// formatting function (deterministic, no side effects) is well-suited
// to a unit test.
import { describe, expect, it } from 'vitest';
import { formatExcerptsForPrompt, type RetrievedExcerpt } from './retrieve.js';

const fixture: RetrievedExcerpt = {
  document_id: 'doc-1',
  document_title: 'Partnership 754 Memo',
  document_tags: ['partnership'],
  chunk_id: 'chunk-1',
  chunk_index: 0,
  similarity: 0.873,
  text: 'Section 754 elections are made on a per-partnership basis.',
  page_number: 3,
};

describe('formatExcerptsForPrompt', () => {
  it('returns an empty string for an empty excerpt list', () => {
    expect(formatExcerptsForPrompt([])).toBe('');
  });

  it('emits a <reference_excerpts> block with title, page, similarity, and body', () => {
    const out = formatExcerptsForPrompt([fixture]);
    expect(out).toContain('<reference_excerpts>');
    expect(out).toContain('</reference_excerpts>');
    expect(out).toContain('Partnership 754 Memo');
    expect(out).toContain('p.3');
    expect(out).toContain('similarity="0.87"');
    expect(out).toContain('Section 754 elections are made on a per-partnership basis.');
    expect(out).toContain('[Firm Reference: <title>, p.<page>]');
  });

  it('omits the page suffix when page_number is null', () => {
    const out = formatExcerptsForPrompt([{ ...fixture, page_number: null }]);
    expect(out).not.toContain('p.3');
    expect(out).toContain('Partnership 754 Memo');
  });

  it('escapes HTML-significant characters in titles', () => {
    const out = formatExcerptsForPrompt([{ ...fixture, document_title: 'Memo <draft> & "v2"' }]);
    expect(out).toContain('&lt;draft&gt;');
    expect(out).toContain('&amp;');
    expect(out).toContain('&quot;v2&quot;');
    // Make sure the raw bracket form did not survive
    expect(out).not.toContain('Memo <draft>');
  });

  it('renders multiple excerpts in order', () => {
    const a = { ...fixture, chunk_id: 'a', similarity: 0.9, text: 'AAA' };
    const b = { ...fixture, chunk_id: 'b', similarity: 0.7, text: 'BBB' };
    const out = formatExcerptsForPrompt([a, b]);
    const ai = out.indexOf('AAA');
    const bi = out.indexOf('BBB');
    expect(ai).toBeGreaterThan(-1);
    expect(bi).toBeGreaterThan(ai);
  });
});
