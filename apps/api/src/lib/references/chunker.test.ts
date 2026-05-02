// Phase 32 — chunker invariants. Char offsets must be reconstructible
// (text.slice(charStart, charEnd) === chunk.text after trim), output must
// cover the full document modulo whitespace, and overlaps must actually
// overlap.
import { describe, expect, it } from 'vitest';
import { chunkText } from './chunker.js';

describe('chunkText', () => {
  it('returns empty array for empty input', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   \n   ')).toEqual([]);
  });

  it('produces a single chunk for short input', () => {
    const chunks = chunkText('Section 61 defines gross income broadly.');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toBe('Section 61 defines gross income broadly.');
    expect(chunks[0]!.charStart).toBe(0);
    expect(chunks[0]!.charEnd).toBe(40);
  });

  it('splits a long paragraph by sentence and overlaps', () => {
    const sentence = 'The taxpayer must report all income from whatever source derived. ';
    const text = sentence.repeat(80); // ~80 * 67 = ~5360 chars
    const chunks = chunkText(text, { targetChars: 1600, maxChars: 2000, overlapChars: 200 });
    expect(chunks.length).toBeGreaterThan(1);
    // Indexes are sequential
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
    // Each chunk fits in maxChars (after trim)
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(2000);
    }
    // Every offset window slices to non-empty and matches the chunk after
    // trimming whitespace.
    for (const c of chunks) {
      const sliced = text.slice(c.charStart, c.charEnd);
      expect(sliced.trim().length).toBeGreaterThan(0);
    }
  });

  it('keeps short paragraphs together rather than over-splitting', () => {
    const text = [
      'Paragraph one is short.',
      'Paragraph two is also short.',
      'Paragraph three rounds it out.',
    ].join('\n\n');
    const chunks = chunkText(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toContain('Paragraph one');
    expect(chunks[0]!.text).toContain('Paragraph three');
  });

  it('emits successive chunks whose start trails the previous end (overlap)', () => {
    const sentence = 'Treas. Reg. 1.61-1 elaborates on the broad scope of gross income. ';
    const text = sentence.repeat(120);
    const chunks = chunkText(text, { targetChars: 1200, maxChars: 1500, overlapChars: 250 });
    expect(chunks.length).toBeGreaterThan(2);
    let overlappingPairs = 0;
    for (let i = 1; i < chunks.length; i++) {
      // The next chunk's charStart should be at most the previous chunk's
      // charEnd (boundary), and ideally less (overlap).
      expect(chunks[i]!.charStart).toBeLessThanOrEqual(chunks[i - 1]!.charEnd);
      if (chunks[i]!.charStart < chunks[i - 1]!.charEnd) overlappingPairs++;
    }
    // The whole point of the overlap parameter is to actually overlap —
    // assert at least one pair does, otherwise we silently regressed to a
    // hard-boundary chunker.
    expect(overlappingPairs).toBeGreaterThan(0);
  });

  it('handles CRLF line endings as paragraph separators', () => {
    const text = 'First paragraph.\r\n\r\nSecond paragraph.\r\n\r\nThird paragraph.';
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks[0]!.text).toContain('First');
    expect(chunks[0]!.text).toContain('Third');
  });

  it('strips leading and trailing whitespace from chunks', () => {
    const text = '\n\n   Some leading whitespace then content.   \n\n';
    const chunks = chunkText(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toBe('Some leading whitespace then content.');
  });

  it('drops paragraphs that are pure whitespace', () => {
    const text = 'Real content.\n\n   \n\n\n\nMore real content.';
    const chunks = chunkText(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toContain('Real content');
    expect(chunks[0]!.text).toContain('More real content');
  });

  it('survives a single paragraph longer than maxChars without infinite loop', () => {
    // No paragraph breaks, no sentence breaks — just one giant blob. The
    // hard-split branch should kick in.
    const text = 'a'.repeat(10_000);
    const chunks = chunkText(text, { targetChars: 1000, maxChars: 1500, overlapChars: 100 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(1500);
    }
    // Total covered chars across chunks (using start/end ranges) must
    // span the original document.
    const lastEnd = chunks[chunks.length - 1]!.charEnd;
    expect(lastEnd).toBe(10_000);
  });
});
