// TP-7 — anchor matching + 1040 mapping unit tests over synthetic token
// layouts, plus an end-to-end run over a PDFKit-generated 1040-style
// page (real text layer through pdfjs-dist).
import { describe, it, expect } from 'vitest';
import PDFDocument from 'pdfkit';
import { matchAnchors, parseNumberToken, selectAnchors, BASE_ANCHORS } from './anchors.js';
import { mapReturn } from './map-1040.js';
import { extractPdfTokens, type PdfToken } from './pdf-extract.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TableSetPayload } from '@vibe/shared';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tables = (
  JSON.parse(
    readFileSync(
      path.resolve(__dirname, '../../../../../packages/db/seeds/table-sets/2026.json'),
      'utf-8',
    ),
  ) as { payload: TableSetPayload }
).payload;

// Token-layout helper: one row at a given y with positioned strings.
let tokenY = 700;
function row(page: number, parts: string[], y?: number): PdfToken[] {
  const yy = y ?? (tokenY -= 20);
  return parts.map((str, i) => ({ str, x: 40 + i * 90, y: yy, width: 50, page }));
}

describe('parseNumberToken', () => {
  it.each([
    ['1,234', 1234],
    ['(2,500)', -2500],
    ['-750', -750],
    ['0', 0],
    ['1234.56', 1234.56],
    ['12,345.', 12345],
    ['$5,000', 5000],
  ])('%s → %d', (raw, expected) => {
    expect(parseNumberToken(raw)).toBe(expected);
  });
  it('rejects non-numbers and dates', () => {
    expect(parseNumberToken('W-2')).toBeNull();
    expect(parseNumberToken('12/31/2026')).toBeNull();
  });
});

describe('matchAnchors', () => {
  it('takes the right-most number and skips the line-number column', () => {
    const tokens = [
      // "1a" line-number column, label, an echoed "1a", then the value.
      ...row(1, ['1a', 'Total amount from Form(s) W-2, box 1', '1a', '185,000']),
    ];
    const hits = matchAnchors(tokens, BASE_ANCHORS);
    expect(hits.find((h) => h.field === 'wages')?.value).toBe(185_000);
  });

  it('first match in page order wins', () => {
    const tokens = [
      ...row(1, ['Taxable interest', '2,000'], 600),
      ...row(2, ['Taxable interest', '9,999'], 600),
    ];
    const hits = matchAnchors(tokens, BASE_ANCHORS);
    expect(hits.find((h) => h.field === 'interestIncome')?.value).toBe(2_000);
  });

  it('page markers scope schedule lines', () => {
    const tokens = [
      // Business income line on a page WITHOUT the Schedule 1 marker: no hit.
      ...row(1, ['Business income or (loss)', '80,000'], 500),
      // Same line on a marked page: hit.
      ...row(3, ['SCHEDULE 1', '(Form 1040)'], 720),
      ...row(3, ['3', 'Business income or (loss)', '75,000'], 600),
    ];
    const hits = matchAnchors(tokens, BASE_ANCHORS);
    expect(hits.find((h) => h.field === 'scheduleCNet')?.value).toBe(75_000);
  });

  it('parenthesized losses come through negative', () => {
    const tokens = [
      ...row(2, ['SCHEDULE E', 'Supplemental Income and Loss'], 720),
      ...row(2, ['Total rental real estate and royalty income or (loss)', '(12,500)'], 600),
    ];
    const hits = matchAnchors(tokens, BASE_ANCHORS);
    expect(hits.find((h) => h.field === 'schERentalNet')?.value).toBe(-12_500);
  });
});

describe('mapReturn', () => {
  const hit = (field: string, value: number) => ({ field, value, page: 1, label: field });

  it('nets qualified out of ordinary dividends', () => {
    const r = mapReturn(
      [hit('ordinaryDividends', 10_000), hit('qualifiedDividends', 8_000)],
      'generic',
      tables,
    );
    expect(r.fields.find((f) => f.field === 'ordinaryDividends')?.value).toBe(2_000);
    expect(r.fields.find((f) => f.field === 'qualifiedDividends')?.value).toBe(8_000);
  });

  it('warns when Schedule E pieces do not tie to Schedule 1 line 5', () => {
    const r = mapReturn(
      [
        hit('schERentalNet', 10_000),
        hit('schEPartnershipNet', 20_000),
        hit('schedule1Line5', 35_000),
      ],
      'generic',
      tables,
    );
    expect(r.warnings.some((w) => w.includes("don't tie"))).toBe(true);
  });

  it('flags short-term gains as possibly one-time', () => {
    const r = mapReturn(
      [hit('schDShortTerm', 5_000), hit('schDLongTerm', 20_000)],
      'generic',
      tables,
    );
    expect(r.warnings.some((w) => w.includes('Short-term'))).toBe(true);
    expect(r.fields.find((f) => f.field === 'longTermCapGain')?.value).toBe(20_000);
  });

  it('infers MFJ from the 2026 standard deduction', () => {
    const r = mapReturn([hit('standardDeduction', 32_200)], 'generic', tables);
    expect(r.filingStatus).toBe('mfj');
  });

  it('ambiguous single/mfs amount stays null with a warning', () => {
    const r = mapReturn([hit('standardDeduction', 16_100)], 'generic', tables);
    expect(r.filingStatus).toBeNull();
    expect(r.warnings.some((w) => w.includes('multiple statuses'))).toBe(true);
  });

  it('carries the return totals into the tie-out block', () => {
    const r = mapReturn([hit('agi', 210_000), hit('totalTax', 38_000)], 'generic', tables);
    expect(r.tieOut.agi).toBe(210_000);
    expect(r.tieOut.totalTax).toBe(38_000);
  });

  it('withholding is deliberately never mapped', () => {
    const r = mapReturn([hit('agi', 100_000)], 'generic', tables);
    expect(r.fields.some((f) => f.field === 'withholding')).toBe(false);
  });
});

describe('end-to-end over a synthetic PDF text layer', () => {
  async function buildPdf(): Promise<Buffer> {
    return await new Promise<Buffer>((resolve) => {
      const doc = new PDFDocument({ size: 'LETTER', margin: 40 });
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.fontSize(10);
      const line = (label: string, value: string, y: number) => {
        doc.text(label, 40, y, { lineBreak: false });
        doc.text(value, 460, y, { lineBreak: false });
      };
      doc.text('Form 1040 (2026)', 40, 40, { lineBreak: false });
      line('1a Total amount from Form(s) W-2, box 1', '150,000', 100);
      line('2b Taxable interest', '3,500', 120);
      line('11 Adjusted gross income', '153,500', 140);
      line('12 Standard deduction or itemized deductions', '32,200', 160);
      line('15 Taxable income', '121,300', 180);
      line('24 Total tax', '17,000', 200);
      doc.end();
    });
  }

  it('extracts tokens with coordinates and matches anchors', async () => {
    const pdf = await buildPdf();
    const tokens = await extractPdfTokens(pdf);
    expect(tokens.length).toBeGreaterThan(5);
    const { anchors, vendor } = selectAnchors(tokens);
    expect(vendor).toBe('generic');
    const hits = matchAnchors(tokens, anchors);
    const result = mapReturn(hits, vendor, tables);
    expect(result.fields.find((f) => f.field === 'wages')?.value).toBe(150_000);
    expect(result.tieOut.agi).toBe(153_500);
    expect(result.tieOut.totalTax).toBe(17_000);
    expect(result.filingStatus).toBe('mfj');
  });
});
