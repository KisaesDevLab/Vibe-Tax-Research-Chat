// Shared PDFKit block renderers: GFM pipe tables and fenced code blocks.
//
// Extracted from response-pdf.ts (TP-11 archive readability work) so the
// marked-driven renderer in render/markdown-pdf.ts can draw the same tables
// and code blocks the chat-response export draws. Both callers pass their own
// font family — the response export is a Helvetica document, the memo and the
// archive memo are Times documents — everything else (column allocation, page
// breaks, header repetition) is identical and lives here once.
import { sanitizeForCode, stripInline } from './pdf-text.js';

type Doc = PDFKit.PDFDocument;

/** Base-14 family used for prose inside blocks. Courier is always the code font. */
export type PdfFamily = 'Helvetica' | 'Times';

function regular(family: PdfFamily): string {
  return family === 'Times' ? 'Times-Roman' : 'Helvetica';
}
function bold(family: PdfFamily): string {
  return family === 'Times' ? 'Times-Bold' : 'Helvetica-Bold';
}

// ── Fenced code blocks ────────────────────────────────────────────────────

const CODE_FONT_SIZE = 9;
const CODE_PAD_X = 8;
const CODE_PAD_Y = 6;
const CODE_FILL = '#f5efe3';

/**
 * Render fenced code as Courier inside a tinted block.
 *
 * Courier is one of PDFKit's bundled 14 fonts, so column alignment in
 * decision trees / formula tables is preserved character-by-character. We
 * render line-by-line at absolute coordinates inside a rectangle measured
 * up-front, so we know whether a page break is needed before drawing
 * anything (avoids the block-on-the-page-edge case where the background fill
 * stops at the boundary but the text continues on the next page).
 */
export function renderCodeBlock(
  doc: Doc,
  codeLines: string[],
  opts: { ink?: string; size?: number } = {},
): void {
  const size = opts.size ?? CODE_FONT_SIZE;
  doc.moveDown(0.3);
  const left = doc.page.margins.left;
  const usable = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const innerWidth = usable - CODE_PAD_X * 2;

  doc.font('Courier').fontSize(size);
  const lineH = doc.heightOfString('M', { width: innerWidth });
  // Pre-measure each line so a long line that wraps in Courier still
  // contributes its full wrapped height to the block.
  const heights = codeLines.map((raw) => {
    const text = sanitizeForCode(raw);
    if (text.length === 0) return lineH;
    return doc.heightOfString(text, { width: innerWidth });
  });
  const totalContent = heights.reduce((a, b) => a + b, 0);
  const totalHeight = totalContent + CODE_PAD_Y * 2;

  // Page-break check: if the whole block doesn't fit, push it to a new page
  // rather than splitting (these blocks are typically short — 5-15 lines —
  // and splitting an ASCII-art tree across pages defeats the purpose of
  // preserving alignment). A block taller than a full page still has to
  // split, so only bounce it when it can actually fit on a fresh page.
  const bottomLimit = doc.page.height - doc.page.margins.bottom;
  const pageCapacity = doc.page.height - doc.page.margins.top - doc.page.margins.bottom;
  if (doc.y + totalHeight > bottomLimit && totalHeight <= pageCapacity) {
    doc.addPage();
  }

  const blockY = doc.y;
  doc.save();
  doc.rect(left, blockY, usable, totalHeight).fill(CODE_FILL);
  doc.restore();

  let y = blockY + CODE_PAD_Y;
  doc
    .font('Courier')
    .fontSize(size)
    .fillColor(opts.ink ?? '#1a1714');
  for (let k = 0; k < codeLines.length; k++) {
    const text = sanitizeForCode(codeLines[k]!);
    // Empty lines still consume one line of vertical space — pass a single
    // space so PDFKit advances y without drawing anything.
    doc.text(text.length === 0 ? ' ' : text, left + CODE_PAD_X, y, {
      width: innerWidth,
      lineBreak: true,
    });
    y += heights[k]!;
  }

  doc.y = blockY + totalHeight + 4;
  doc.x = left;
  doc.moveDown(0.3);
}

// ── GFM pipe tables ───────────────────────────────────────────────────────

export type CellAlign = 'left' | 'center' | 'right';

export interface ParsedTable {
  rows: string[][];
  alignments: CellAlign[];
  nextIdx: number;
}

const TABLE_FONT_SIZE = 10;
const TABLE_PAD_X = 6;
const TABLE_PAD_Y = 5;
const TABLE_HEADER_LINE = '#aaaaaa';
const TABLE_ROW_LINE = '#e2dccf';
const TABLE_HEADER_FILL = '#f5efe3';

export function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  // Honor escaped pipes (\|) by temporarily swapping them out before split.
  // The placeholder is NUL — it cannot occur in real cell text, and unlike a
  // printable stand-in it can't be reintroduced as a spurious pipe on the way
  // back out.
  const placeholder = '\u0000';
  return s
    .replace(/\\\|/g, placeholder)
    .split('|')
    .map((c) => c.replaceAll(placeholder, '|').trim());
}

export function tryParseTable(lines: string[], start: number): ParsedTable | null {
  if (start + 1 >= lines.length) return null;
  const header = lines[start]!;
  const sep = lines[start + 1]!;
  if (!header.includes('|')) return null;
  // Separator: pipes around dash runs, optional colons for alignment.
  if (!/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(sep)) return null;

  const sepCells = splitTableRow(sep);
  const alignments: CellAlign[] = sepCells.map((c) => {
    const t = c.trim();
    const left = t.startsWith(':');
    const right = t.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    return 'left';
  });

  const headerCells = splitTableRow(header);
  if (headerCells.length !== alignments.length) return null;

  const rows: string[][] = [headerCells];
  let i = start + 2;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === '' || !line.includes('|')) break;
    const cells = splitTableRow(line);
    // Pad/truncate to header width so we always have a rectangular grid.
    while (cells.length < headerCells.length) cells.push('');
    if (cells.length > headerCells.length) cells.length = headerCells.length;
    rows.push(cells);
    i++;
  }
  if (rows.length < 2) return null;
  return { rows, alignments, nextIdx: i };
}

// A markdown link inside a cell would otherwise print its raw syntax and
// blow the column width apart; the label alone is what the reader needs
// (the URL survives in the Authorities / consultations sections).
function stripCellInline(s: string): string {
  return stripInline(s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, '$1'));
}

function isWholeCellBold(s: string): boolean {
  const t = s.trim();
  return /^\*\*[^*]+\*\*$/.test(t);
}

// Column-width allocation. We measure each column twice:
//   * `min` = width of the longest single word — falling below this would
//     force the wrapper to break across characters ("Code" → "Cod\ne").
//   * `pref` = width of the longest cell when not wrapped at all.
// If the sum of `pref` fits in the available width we just hand each
// column its preferred width plus a proportional slice of the slack. If
// it doesn't, we start every column at its minimum and water-fill the
// remaining width across columns up to their preferred caps. This keeps
// short-content columns (header rows like "Code Section", numeric "#"
// columns) from being squeezed to the floor when the table also contains
// a long-text column.
function measureColumn(
  doc: Doc,
  rows: string[][],
  c: number,
  family: PdfFamily,
  size: number,
): { min: number; pref: number } {
  let min = 0;
  let pref = 0;
  for (let r = 0; r < rows.length; r++) {
    const cell = rows[r]![c] ?? '';
    const text = stripCellInline(cell);
    const isBold = r === 0 || isWholeCellBold(cell);
    doc.font(isBold ? bold(family) : regular(family)).fontSize(size);
    if (text.length > 0) {
      pref = Math.max(pref, Math.ceil(doc.widthOfString(text)));
      for (const word of text.split(/\s+/)) {
        if (!word) continue;
        min = Math.max(min, Math.ceil(doc.widthOfString(word)));
      }
    }
  }
  return { min, pref };
}

function computeColumnWidths(
  doc: Doc,
  rows: string[][],
  usable: number,
  family: PdfFamily,
  size: number,
): number[] {
  const numCols = rows[0]!.length;
  const dims: { min: number; pref: number }[] = [];
  for (let c = 0; c < numCols; c++) dims.push(measureColumn(doc, rows, c, family, size));

  const padPref = dims.map((d) => d.pref + TABLE_PAD_X * 2);
  const padMin = dims.map((d) => Math.max(d.min, 12) + TABLE_PAD_X * 2);

  const distributeSum = (widths: number[]): number[] => {
    const sum = widths.reduce((a, b) => a + b, 0);
    if (sum === usable) return widths;
    const widest = widths.indexOf(Math.max(...widths));
    widths[widest]! += usable - sum;
    return widths;
  };

  // Case 1: all columns fit at their preferred width — share the slack.
  const prefSum = padPref.reduce((a, b) => a + b, 0);
  if (prefSum <= usable) {
    if (prefSum === 0) return distributeSum(new Array(numCols).fill(Math.floor(usable / numCols)));
    const slack = usable - prefSum;
    const widths = padPref.map((w) => w + Math.floor((slack * w) / prefSum));
    return distributeSum(widths);
  }

  // Case 2: even minimums don't fit — proportional shrink, words may break.
  const minSum = padMin.reduce((a, b) => a + b, 0);
  if (minSum >= usable) {
    const factor = usable / minSum;
    const widths = padMin.map((w) => Math.max(20, Math.floor(w * factor)));
    return distributeSum(widths);
  }

  // Case 3 (common): water-fill from the minimums up to each column's
  // preferred width. Each round, columns that haven't hit their cap get
  // an equal share of the remaining slack; the loop terminates when
  // every column is capped or the slack is exhausted.
  const granted = padMin.slice();
  let remaining = usable - minSum;
  for (let iter = 0; iter < numCols + 2 && remaining > 0; iter++) {
    const eligible: number[] = [];
    for (let i = 0; i < numCols; i++) if (granted[i]! < padPref[i]!) eligible.push(i);
    if (eligible.length === 0) break;
    const share = Math.floor(remaining / eligible.length);
    if (share === 0) {
      // Distribute the dribble one point at a time.
      for (const i of eligible) {
        if (remaining === 0) break;
        if (granted[i]! < padPref[i]!) {
          granted[i]!++;
          remaining--;
        }
      }
      break;
    }
    let added = 0;
    for (const i of eligible) {
      const room = padPref[i]! - granted[i]!;
      const add = Math.min(share, room);
      granted[i]! += add;
      added += add;
    }
    remaining -= added;
  }
  if (remaining > 0) {
    const widest = padPref.indexOf(Math.max(...padPref));
    granted[widest]! += remaining;
  }
  return distributeSum(granted);
}

export interface TableStyle {
  family?: PdfFamily;
  size?: number;
  ink?: string;
}

export function renderTable(
  doc: Doc,
  rows: string[][],
  alignments: CellAlign[],
  style: TableStyle = {},
): void {
  if (rows.length === 0 || (rows[0]?.length ?? 0) === 0) return;
  const family = style.family ?? 'Helvetica';
  const size = style.size ?? TABLE_FONT_SIZE;
  const ink = style.ink ?? '#1a1714';
  const left = doc.page.margins.left;
  const usable = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const widths = computeColumnWidths(doc, rows, usable, family, size);
  const header = rows[0]!;
  const body = rows.slice(1);

  doc.moveDown(0.3);
  // Anchor the cursor at the left margin in case prior content (or our own
  // absolute-positioned cell text() calls earlier in the document) left it
  // elsewhere.
  doc.x = left;

  const measureRowHeight = (cells: string[], isHeader: boolean): number => {
    let max = 0;
    for (let c = 0; c < cells.length; c++) {
      const inner = widths[c]! - TABLE_PAD_X * 2;
      const text = stripCellInline(cells[c] ?? '');
      const wholeBold = !isHeader && isWholeCellBold(cells[c] ?? '');
      // Bold metrics differ slightly from regular; measure with the font
      // we'll actually draw with so the row height matches exactly.
      doc.font(isHeader || wholeBold ? bold(family) : regular(family)).fontSize(size);
      const h = doc.heightOfString(text || ' ', { width: inner });
      if (h > max) max = h;
    }
    return max + TABLE_PAD_Y * 2;
  };

  const drawHorizontalLine = (y: number, color: string, weight = 0.5): void => {
    doc
      .strokeColor(color)
      .lineWidth(weight)
      .moveTo(left, y)
      .lineTo(left + usable, y)
      .stroke();
  };

  const drawRow = (cells: string[], isHeader: boolean): void => {
    const rowHeight = measureRowHeight(cells, isHeader);
    const bottomLimit = doc.page.height - doc.page.margins.bottom;
    if (doc.y + rowHeight > bottomLimit) {
      doc.addPage();
      // Repeat the header on continuation pages so the table is readable
      // when split. Guard against infinite recursion by only repeating
      // when we're not already drawing the header row.
      if (!isHeader) {
        drawHorizontalLine(doc.y, TABLE_HEADER_LINE);
        doc.y += 0.5;
        drawRow(header, true);
      }
    }

    const startY = doc.y;

    if (isHeader) {
      doc.save();
      doc.rect(left, startY, usable, rowHeight).fill(TABLE_HEADER_FILL);
      doc.restore();
    }

    let x = left;
    for (let c = 0; c < cells.length; c++) {
      const cell = cells[c] ?? '';
      const inner = widths[c]! - TABLE_PAD_X * 2;
      const wholeBold = !isHeader && isWholeCellBold(cell);
      const font = isHeader || wholeBold ? bold(family) : regular(family);
      doc
        .font(font)
        .fontSize(size)
        .fillColor(ink)
        .text(stripCellInline(cell), x + TABLE_PAD_X, startY + TABLE_PAD_Y, {
          width: inner,
          align: alignments[c] ?? 'left',
          lineBreak: true,
        });
      x += widths[c]!;
    }

    // Each cell text() call shifts doc.y to its own end; force the row to
    // advance a uniform amount so subsequent rows line up.
    doc.y = startY + rowHeight;
    drawHorizontalLine(doc.y, isHeader ? TABLE_HEADER_LINE : TABLE_ROW_LINE);
    doc.y += 0.5;
  };

  // Top border above the header.
  drawHorizontalLine(doc.y, TABLE_HEADER_LINE);
  doc.y += 0.5;

  drawRow(header, true);
  for (const row of body) drawRow(row, false);

  // Restore the cursor to the left margin. The last cell text() call ended
  // somewhere inside the right-hand column, so without this every subsequent
  // paragraph and heading inherits a tiny effective width
  // (`page.width - doc.x`) and wraps catastrophically.
  doc.x = left;
  doc.moveDown(0.4);
}
