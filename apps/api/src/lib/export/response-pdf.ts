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
// horizontal rules, and bold. Tables / fenced code blocks fall through
// to plain text — adequate for tax research output and zero risk of
// mis-rendering.

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
    const doc = new PDFDocument({
      size: 'LETTER',
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

    // Header + footer on every page (pageAdded fires for every new page,
    // including the implicit first one created by PDFKit).
    const drawChrome = () => {
      const created = new Date(m.created_at).toLocaleString();
      const headerMeta = `Generated ${created} · model ${m.model_id ?? 'unknown'}${
        m.cost_usd != null ? ` · cost $${Number(m.cost_usd).toFixed(4)}` : ''
      }`;
      doc.save();
      // Header band.
      doc
        .font('Helvetica-Bold')
        .fontSize(13)
        .fillColor('#1a1714')
        .text('Tax research response', MARGIN, MARGIN, { lineBreak: false });
      doc
        .font('Helvetica')
        .fontSize(9)
        .fillColor('#666666')
        .text(headerMeta, MARGIN, MARGIN + 16, { lineBreak: false });
      doc
        .strokeColor('#dddddd')
        .lineWidth(0.5)
        .moveTo(MARGIN, MARGIN + 32)
        .lineTo(doc.page.width - MARGIN, MARGIN + 32)
        .stroke();

      // Footer.
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
          { lineBreak: false, width: doc.page.width - MARGIN * 2 },
        );
      doc.restore();
    };
    doc.on('pageAdded', drawChrome);
    drawChrome();

    // Render: prose body, then Authorities, then Compliance.
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

    // Page numbers (added last so we know the total).
    const pages = doc.bufferedPageRange();
    for (let i = 0; i < pages.count; i++) {
      doc.switchToPage(pages.start + i);
      doc.save();
      doc
        .font('Helvetica-Oblique')
        .fontSize(8)
        .fillColor('#888888')
        .text(
          `Page ${i + 1} of ${pages.count}`,
          doc.page.width - MARGIN - 60,
          doc.page.height - MARGIN - 18,
          { lineBreak: false, width: 60, align: 'right' },
        );
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

    // Blank line.
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
        .fillColor('#1a1714');
      writeWithBold(doc, h[2]!);
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

    // List block. Collect contiguous list items.
    const listMatch = line.match(/^(\s*)([*-]|\d+\.)\s+(.*)$/);
    if (listMatch) {
      const items: { marker: string; text: string }[] = [];
      while (i < lines.length) {
        const m2 = lines[i]!.match(/^(\s*)([*-]|\d+\.)\s+(.*)$/);
        if (!m2) break;
        items.push({
          marker: /\d/.test(m2[2]!) ? m2[2]! : '•',
          text: m2[3]!,
        });
        i++;
      }
      doc.font('Helvetica').fontSize(11).fillColor('#1a1714');
      for (const it of items) {
        const startX = doc.page.margins.left;
        const itemWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
        const markerWidth = 16;
        // Marker.
        doc.text(it.marker, startX, doc.y, {
          continued: false,
          width: markerWidth,
          lineBreak: false,
        });
        // Body indented past the marker.
        doc.x = startX + markerWidth;
        writeWithBold(doc, it.text, { width: itemWidth - markerWidth });
        doc.x = startX;
      }
      doc.moveDown(0.3);
      continue;
    }

    // Blockquote.
    if (/^>\s+/.test(line)) {
      doc.font('Helvetica-Oblique').fontSize(11).fillColor('#555555');
      const text = line.replace(/^>\s+/, '');
      const startY = doc.y;
      writeWithBold(doc, text);
      // Vertical bar in the left margin.
      doc
        .strokeColor('#bbbbbb')
        .lineWidth(2)
        .moveTo(doc.page.margins.left - 8, startY)
        .lineTo(doc.page.margins.left - 8, doc.y - 2)
        .stroke();
      i++;
      continue;
    }

    // Plain paragraph — keep collecting lines until blank or structural.
    const paraLines: string[] = [line];
    let j = i + 1;
    while (j < lines.length) {
      const nxt = lines[j]!;
      if (
        nxt.trim() === '' ||
        /^(#{1,4})\s+/.test(nxt) ||
        /^---+\s*$/.test(nxt.trim()) ||
        /^(\s*)([*-]|\d+\.)\s+/.test(nxt) ||
        /^>\s+/.test(nxt)
      ) {
        break;
      }
      paraLines.push(nxt);
      j++;
    }
    doc.font('Helvetica').fontSize(11).fillColor('#1a1714');
    writeWithBold(doc, paraLines.join(' '));
    doc.moveDown(0.4);
    i = j;
  }
}

// Render text with **bold** runs honored. PDFKit's continued: true keeps
// the text in the same paragraph wrapping context.
function writeWithBold(doc: PDFKit.PDFDocument, text: string, opts: { width?: number } = {}): void {
  // Strip backtick spans down to plain text (we don't have a mono font
  // registered, so faking code styling would just look wrong).
  const cleaned = text.replace(/`([^`]+)`/g, '$1');
  const segments: { text: string; bold: boolean }[] = [];
  const re = /\*\*([^*]+)\*\*/g;
  let cursor = 0;
  let mm: RegExpExecArray | null;
  while ((mm = re.exec(cleaned)) !== null) {
    if (mm.index > cursor) segments.push({ text: cleaned.slice(cursor, mm.index), bold: false });
    segments.push({ text: mm[1]!, bold: true });
    cursor = mm.index + mm[0].length;
  }
  if (cursor < cleaned.length) segments.push({ text: cleaned.slice(cursor), bold: false });
  if (segments.length === 0) segments.push({ text: cleaned, bold: false });

  // Snapshot the font name we were called under so we can restore it after
  // bold runs. PDFKit's type defs don't expose the active font; the
  // private _font field has been stable across versions, so cast through
  // unknown rather than declaring a typed shim.
  const currentFont = (doc as unknown as { _font?: { name?: string } })._font?.name ?? 'Helvetica';
  const baseFont = currentFont === 'Helvetica-Bold' ? 'Helvetica-Bold' : 'Helvetica';
  for (let k = 0; k < segments.length; k++) {
    const s = segments[k]!;
    const isLast = k === segments.length - 1;
    doc.font(s.bold ? 'Helvetica-Bold' : baseFont);
    doc.text(s.text, { continued: !isLast, width: opts.width });
  }
}

function sectionHeading(doc: PDFKit.PDFDocument, label: string): void {
  doc.moveDown(0.6);
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
  // Cite line.
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#1a1714');
  doc.text(`${n}. `, { continued: true });
  doc.font('Helvetica-Bold').text(a.cite ?? '', { continued: true });
  doc.font('Helvetica').fontSize(9).fillColor('#666666');
  const status = a.verified_this_turn ? '  ✓ verified' : '  unverified';
  doc.text(status);

  // Meta line.
  const meta: string[] = [];
  if (a.type) meta.push(a.type);
  if (a.weight) meta.push(`weight: ${a.weight}`);
  if (meta.length) {
    doc.font('Helvetica').fontSize(9).fillColor('#666666').text(meta.join(' · '));
  }
  if (a.source) {
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor('#7a2a1a')
      .text(a.source, {
        link: /^https?:\/\//.test(a.source) ? a.source : undefined,
        underline: /^https?:\/\//.test(a.source),
      });
  }
  if (a.warning) {
    doc.font('Helvetica-Oblique').fontSize(9).fillColor('#7a2a1a').text(`⚠ ${a.warning}`);
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
  if (c.confidence_band) {
    doc.font('Helvetica').fontSize(9).fillColor('#2f4a30').text(c.confidence_band);
    doc.moveDown(0.3);
  }
  if (c.engagement_type) {
    doc
      .font('Helvetica-Bold')
      .fontSize(10)
      .fillColor('#1a1714')
      .text('Engagement: ', { continued: true });
    doc.font('Helvetica').text(c.engagement_type);
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
    const statusText = n.state === 'pass' ? '✓ satisfied' : n.state === 'fail' ? '⚠ review' : 'n/a';
    doc.font('Helvetica').fontSize(11).fillColor('#1a1714');
    doc.text(row.label, { continued: true });
    doc.font('Helvetica').fontSize(9).fillColor('#666666').text(`   ${statusText}`);
    if (n.note) {
      doc.font('Helvetica').fontSize(9).fillColor('#666666').text(n.note);
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
      .text('Disclosure forms: ', { continued: true });
    doc.font('Helvetica').text(forms.join(', '));
  }
  if (c.notes) {
    doc.moveDown(0.3);
    doc
      .font('Helvetica-Bold')
      .fontSize(10)
      .fillColor('#1a1714')
      .text('Notes: ', { continued: true });
    doc.font('Helvetica').text(c.notes);
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
