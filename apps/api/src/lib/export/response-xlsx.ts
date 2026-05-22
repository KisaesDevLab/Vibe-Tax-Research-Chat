// Server-side Excel (.xlsx) generation for assistant responses.
//
// Mirrors response-pdf.ts / response-docx.ts. The download is most
// useful when the skill is `excel-workpaper-builder`, whose JSON
// sidecar populates a `workpaper_data` object describing the
// worksheet (sheet name, headers, rows with amounts or formulas,
// tickmark legend, sources, notes). When that field is present, we
// render a styled worksheet with bold headers, formula support,
// tickmark column, top-border + bold for footed totals, and a
// legend / sources / notes block beneath the data.
//
// When the sidecar lacks `workpaper_data` (e.g., the user clicked
// Download XLSX on an ordinary memo / research answer), we fall
// back to a single-sheet dump of the prose body + any markdown
// tables we can detect — same intent as the PDF/DOCX fallback: the
// button is never broken regardless of which skill produced the
// message.

import ExcelJS from 'exceljs';
import { stripSidecars } from '../parsing/sidecars-strip.js';

interface MessageForExport {
  id: string;
  created_at: Date;
  content: string;
  model_id: string | null;
  cost_usd: string | number | null;
  authorities: unknown;
  compliance_check: unknown;
}

// `workpaper_data` shape from
// skills/excel-workpaper-builder/references/sidecar-shape.md.
interface WorkpaperRow {
  index?: string;
  label?: string;
  amount?: number;
  amounts?: Record<string, number>;
  formula?: string;
  formulas?: Record<string, string>;
  tickmark?: string;
  source?: string;
  bold?: boolean;
  top_border?: boolean;
  section_break?: boolean;
}

interface WorkpaperData {
  sheet_name?: string;
  title?: string;
  index?: string;
  period?: string;
  entity?: string;
  preparer?: string;
  prepared_date?: string;
  headers?: string[];
  rows?: WorkpaperRow[];
  tickmark_legend?: { symbol: string; meaning: string }[];
  sources?: string[];
  notes?: string[];
}

// Brand fill used in the PDF/DOCX headers — keep the family consistent.
const HEADER_FILL = 'FFF5EFE3';
const TOTAL_FILL = 'FFFAF4E6';
const INK_GREY = 'FF666666';
const RULE_GREY = 'FFAAAAAA';

export async function buildResponseXlsx(m: MessageForExport): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Vibe Tax Research';
  wb.created = new Date(m.created_at);
  wb.title = 'Vibe Tax Research workpaper';

  const wp = extractWorkpaperData(m.content);
  if (wp && Array.isArray(wp.rows) && wp.rows.length > 0) {
    renderStructuredWorkpaper(wb, wp, m);
  } else {
    renderFallbackProse(wb, m);
  }

  // Buffer.from() coercion: ExcelJS returns ArrayBuffer in some type
  // shapes — Node's Buffer.from handles both.
  const ab = await wb.xlsx.writeBuffer();
  return Buffer.from(ab as ArrayBuffer);
}

// ── workpaper_data extraction ────────────────────────────────────────────

// Locate the workpaper_data object inside the message's JSON sidecar.
// Sidecars are emitted as ```json ... ``` fences (per the skills' output
// schema) but the model also sometimes drops the fence; handle both.
function extractWorkpaperData(text: string): WorkpaperData | null {
  // 1) Tagged JSON fences — try every fence body in order. The fence
  //    bounds are unambiguous so JSON.parse handles nested braces.
  const fenceRe = /```(?:json|jsonc)?\s*\n([\s\S]*?)(?:```|$)/gi;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(text)) !== null) {
    const wp = tryParseSidecar(m[1]!);
    if (wp) return wp;
  }
  // 2) Bare top-level JSON object containing `workpaper_data`. We walk
  //    from the first `{` after a likely sentinel to a balanced closing
  //    brace so nested objects inside workpaper_data don't truncate
  //    the capture (a non-greedy regex stops at the first inner `}`
  //    and fails JSON.parse).
  const bare = findBalancedJsonContaining(text, '"workpaper_data"');
  if (bare) {
    const wp = tryParseSidecar(bare);
    if (wp) return wp;
  }
  return null;
}

function tryParseSidecar(json: string): WorkpaperData | null {
  try {
    const parsed: unknown = JSON.parse(json);
    if (parsed && typeof parsed === 'object' && 'workpaper_data' in parsed) {
      const wp = (parsed as { workpaper_data: unknown }).workpaper_data;
      if (wp && typeof wp === 'object') return wp as WorkpaperData;
    }
  } catch {
    // ignore parse failures — caller falls through to next candidate
  }
  return null;
}

// Scan `text` for an object literal that contains `needle` somewhere
// inside, and return the full balanced `{...}` substring. Brace-depth
// counter that respects strings and escape sequences — handles nested
// objects and arrays that regex non-greedy quantifiers can't.
function findBalancedJsonContaining(text: string, needle: string): string | null {
  const idx = text.indexOf(needle);
  if (idx < 0) return null;
  // Walk back to the nearest preceding `{` to find the object start.
  let start = idx;
  let depth = 0;
  while (start >= 0) {
    if (text[start] === '}') depth++;
    else if (text[start] === '{') {
      if (depth === 0) break;
      depth--;
    }
    start--;
  }
  if (start < 0) return null;
  // Walk forward from start, counting braces while respecting strings.
  let i = start;
  depth = 0;
  let inStr = false;
  let esc = false;
  while (i < text.length) {
    const ch = text[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else {
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
    i++;
  }
  return null;
}

// ── Structured workpaper renderer ────────────────────────────────────────

function renderStructuredWorkpaper(
  wb: ExcelJS.Workbook,
  wp: WorkpaperData,
  m: MessageForExport,
): void {
  // Excel sheet names cap at 31 chars and forbid certain characters
  // ( : \ / ? * [ ] ). ExcelJS does not auto-truncate.
  const requestedName = (wp.sheet_name ?? 'Workpaper').replace(/[\\/?*[\]:]/g, '-');
  const sheetName = requestedName.length > 31 ? requestedName.slice(0, 31) : requestedName;
  const ws = wb.addWorksheet(sheetName, {
    properties: { defaultColWidth: 16 },
    views: [{ showGridLines: false }],
  });

  let r = 1;

  // Title block — title, entity / period / preparer / date.
  if (wp.title) {
    const cell = ws.getCell(r, 1);
    cell.value = wp.title;
    cell.font = { name: 'Calibri', size: 14, bold: true };
    ws.mergeCells(r, 1, r, Math.max(4, wp.headers?.length ?? 4));
    r++;
  }
  const metaParts: string[] = [];
  if (wp.entity) metaParts.push(`Entity: ${wp.entity}`);
  if (wp.period) metaParts.push(`Period: ${wp.period}`);
  if (wp.index) metaParts.push(`Index: ${wp.index}`);
  if (wp.preparer) metaParts.push(`Prepared by: ${wp.preparer}`);
  if (wp.prepared_date) metaParts.push(`Date: ${wp.prepared_date}`);
  if (metaParts.length > 0) {
    const cell = ws.getCell(r, 1);
    cell.value = metaParts.join('  •  ');
    cell.font = { name: 'Calibri', size: 10, color: { argb: INK_GREY } };
    ws.mergeCells(r, 1, r, Math.max(4, wp.headers?.length ?? 4));
    r++;
  }
  // Spacer.
  if (wp.title || metaParts.length > 0) r++;

  // Headers.
  const headers =
    Array.isArray(wp.headers) && wp.headers.length > 0
      ? wp.headers
      : ['Index', 'Item', 'Amount', 'Tickmark'];
  const headerRow = ws.getRow(r);
  headers.forEach((h, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = h;
    cell.font = { name: 'Calibri', size: 11, bold: true };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
    cell.border = {
      top: { style: 'thin', color: { argb: RULE_GREY } },
      bottom: { style: 'thin', color: { argb: RULE_GREY } },
    };
    cell.alignment = { vertical: 'middle', horizontal: 'left' };
  });
  headerRow.height = 18;
  const headerRowIdx = r;
  r++;

  // Data rows.
  const rows = Array.isArray(wp.rows) ? wp.rows : [];
  const periodCols = headers.length > 4 ? headers.slice(2, -1) : []; // multi-period
  for (const row of rows) {
    if (row.section_break) {
      const cell = ws.getCell(r, 1);
      cell.value = row.label ?? '';
      cell.font = { name: 'Calibri', size: 11, italic: true, color: { argb: INK_GREY } };
      ws.mergeCells(r, 1, r, headers.length);
      r++;
      continue;
    }

    const excelRow = ws.getRow(r);
    // Column 1: index.
    excelRow.getCell(1).value = row.index ?? '';
    excelRow.getCell(1).font = { name: 'Calibri', size: 10, color: { argb: INK_GREY } };

    // Column 2: label.
    excelRow.getCell(2).value = row.label ?? '';

    if (periodCols.length === 0) {
      // Single-amount layout: columns are [Index, Item, Amount, Tickmark].
      const amountCell = excelRow.getCell(3);
      if (typeof row.formula === 'string' && row.formula.startsWith('=')) {
        amountCell.value = { formula: row.formula.slice(1) };
      } else if (typeof row.amount === 'number') {
        amountCell.value = row.amount;
      }
      amountCell.numFmt = '#,##0.00;(#,##0.00)';
      amountCell.alignment = { horizontal: 'right' };

      excelRow.getCell(4).value = row.tickmark ?? '';
      excelRow.getCell(4).font = { name: 'Calibri', size: 10, color: { argb: INK_GREY } };
      excelRow.getCell(4).alignment = { horizontal: 'center' };
    } else {
      // Multi-period layout: headers = [Index, Item, ...periods, Tickmark].
      periodCols.forEach((period, idx) => {
        const col = idx + 3;
        const cell = excelRow.getCell(col);
        const formula = row.formulas?.[period];
        const amount = row.amounts?.[period];
        if (typeof formula === 'string' && formula.startsWith('=')) {
          cell.value = { formula: formula.slice(1) };
        } else if (typeof amount === 'number') {
          cell.value = amount;
        }
        cell.numFmt = '#,##0.00;(#,##0.00)';
        cell.alignment = { horizontal: 'right' };
      });
      const lastCol = headers.length;
      excelRow.getCell(lastCol).value = row.tickmark ?? '';
      excelRow.getCell(lastCol).font = { name: 'Calibri', size: 10, color: { argb: INK_GREY } };
      excelRow.getCell(lastCol).alignment = { horizontal: 'center' };
    }

    if (row.bold) {
      excelRow.eachCell({ includeEmpty: false }, (cell) => {
        cell.font = { ...(cell.font ?? {}), bold: true };
      });
    }
    if (row.top_border) {
      excelRow.eachCell({ includeEmpty: false }, (cell) => {
        cell.border = {
          ...(cell.border ?? {}),
          top: { style: 'medium', color: { argb: RULE_GREY } },
        };
      });
      excelRow.eachCell({ includeEmpty: false }, (cell) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: TOTAL_FILL } };
      });
    }
    r++;
  }
  r++; // spacer

  // Auto-fit columns (approximation: scan max content length per column).
  ws.columns.forEach((col, i) => {
    let maxLen = headers[i]?.length ?? 12;
    if (col.eachCell) {
      col.eachCell({ includeEmpty: false }, (cell) => {
        const txt =
          typeof cell.value === 'object' && cell.value && 'formula' in cell.value
            ? ((cell.value as { result?: unknown }).result?.toString() ?? '$0.00')
            : (cell.value?.toString() ?? '');
        if (txt.length > maxLen) maxLen = txt.length;
      });
    }
    col.width = Math.min(Math.max(maxLen + 2, 12), 48);
  });

  // Tickmark legend block.
  if (Array.isArray(wp.tickmark_legend) && wp.tickmark_legend.length > 0) {
    const hdr = ws.getCell(r, 1);
    hdr.value = 'Tickmark legend';
    hdr.font = { name: 'Calibri', size: 11, bold: true };
    r++;
    for (const entry of wp.tickmark_legend) {
      ws.getCell(r, 1).value = entry.symbol ?? '';
      ws.getCell(r, 1).font = { name: 'Calibri', size: 10, bold: true };
      ws.getCell(r, 1).alignment = { horizontal: 'center' };
      ws.getCell(r, 2).value = entry.meaning ?? '';
      ws.getCell(r, 2).font = { name: 'Calibri', size: 10 };
      ws.mergeCells(r, 2, r, headers.length);
      r++;
    }
    r++;
  }

  // Sources block.
  if (Array.isArray(wp.sources) && wp.sources.length > 0) {
    const hdr = ws.getCell(r, 1);
    hdr.value = 'Source documents reviewed';
    hdr.font = { name: 'Calibri', size: 11, bold: true };
    r++;
    for (const src of wp.sources) {
      ws.getCell(r, 1).value = `• ${src}`;
      ws.getCell(r, 1).font = { name: 'Calibri', size: 10 };
      ws.mergeCells(r, 1, r, headers.length);
      r++;
    }
    r++;
  }

  // Practitioner notes block.
  if (Array.isArray(wp.notes) && wp.notes.length > 0) {
    const hdr = ws.getCell(r, 1);
    hdr.value = 'Practitioner notes';
    hdr.font = { name: 'Calibri', size: 11, bold: true };
    r++;
    for (const note of wp.notes) {
      const cell = ws.getCell(r, 1);
      cell.value = `• ${note}`;
      cell.font = { name: 'Calibri', size: 10, italic: true, color: { argb: INK_GREY } };
      cell.alignment = { wrapText: true, vertical: 'top' };
      ws.mergeCells(r, 1, r, headers.length);
      r++;
    }
  }

  // Footer block — generation metadata, model, cost.
  r++;
  const footerCell = ws.getCell(r, 1);
  const stamp = new Date(m.created_at).toLocaleString();
  const cost = m.cost_usd != null ? `  •  cost $${Number(m.cost_usd).toFixed(4)}` : '';
  footerCell.value = `Generated ${stamp}  •  model ${m.model_id ?? 'unknown'}${cost}  •  Vibe Tax Research — AI-generated; verify all citations before reliance.`;
  footerCell.font = { name: 'Calibri', size: 9, italic: true, color: { argb: INK_GREY } };
  ws.mergeCells(r, 1, r, headers.length);

  // Freeze the header row so scrolling preserves context.
  ws.views = [{ showGridLines: false, state: 'frozen', xSplit: 0, ySplit: headerRowIdx }];
}

// ── Fallback renderer ────────────────────────────────────────────────────

// When the message lacks a structured `workpaper_data` payload (e.g.,
// the user hit Download XLSX on a regular memo / research answer),
// dump the prose body to a single sheet as plain text rows so the
// button is never broken. Mirrors the PDF/DOCX fallback intent.
function renderFallbackProse(wb: ExcelJS.Workbook, m: MessageForExport): void {
  const ws = wb.addWorksheet('Response', {
    views: [{ showGridLines: false }],
    properties: { defaultColWidth: 100 },
  });

  let r = 1;
  const titleCell = ws.getCell(r, 1);
  titleCell.value = 'Vibe Tax Research — response';
  titleCell.font = { name: 'Calibri', size: 14, bold: true };
  r++;

  const stamp = new Date(m.created_at).toLocaleString();
  const meta = `Generated ${stamp}  •  model ${m.model_id ?? 'unknown'}${
    m.cost_usd != null ? `  •  cost $${Number(m.cost_usd).toFixed(4)}` : ''
  }`;
  const metaCell = ws.getCell(r, 1);
  metaCell.value = meta;
  metaCell.font = { name: 'Calibri', size: 10, italic: true, color: { argb: INK_GREY } };
  r += 2;

  const prose = stripSidecars(m.content).trim();
  const lines = prose.split('\n');
  for (const line of lines) {
    const cell = ws.getCell(r, 1);
    cell.value = line;
    cell.font = { name: 'Calibri', size: 11 };
    cell.alignment = { wrapText: true, vertical: 'top' };
    r++;
  }

  ws.getColumn(1).width = 120;
}
