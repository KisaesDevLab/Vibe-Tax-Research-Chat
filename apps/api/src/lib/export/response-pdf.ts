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
import { sanitizeForHelvetica, stripInline } from './pdf-text.js';
import { renderCodeBlock, renderTable, tryParseTable } from './pdf-blocks.js';

// Re-exported for the renderers that already import the sanitizer from here.
export { sanitizeForHelvetica } from './pdf-text.js';

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

    // Fenced code block (``` … ```). Must be detected before the heading
    // / paragraph branches; otherwise the inline-backtick stripper in
    // stripInline() chews one pair off the triple-fence and the
    // paragraph collector joins the body lines with spaces — destroying
    // the ASCII alignment that makes tax-research decision trees and
    // formula tables readable.
    if (/^\s*```/.test(line)) {
      const codeLines: string[] = [];
      i++; // skip opening fence
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i]!)) {
        codeLines.push(lines[i]!);
        i++;
      }
      if (i < lines.length) i++; // skip closing fence (if present)
      renderCodeBlock(doc, codeLines);
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
        /^\s*```/.test(nxt) ||
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
