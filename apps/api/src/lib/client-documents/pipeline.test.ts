// TP-3a — pure pipeline pieces: page reconstruction, Shield pass, page-
// bounded chunking, docType heuristic.
import { describe, expect, it } from 'vitest';
import type { PdfToken } from '../intake/pdf-extract.js';
import { pagesFromTokens } from './pages.js';
import { shieldPages } from './shield.js';
import { chunkPages } from './chunker.js';
import { classifyDocTypeHeuristic } from './classify.js';

function tok(str: string, page: number, y: number, x: number): PdfToken {
  return { str, page, y, x, width: 10 };
}

describe('pagesFromTokens', () => {
  it('groups by page, rows y-desc, tokens x-asc within a row', () => {
    const pages = pagesFromTokens([
      tok('world', 1, 700, 60),
      tok('hello', 1, 700, 10),
      tok('below', 1, 650, 10),
      tok('page2', 2, 700, 10),
    ]);
    expect(pages).toHaveLength(2);
    expect(pages[0]).toEqual({ page: 1, text: 'hello world\nbelow' });
    expect(pages[1]).toEqual({ page: 2, text: 'page2' });
  });

  it('treats tokens within the y band as one row', () => {
    const pages = pagesFromTokens([tok('a', 1, 700, 10), tok('b', 1, 697, 40)]);
    expect(pages[0]!.text).toBe('a b');
  });
});

describe('shieldPages', () => {
  it('redacts SSNs before anything downstream sees the text', () => {
    const { pages, hitCount } = shieldPages([
      { page: 1, text: 'Taxpayer SSN: 123-45-6789 filing jointly' },
      { page: 2, text: 'no pii here' },
    ]);
    expect(hitCount).toBeGreaterThan(0);
    expect(pages[0]!.text).toContain('[REDACTED-SSN]');
    expect(pages[0]!.text).not.toContain('123-45-6789');
    expect(pages[1]!.text).toBe('no pii here');
  });
});

describe('chunkPages', () => {
  it('never spans pages and numbers chunks globally', () => {
    const long = 'A sentence of filler text. '.repeat(400); // > maxChars, splits
    const chunks = chunkPages([
      { page: 1, text: long },
      { page: 2, text: 'short page' },
      { page: 3, text: '   ' }, // blank — skipped
    ]);
    expect(chunks.length).toBeGreaterThan(2);
    const page1 = chunks.filter((c) => c.page === 1);
    const page2 = chunks.filter((c) => c.page === 2);
    expect(page1.length).toBeGreaterThan(1);
    expect(page2).toHaveLength(1);
    expect(chunks.some((c) => c.page === 3)).toBe(false);
    // Global monotonic chunk index across pages.
    expect(chunks.map((c) => c.chunkIndex)).toEqual(chunks.map((_, i) => i));
    // Page-relative offsets: page 2's single chunk starts at 0.
    expect(page2[0]!.charStart).toBe(0);
  });
});

describe('classifyDocTypeHeuristic', () => {
  it.each([
    ['Form 1040 U.S. Individual Income Tax Return 2024', 'f1040', 2024],
    ['Form 1120-S U.S. Income Tax Return for an S Corporation 2024', 'f1120s', 2024],
    ['Form 1120 U.S. Corporation Income Tax Return 2023', 'f1120', 2023],
    ['Form 1065 U.S. Return of Partnership Income 2024', 'f1065', 2024],
    ['Schedule K-1 (Form 1120-S) 2024 Shareholder Share of Income', 'k1', 2024],
    ['Schedule K-1 (Form 1065) Partner Share of Income 2024', 'k1', 2024],
    ['Form 990 Return of Organization Exempt From Income Tax 2023', 'f990', 2023],
    ['Form MO-1040 Missouri Individual Income Tax Return 2024', 'state_return', 2024],
    ['ENGAGEMENT LETTER for tax services', 'engagement_letter', null],
  ])('classifies %s', (text, docType, year) => {
    const guess = classifyDocTypeHeuristic(text);
    expect(guess?.docType).toBe(docType);
    expect(guess?.taxYear ?? null).toBe(year);
  });

  it('returns null for unrecognized text', () => {
    expect(classifyDocTypeHeuristic('Dear client, attached is a letter.')).toBeNull();
  });
});
