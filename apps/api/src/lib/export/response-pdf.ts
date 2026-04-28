// Server-side PDF generation for assistant responses.
//
// Why server-side: client-side html2canvas / jsPDF approaches all had a
// failure mode somewhere — Unicode glyphs not in the base14 fonts, mid-
// line page breaks, autoPaging quirks, or the offscreen-clone losing
// font/CSS context. PDFKit on the server emits real text PDFs with
// reliable Helvetica metrics, automatic pagination via doc.text(), and
// builds a small (~30KB) selectable file that's perfect for archival.
//
// We render from the structured message data we already have in the DB:
//   - the prose body (markdown, with sidecar JSON stripped)
//   - the parsed authorities[] sidecar
//   - the parsed compliance_check sidecar
// The renderer is deliberately simple: headings, bullets, ordered lists,
// horizontal rules, bold, and GFM pipe tables. Fenced code blocks fall
// through to plain text — adequate for tax research output and zero
// risk of mis-rendering.

import PDFDocument from 'pdfkit';
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

const MARGIN = 54; // 0.75in
const HEADER_RESERVE = 56;
const FOOTER_RESERVE = 36;

interface Authority {
  cite?: string;
  type?: string;
  weight?: string;
  source?: string;
  verified_this_turn?: boolean;
  warning?: string;
}

type ComplianceRule = boolean | string | null | { ok?: boolean; note?: string } | undefined;

interface ComplianceCheckShape {
  engagement_type?: string;
  confidence_band?: string;
  ssts_1_1?: ComplianceRule;
  ssts_2_3?: ComplianceRule;
  circ230_10_22?: ComplianceRule;
  circ230_10_35?: ComplianceRule;
  circ230_10_37?: ComplianceRule;
  circ_230_10_22?: ComplianceRule;
  circ_230_10_35?: ComplianceRule;
  circ_230_10_37?: ComplianceRule;
  disclosure_forms?: string[];
  form_disclosure_required?: string[];
  notes?: string;
  negative_treatment_review?: string;
  negative_treatment_review_required?: boolean;
  loper_bright_caveat?: boolean;
}

export function buildResponsePdf(m: MessageForExport): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // bufferPages:true holds every page in memory until end() so we can
    // draw the header/footer chrome AFTER all body content has flowed
    // and we know exactly how many pages there are. Crucially this also
    // lets us avoid a `pageAdded` listener — the previous version's
    // listener wrote text in the bottom-margin region, which itself
    // triggered a new page, which fired pageAdded again, recursing
    // until "Maximum call stack size exceeded".
    const doc = new PDFDocument({
      size: 'LETTER',
      bufferPages: true,
      margins: {
        top: MARGIN + HEADER_RESERVE,
        bottom: MARGIN + FOOTER_RESERVE,
        left: MARGIN,
        right: MARGIN,
      },
      info: {
        Title: 'Vibe Tax Research response',
        Author: 'Vibe Tax Research',
        Subject: 'AI-generated tax research response',
        CreationDate: new Date(m.created_at),
      },
    });

    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Render the body first. The first page already exists; content
    // flows into it and PDFKit auto-paginates as needed.
    const prose = stripSidecars(m.content).trim();
    if (prose) renderMarkdown(doc, prose);

    const authorities = parseAuthorityArray(m.authorities);
    if (authorities.length > 0) {
      sectionHeading(doc, 'Authorities');
      authorities.forEach((a, i) => renderAuthority(doc, a, i + 1));
    }

    const compliance = parseCompliance(m.compliance_check);
    if (compliance) {
      sectionHeading(doc, 'Compliance');
      renderCompliance(doc, compliance);
    }

    // Now walk every buffered page and stamp on the header band, footer
    // disclaimer, and page count. We use raw graphics primitives + a
    // text() call that is constrained in width but rendered with
    // lineBreak:false at coordinates strictly inside the page — no
    // chance of triggering a page break and thus no recursion.
    const created = new Date(m.created_at).toLocaleString();
    const headerMeta = `Generated ${created} · model ${m.model_id ?? 'unknown'}${
      m.cost_usd != null ? ` · cost $${Number(m.cost_usd).toFixed(4)}` : ''
    }`;
    // Snapshot the body-stamp page count BEFORE we start drawing chrome.
    // text() inside the bottom-margin region triggers PDFKit's
    // `continueOnNewPage`, which appends a new page to the buffer even
    // with bufferPages:true. To prevent that we temporarily zero the
    // page margins while writing chrome — the renderer only checks
    // `y > pageHeight - margins.bottom` for pagination, so margins.bottom
    // = 0 silences the check. We restore the margins after each page so
    // any subsequent text() (none here, but defensive) sees the real
    // values. We also stop iteration at `bodyPages` so even if a stray
    // page DID get appended we wouldn't double-count.
    const range = doc.bufferedPageRange();
    const bodyPages = range.count;
    for (let i = 0; i < bodyPages; i++) {
      doc.switchToPage(range.start + i);
      doc.save();
      const savedTop = doc.page.margins.top;
      const savedBottom = doc.page.margins.bottom;
      const savedLeft = doc.page.margins.left;
      const savedRight = doc.page.margins.right;
      doc.page.margins = { top: 0, bottom: 0, left: 0, right: 0 };

      // Header band.
      doc
        .font('Helvetica-Bold')
        .fontSize(13)
        .fillColor('#1a1714')
        .text('Tax research response', MARGIN, MARGIN, {
          lineBreak: false,
          width: doc.page.width - MARGIN * 2,
        });
      doc
        .font('Helvetica')
        .fontSize(9)
        .fillColor('#666666')
        .text(headerMeta, MARGIN, MARGIN + 16, {
          lineBreak: false,
          width: doc.page.width - MARGIN * 2,
        });
      doc
        .strokeColor('#dddddd')
        .lineWidth(0.5)
        .moveTo(MARGIN, MARGIN + 32)
        .lineTo(doc.page.width - MARGIN, MARGIN + 32)
        .stroke();

      // Footer band.
      const footerY = doc.page.height - MARGIN - 18;
      doc
        .strokeColor('#dddddd')
        .lineWidth(0.5)
        .moveTo(MARGIN, footerY - 6)
        .lineTo(doc.page.width - MARGIN, footerY - 6)
        .stroke();
      doc
        .font('Helvetica-Oblique')
        .fontSize(8)
        .fillColor('#888888')
        .text(
          'Vibe Tax Research · AI-generated; verify all citations before reliance.',
          MARGIN,
          footerY,
          { lineBreak: false, width: doc.page.width - MARGIN * 2 - 80 },
        );
      doc.text(`Page ${i + 1} of ${bodyPages}`, doc.page.width - MARGIN - 80, footerY, {
        lineBreak: false,
        width: 80,
        align: 'right',
      });

      doc.page.margins = {
        top: savedTop,
        bottom: savedBottom,
        left: savedLeft,
        right: savedRight,
      };
      doc.restore();
    }

    doc.end();
  });
}

// ── Markdown → PDFKit ─────────────────────────────────────────────────────

// PDFKit's bundled Helvetica is WinAnsi-encoded (Windows-1252 + a few CP1252
// extras). Anything outside that codepage — emoji, mathematical operators,
// arrows, decorative checkmarks — renders as garbage glyphs ("→" prints as
// "!'", "≈" as "\"H", "🔑" as "Ø=Ý"). We can't fix the font without bundling
// a TrueType file, so we substitute the common offenders with their ASCII
// approximations and strip everything else in the BMP/SMP symbol/emoji
// blocks. Section sign §, em-dash —, en-dash –, curly quotes "" '' • are
// all in WinAnsi 1252 and pass through untouched.
const UNICODE_FALLBACKS: Array<[RegExp, string]> = [
  [/[→➡➔➜➝➞➟]/gu, ' -> '],
  [/[←⬅]/gu, ' <- '],
  [/[↑]/gu, '^'],
  [/[↓]/gu, 'v'],
  [/[≈]/gu, '~'],
  [/[≤]/gu, '<='],
  [/[≥]/gu, '>='],
  [/[≠]/gu, '!='],
  [/[±]/gu, '+/-'],
  [/[×]/gu, 'x'],
  [/[÷]/gu, '/'],
  [/[✓✔☑]/gu, ''],
  [/[✗✘☒]/gu, ''],
  [/[⚠]/gu, ''],
  [/[★☆]/gu, '*'],
  // Emoji + miscellaneous symbol/dingbat blocks. Strip rather than guess.
  [/[\u{1F300}-\u{1FAFF}]/gu, ''],
  [/[\u{1F600}-\u{1F64F}]/gu, ''],
  [/[\u{1F680}-\u{1F6FF}]/gu, ''],
  [/[\u{1F700}-\u{1F77F}]/gu, ''],
  [/[\u{2600}-\u{27BF}]/gu, ''],
  [/[\u{1F900}-\u{1F9FF}]/gu, ''],
  // Variation selectors and zero-width joiners left dangling after emoji removal.
  [/[\u{FE00}-\u{FE0F}\u{200D}\u{200B}\u{200C}]/gu, ''],
];

function sanitizeForHelvetica(s: string): string {
  let out = s;
  for (const [re, rep] of UNICODE_FALLBACKS) out = out.replace(re, rep);
  // Collapse runs of whitespace that emoji-stripping may have left behind.
  return out.replace(/[ \t]{2,}/g, ' ').trim();
}

// Strip inline markdown that we don't try to render specially. Order
// matters: **bold** first so the leftover *italic* regex doesn't
// chew on bold markers. The `continued: true` path through PDFKit's
// wrapper has stack-overflowed on long inline-emphasis input historically,
// so we render bold/italic at the block level (whole paragraphs, whole
// table cells) rather than mid-string.
function stripInline(s: string): string {
  return sanitizeForHelvetica(
    s
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*\n]+?)\*/g, '$1')
      .replace(/`([^`]+)`/g, '$1'),
  );
}

function renderMarkdown(doc: PDFKit.PDFDocument, md: string): void {
  const lines = md.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;

    if (line.trim() === '') {
      doc.moveDown(0.5);
      i++;
      continue;
    }

    // Heading.
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const level = h[1]!.length;
      const sizes = [16, 14, 12, 11];
      const tops = [10, 8, 6, 4];
      doc.moveDown(tops[level - 1]! / 12);
      doc
        .font('Helvetica-Bold')
        .fontSize(sizes[level - 1]!)
        .fillColor('#1a1714')
        .text(stripInline(h[2]!));
      doc.moveDown(0.2);
      i++;
      continue;
    }

    // Horizontal rule.
    if (/^---+\s*$/.test(line.trim())) {
      const y = doc.y + 4;
      doc
        .strokeColor('#dddddd')
        .lineWidth(0.5)
        .moveTo(doc.page.margins.left, y)
        .lineTo(doc.page.width - doc.page.margins.right, y)
        .stroke();
      doc.y = y + 12;
      i++;
      continue;
    }

    // List block. Collect contiguous list items, then defer to PDFKit's
    // built-in doc.list() helper — it handles bullets, indents, and page
    // breaks correctly without the recursion hazard of manual
    // marker+text+continued plumbing.
    const listMatch = line.match(/^(\s*)([*-]|\d+\.)\s+(.*)$/);
    if (listMatch) {
      const isOrdered = /\d/.test(listMatch[2]!);
      const items: string[] = [];
      while (i < lines.length) {
        const m2 = lines[i]!.match(/^(\s*)([*-]|\d+\.)\s+(.*)$/);
        if (!m2) break;
        items.push(stripInline(m2[3]!));
        i++;
      }
      doc.font('Helvetica').fontSize(11).fillColor('#1a1714');
      doc.list(items, {
        bulletRadius: 1.6,
        textIndent: 14,
        bulletIndent: 4,
        listType: isOrdered ? 'numbered' : 'bullet',
        paragraphGap: 2,
      });
      doc.moveDown(0.3);
      continue;
    }

    // GFM pipe table. Detect by the second line being a |---|---| style
    // separator row; otherwise this is just a paragraph that happens to
    // contain pipes.
    const table = tryParseTable(lines, i);
    if (table) {
      renderTable(doc, table.rows, table.alignments);
      i = table.nextIdx;
      continue;
    }

    // Blockquote — render as italicized paragraph indented with a left
    // bar drawn after we know the final y. No inline-bold gymnastics.
    if (/^>\s+/.test(line)) {
      const text = stripInline(line.replace(/^>\s+/, ''));
      const startY = doc.y;
      doc.font('Helvetica-Oblique').fontSize(11).fillColor('#555555').text(text, {
        indent: 14,
      });
      doc
        .strokeColor('#bbbbbb')
        .lineWidth(2)
        .moveTo(doc.page.margins.left + 4, startY)
        .lineTo(doc.page.margins.left + 4, doc.y - 2)
        .stroke();
      i++;
      continue;
    }

    // Plain paragraph — keep collecting until structural break.
    const paraLines: string[] = [line];
    let j = i + 1;
    while (j < lines.length) {
      const nxt = lines[j]!;
      if (
        nxt.trim() === '' ||
        /^(#{1,4})\s+/.test(nxt) ||
        /^---+\s*$/.test(nxt.trim()) ||
        /^(\s*)([*-]|\d+\.)\s+/.test(nxt) ||
        /^>\s+/.test(nxt) ||
        // Stop the paragraph if a table starts on the next line.
        (lines[j + 1] !== undefined &&
          nxt.includes('|') &&
          /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(lines[j + 1]!))
      ) {
        break;
      }
      paraLines.push(nxt);
      j++;
    }
    // Detect a paragraph wrapped entirely in single-asterisk italics —
    // common shape for disclaimer/footer text — and render the body in
    // Helvetica-Oblique so the meaning isn't lost when we strip the
    // markers.
    const joined = paraLines.join(' ').trim();
    const italicWhole = /^\*[^*\n]+\*$/.test(joined);
    const body = italicWhole ? joined.slice(1, -1) : joined;
    doc
      .font(italicWhole ? 'Helvetica-Oblique' : 'Helvetica')
      .fontSize(11)
      .fillColor(italicWhole ? '#555555' : '#1a1714')
      .text(stripInline(body));
    doc.moveDown(0.4);
    i = j;
  }
}

function sectionHeading(doc: PDFKit.PDFDocument, label: string): void {
  doc.moveDown(0.6);
  doc.x = doc.page.margins.left;
  doc.font('Helvetica-Bold').fontSize(14).fillColor('#1a1714').text(label);
  doc.moveDown(0.2);
}

// ── Tables ────────────────────────────────────────────────────────────────

type CellAlign = 'left' | 'center' | 'right';

interface ParsedTable {
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

function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  // Honor escaped pipes (\|) by temporarily swapping them out before split.
  const placeholder = ' ';
  return s
    .replace(/\\\|/g, placeholder)
    .split('|')
    .map((c) => c.replace(new RegExp(placeholder, 'g'), '|').trim());
}

function tryParseTable(lines: string[], start: number): ParsedTable | null {
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

function stripCellInline(s: string): string {
  return stripInline(s);
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
  doc: PDFKit.PDFDocument,
  rows: string[][],
  c: number,
): { min: number; pref: number } {
  let min = 0;
  let pref = 0;
  for (let r = 0; r < rows.length; r++) {
    const cell = rows[r]![c] ?? '';
    const text = stripCellInline(cell);
    const isBold = r === 0 || isWholeCellBold(cell);
    doc.font(isBold ? 'Helvetica-Bold' : 'Helvetica').fontSize(TABLE_FONT_SIZE);
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

function computeColumnWidths(doc: PDFKit.PDFDocument, rows: string[][], usable: number): number[] {
  const numCols = rows[0]!.length;
  const dims: { min: number; pref: number }[] = [];
  for (let c = 0; c < numCols; c++) dims.push(measureColumn(doc, rows, c));

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

function renderTable(doc: PDFKit.PDFDocument, rows: string[][], alignments: CellAlign[]): void {
  const left = doc.page.margins.left;
  const usable = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const widths = computeColumnWidths(doc, rows, usable);
  const header = rows[0]!;
  const body = rows.slice(1);

  doc.moveDown(0.3);
  // Anchor the cursor at the left margin in case prior content (or our
  // own absolute-positioned cell text() calls earlier in the document)
  // left it elsewhere.
  doc.x = left;

  const measureRowHeight = (cells: string[], isHeader: boolean): number => {
    let max = 0;
    for (let c = 0; c < cells.length; c++) {
      const inner = widths[c]! - TABLE_PAD_X * 2;
      const text = stripCellInline(cells[c] ?? '');
      const wholeBold = !isHeader && isWholeCellBold(cells[c] ?? '');
      // Bold metrics differ slightly from regular; measure with the
      // font we'll actually draw with so the row height matches exactly.
      doc.font(isHeader || wholeBold ? 'Helvetica-Bold' : 'Helvetica').fontSize(TABLE_FONT_SIZE);
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
      const font = isHeader || wholeBold ? 'Helvetica-Bold' : 'Helvetica';
      doc
        .font(font)
        .fontSize(TABLE_FONT_SIZE)
        .fillColor('#1a1714')
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

  // Restore the cursor to the left margin. The last cell text() call
  // ended somewhere inside the right-hand column, so without this every
  // subsequent paragraph and heading inherits a tiny effective width
  // (`page.width - doc.x`) and wraps catastrophically.
  doc.x = left;
  doc.moveDown(0.4);
}

// ── Authorities ───────────────────────────────────────────────────────────

function parseAuthorityArray(v: unknown): Authority[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is Authority => typeof x === 'object' && x !== null && 'cite' in x);
}

function renderAuthority(doc: PDFKit.PDFDocument, a: Authority, n: number): void {
  doc.moveDown(0.2);
  doc.x = doc.page.margins.left;
  const status = a.verified_this_turn ? 'verified' : 'unverified';
  doc
    .font('Helvetica-Bold')
    .fontSize(11)
    .fillColor('#1a1714')
    .text(`${n}. ${sanitizeForHelvetica(a.cite ?? '')}    [${status}]`);
  const meta: string[] = [];
  if (a.type) meta.push(sanitizeForHelvetica(a.type));
  if (a.weight) meta.push(`weight: ${sanitizeForHelvetica(a.weight)}`);
  if (meta.length) {
    doc.font('Helvetica').fontSize(9).fillColor('#666666').text(meta.join(' · '));
  }
  if (a.source) {
    const isUrl = /^https?:\/\//.test(a.source);
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor('#7a2a1a')
      .text(sanitizeForHelvetica(a.source), {
        link: isUrl ? a.source : undefined,
        underline: isUrl,
      });
  }
  if (a.warning) {
    doc
      .font('Helvetica-Oblique')
      .fontSize(9)
      .fillColor('#7a2a1a')
      .text(`Warning: ${sanitizeForHelvetica(a.warning)}`);
  }
}

// ── Compliance ────────────────────────────────────────────────────────────

function parseCompliance(v: unknown): ComplianceCheckShape | null {
  if (!v || typeof v !== 'object') return null;
  return v as ComplianceCheckShape;
}

const RULE_ROWS: { keys: (keyof ComplianceCheckShape)[]; label: string }[] = [
  { keys: ['ssts_1_1'], label: 'SSTS § 1.1 — Tax return positions' },
  { keys: ['ssts_2_3'], label: 'SSTS § 2.3 — Estimates' },
  {
    keys: ['circ230_10_22', 'circ_230_10_22'],
    label: 'Circular 230 § 10.22 — Diligence as to accuracy',
  },
  { keys: ['circ230_10_35', 'circ_230_10_35'], label: 'Circular 230 § 10.35 — Competence' },
  { keys: ['circ230_10_37', 'circ_230_10_37'], label: 'Circular 230 § 10.37 — Written advice' },
];

function normalizeRule(v: ComplianceRule): { state: 'pass' | 'na' | 'fail'; note?: string } | null {
  if (v === undefined) return null;
  if (v === null) return { state: 'na', note: 'Not implicated by this turn' };
  if (typeof v === 'boolean') return { state: v ? 'pass' : 'fail' };
  if (typeof v === 'string') {
    if (v.toLowerCase().startsWith('n/a')) return { state: 'na', note: v };
    return { state: 'pass', note: v };
  }
  if (typeof v === 'object') return { state: v.ok ? 'pass' : 'fail', note: v.note };
  return null;
}

function renderCompliance(doc: PDFKit.PDFDocument, c: ComplianceCheckShape): void {
  // No `continued: true` chains here — the prior version stack-overflowed
  // PDFKit's text wrapper on long inputs. We render label + value in one
  // call per field with the label inline.
  doc.x = doc.page.margins.left;
  if (c.confidence_band) {
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor('#2f4a30')
      .text(sanitizeForHelvetica(c.confidence_band));
    doc.moveDown(0.3);
  }
  if (c.engagement_type) {
    doc
      .font('Helvetica-Bold')
      .fontSize(10)
      .fillColor('#1a1714')
      .text(`Engagement: ${sanitizeForHelvetica(c.engagement_type)}`);
    doc.moveDown(0.3);
  }
  for (const row of RULE_ROWS) {
    let v: ComplianceRule;
    for (const k of row.keys) {
      const candidate = c[k] as ComplianceRule;
      if (candidate !== undefined) {
        v = candidate;
        break;
      }
    }
    const n = normalizeRule(v);
    if (!n) continue;
    const statusText =
      n.state === 'pass' ? 'satisfied' : n.state === 'fail' ? 'review needed' : 'n/a';
    doc.font('Helvetica').fontSize(11).fillColor('#1a1714').text(`${row.label}    [${statusText}]`);
    if (n.note) {
      doc.font('Helvetica').fontSize(9).fillColor('#666666').text(sanitizeForHelvetica(n.note));
    }
    doc.moveDown(0.2);
  }
  const forms = (c.disclosure_forms ?? c.form_disclosure_required ?? []).filter(
    (f) => f && f.toLowerCase() !== 'none' && f.toLowerCase() !== 'n/a',
  );
  if (forms.length > 0) {
    doc.moveDown(0.3);
    doc
      .font('Helvetica-Bold')
      .fontSize(10)
      .fillColor('#1a1714')
      .text(`Disclosure forms: ${forms.map(sanitizeForHelvetica).join(', ')}`);
  }
  if (c.notes) {
    doc.moveDown(0.3);
    doc
      .font('Helvetica-Bold')
      .fontSize(10)
      .fillColor('#1a1714')
      .text(`Notes: ${sanitizeForHelvetica(c.notes)}`);
  }
  if (c.loper_bright_caveat) {
    doc.moveDown(0.3);
    doc
      .font('Helvetica-Oblique')
      .fontSize(9)
      .fillColor('#666666')
      .text('Post-Loper Bright: cited Treasury Regulations carry only Skidmore weight.');
  }
}
