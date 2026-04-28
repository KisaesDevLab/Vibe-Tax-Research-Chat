// Phase 23 — attachment parsers. Dispatches by mime type.
import mammoth from 'mammoth';
import pdfParse from 'pdf-parse';
import * as XLSX from 'xlsx';

export interface ParsedAttachment {
  full_text: string;
  ocr_applied: boolean;
}

const XLSX_MIME = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/vnd.oasis.opendocument.spreadsheet',
]);
const XLSX_EXTS = ['.xlsx', '.xls', '.xlsm', '.ods'];

export async function parseAttachment(input: {
  buffer: Buffer;
  mime_type: string;
  filename: string;
}): Promise<ParsedAttachment> {
  const mt = input.mime_type.toLowerCase();
  const fnLower = input.filename.toLowerCase();
  if (mt === 'application/pdf') {
    const r = await pdfParse(input.buffer);
    if (r.text.trim().length < 32) {
      // Likely a scanned PDF — TODO Phase 23: hand off to Tesseract bridge.
      return { full_text: r.text ?? '', ocr_applied: false };
    }
    return { full_text: r.text, ocr_applied: false };
  }
  if (
    mt === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    fnLower.endsWith('.docx')
  ) {
    const r = await mammoth.extractRawText({ buffer: input.buffer });
    return { full_text: r.value, ocr_applied: false };
  }
  if (XLSX_MIME.has(mt) || XLSX_EXTS.some((ext) => fnLower.endsWith(ext))) {
    return { full_text: parseSpreadsheet(input.buffer, input.filename), ocr_applied: false };
  }
  if (
    mt === 'text/csv' ||
    mt === 'application/csv' ||
    fnLower.endsWith('.csv') ||
    fnLower.endsWith('.tsv')
  ) {
    // CSVs round-trip through xlsx for consistent rendering — same Markdown
    // table output as xlsx, so the wizard prompt sees uniform input.
    return { full_text: parseSpreadsheet(input.buffer, input.filename), ocr_applied: false };
  }
  if (mt.startsWith('text/') || mt === 'application/json') {
    return { full_text: input.buffer.toString('utf-8'), ocr_applied: false };
  }
  if (mt.startsWith('image/')) {
    // TODO Phase 23: OCR via Tesseract bridge; v1.5 swaps to GLM-OCR.
    return { full_text: '', ocr_applied: false };
  }
  return { full_text: '', ocr_applied: false };
}

// Render every sheet in a workbook as a Markdown table, separated by `##` headings.
// The Anthropic-facing prompt reads this as prose, which works because GitHub-flavor
// Markdown tables are valid markdown and Claude parses them fluently. The alternative
// (raw CSV) loses the multi-sheet structure and confuses small models on column
// alignment. Empty cells become "–" so the table doesn't collapse columns.
function parseSpreadsheet(buf: Buffer, filename: string): string {
  const wb = XLSX.read(buf, { type: 'buffer' });
  const out: string[] = [];
  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName];
    if (!sheet) continue;
    const rows: unknown[][] = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      blankrows: false,
      defval: '',
    });
    if (rows.length === 0) continue;
    out.push(`## ${sheetName}`);
    const widthCols = Math.max(...rows.map((r) => r.length));
    const renderCell = (v: unknown): string => {
      if (v === null || v === undefined || v === '') return '–';
      const s = String(v).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
      return s.length > 200 ? `${s.slice(0, 200)}…` : s;
    };
    const padRow = (r: unknown[]): string[] => {
      const padded = [...r];
      while (padded.length < widthCols) padded.push('');
      return padded.slice(0, widthCols).map(renderCell);
    };
    const header = padRow(rows[0] ?? []);
    out.push(`| ${header.join(' | ')} |`);
    out.push(`| ${header.map(() => '---').join(' | ')} |`);
    for (let i = 1; i < rows.length; i++) {
      out.push(`| ${padRow(rows[i] ?? []).join(' | ')} |`);
    }
    out.push('');
  }
  if (out.length === 0) return `(empty spreadsheet: ${filename})`;
  return out.join('\n');
}
