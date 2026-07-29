// Markdown → PDFKit tests. Built with `compress: false` so the content
// stream stays readable and we can assert on the text actually drawn —
// the whole point being that markdown SYNTAX must not survive into the
// page. (The deliverable renderer compresses, hence the direct unit here.)
import { describe, it, expect } from 'vitest';
import PDFDocument from 'pdfkit';
import { renderMarkdown, type MarkdownPdfStyle } from './markdown-pdf.js';

const STYLE: MarkdownPdfStyle = {
  ink: '#1a1714',
  muted: '#666666',
  rule: '#dddddd',
  link: '#7a2a1a',
  size: 11,
};

async function draw(markdown: string): Promise<string> {
  const doc = new PDFDocument({ compress: false, margin: 54, bufferPages: true });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve) => doc.on('end', () => resolve()));
  renderMarkdown(doc, markdown, STYLE);
  doc.flushPages();
  doc.end();
  await done;
  return Buffer.concat(chunks).toString('latin1');
}

// PDFKit writes text as hex strings inside kerned TJ arrays, e.g.
//   [<48656c6c6f2077> 10 <6f726c64> 0] TJ
// Chunks inside one array are one visual run, so they concatenate; separate
// operators are joined with a space.
const CP1252_HIGH: Record<number, string> = {
  0x85: '…',
  0x91: '‘',
  0x92: '’',
  0x93: '“',
  0x94: '”',
  0x95: '•',
  0x96: '–',
  0x97: '—',
};

/** Decode a WinAnsi (cp1252) byte string — latin1 alone mangles 0x80-0x9F. */
function decodeWinAnsi(hex: string): string {
  const bytes = Buffer.from(hex, 'hex');
  let out = '';
  for (const b of bytes) out += CP1252_HIGH[b] ?? String.fromCharCode(b);
  return out;
}

function shownText(pdf: string): string {
  const runs: string[] = [];
  for (const block of pdf.match(/\[(?:[^[\]]|\\.)*\]\s*TJ/g) ?? []) {
    const hexes = block.match(/<([0-9A-Fa-f]*)>/g) ?? [];
    runs.push(hexes.map((h) => decodeWinAnsi(h.slice(1, -1))).join(''));
  }
  for (const single of pdf.match(/<([0-9A-Fa-f]*)>\s*Tj/g) ?? []) {
    runs.push(decodeWinAnsi(single.replace(/>\s*Tj$/, '').slice(1)));
  }
  return runs.join(' ');
}

describe('renderMarkdown', () => {
  it('renders heading text without the ATX hashes', async () => {
    const text = shownText(await draw('# Situation\n\nBody paragraph.'));
    expect(text).toContain('Situation');
    expect(text).toContain('Body paragraph.');
    expect(text).not.toContain('#');
  });

  it('strips emphasis markers and keeps the words', async () => {
    const text = shownText(await draw('An **S corporation** with *material* profit.'));
    expect(text).toContain('S corporation');
    expect(text).toContain('material');
    expect(text).not.toContain('**');
    expect(text).not.toContain('*material*');
  });

  it('uses real bold and italic fonts for emphasis', async () => {
    const pdf = await draw('Plain **bold** and *italic* text.');
    expect(pdf).toContain('Times-Bold');
    expect(pdf).toContain('Times-Italic');
  });

  it('renders bullets and numbers as markers, not dashes', async () => {
    const text = shownText(await draw('- Augusta rule\n- Accountable plan\n'));
    expect(text).toContain('Augusta rule');
    expect(text).toContain('Accountable plan');
    // The literal markdown dash must be gone; a real bullet takes its place.
    expect(text).not.toMatch(/-\s*Augusta/);
    expect(text).toContain('•');
  });

  it('numbers ordered lists', async () => {
    const text = shownText(await draw('1. First step\n2. Second step\n'));
    expect(text).toContain('First step');
    expect(text).toContain('Second step');
    expect(text).toContain('1.');
    expect(text).toContain('2.');
  });

  it('renders inline code in Courier without backticks', async () => {
    const pdf = await draw('See `IRC 280A(g)` for detail.');
    const text = shownText(pdf);
    expect(text).toContain('IRC 280A(g)');
    expect(text).not.toContain('`');
    expect(pdf).toContain('Courier');
  });

  it('keeps link text and registers the href as an annotation', async () => {
    const pdf = await draw('See [the memo](https://example.com/memo).');
    expect(shownText(pdf)).toContain('the memo');
    expect(shownText(pdf)).not.toContain('](');
    expect(pdf).toContain('https://example.com/memo');
  });

  it('renders blockquote text without the > marker', async () => {
    const text = shownText(await draw('> Verify every figure.'));
    expect(text).toContain('Verify every figure.');
    expect(text).not.toContain('>');
  });

  it('survives a section sign and em dash intact', async () => {
    // WinAnsi covers both; losing them would mangle every tax memo.
    const text = shownText(await draw('Under §280A(g) — the exclusion applies.'));
    expect(text).toContain('§280A(g)');
    expect(text).toContain('—');
  });

  it('handles nested lists without throwing', async () => {
    const text = shownText(await draw('- Outer item\n    - Inner item\n'));
    expect(text).toContain('Outer item');
    expect(text).toContain('Inner item');
  });

  it('renders a long memo across multiple pages', async () => {
    const long = Array.from({ length: 120 }, (_, i) => `Paragraph ${i} of the memo body.`).join(
      '\n\n',
    );
    const pdf = await draw(long);
    const pages = (pdf.match(/\/Type \/Page[^s]/g) ?? []).length;
    expect(pages).toBeGreaterThan(1);
    expect(shownText(pdf)).toContain('Paragraph 119 of the memo body.');
  });

  it('is a no-op for empty or whitespace input', async () => {
    const before = await draw('');
    const blank = await draw('   \n  \n');
    expect(shownText(before)).toBe('');
    expect(shownText(blank)).toBe('');
  });

  it('does not throw on stray HTML or unknown syntax', async () => {
    const text = shownText(await draw('<div>raw</div>\n\n| a | b |\n| - | - |\n| 1 | 2 |\n'));
    expect(text).toContain('raw');
  });
});
