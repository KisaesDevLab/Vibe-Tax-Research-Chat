// TP-11 — archive → PDF memo for the workpaper file.
//
// The layout mirrors the on-screen archive viewer (modules/clients/
// ArchiveViewer.tsx): a header block (title, filing, tags, sha256), then the
// transcript as role-labelled turns hanging off a left rail, then the
// consultation trail. Crucially the transcript is rendered as MARKDOWN, not
// as raw text — the first version printed the model's source verbatim, so
// "## Situation", "**bold**", and every pipe table landed on the page as
// syntax. renderMarkdown (render/markdown-pdf.ts) draws the same subset the
// viewer's <Markdown> renders: headings, lists, tables, fenced code,
// blockquotes, and inline bold/italic/code/links.
//
// Fonts follow the viewer's editorial identity — serif body (Times stands in
// for Source Serif 4), Helvetica for chrome labels, Courier for code and the
// hash. Real text PDF via PDFKit, so it stays selectable and small.
import PDFDocument from 'pdfkit';
import type { ResearchArchive } from '@vibe/db/schema';
import { stripSidecars } from '../parsing/sidecars-strip.js';
import { renderMarkdown } from '../render/markdown-pdf.js';
import { sanitizeForHelvetica } from './pdf-text.js';

const MARGIN = 54; // 0.75in
const FOOTER_RESERVE = 30;
const RAIL_INDENT = 14; // matches the viewer's `border-l-2 pl-4`
const INK = '#1a1714';
const MUTED = '#666666';
const FAINT = '#999999';
const RULE = '#dddddd';
const RAIL = '#d8d2c6';
const OXBLOOD = '#7a2a1a';
const MOSS = '#2f4a30';

type Doc = PDFKit.PDFDocument;

const s = sanitizeForHelvetica;

/** A turn's extent, so its left rail can be stroked after pagination is known. */
interface Rail {
  startPage: number;
  startY: number;
  endPage: number;
  endY: number;
}

interface Authority {
  cite?: string;
  type?: string;
  weight?: string;
  source?: string;
  verified_this_turn?: boolean;
}

function usableWidth(doc: Doc): number {
  return doc.page.width - doc.page.margins.left - doc.page.margins.right;
}

function hr(doc: Doc, color = RULE): void {
  const y = doc.y;
  doc
    .save()
    .strokeColor(color)
    .lineWidth(0.5)
    .moveTo(doc.page.margins.left, y)
    .lineTo(doc.page.width - doc.page.margins.right, y)
    .stroke()
    .restore();
  doc.y = y + 6;
}

/** Small uppercase chrome label — the viewer's `text-[10px] uppercase tracking-wider`. */
function eyebrow(doc: Doc, text: string, color = FAINT): void {
  doc.x = doc.page.margins.left;
  doc
    .font('Helvetica-Bold')
    .fontSize(7.5)
    .fillColor(color)
    .text(s(text).toUpperCase(), { characterSpacing: 0.7, width: usableWidth(doc) });
  doc.font('Helvetica').fontSize(9); // clear the character spacing for callers
}

function metaLine(doc: Doc, text: string, color = MUTED): void {
  doc.x = doc.page.margins.left;
  doc
    .font('Helvetica')
    .fontSize(8.5)
    .fillColor(color)
    .text(s(text), { width: usableWidth(doc) });
}

/**
 * Run `fn` with the left margin pushed in by `indent`.
 *
 * The markdown renderer derives every wrap width — paragraphs, table columns,
 * code blocks — from the page margins, so indenting a whole turn means moving
 * the margin rather than passing an offset down. PDFKit hands new pages the
 * document's own margins object, so pages added inside `fn` inherit the
 * indent and continuation text stays in the same column.
 */
function withIndent(doc: Doc, indent: number, fn: () => void): void {
  const pageMargins = doc.page.margins;
  const optMargins = (doc.options as { margins?: { left: number } }).margins;
  const savedPage = pageMargins.left;
  const savedOpt = optMargins?.left;
  pageMargins.left = savedPage + indent;
  if (optMargins && optMargins !== pageMargins) optMargins.left = (savedOpt ?? savedPage) + indent;
  doc.x = doc.page.margins.left;
  try {
    fn();
  } finally {
    // doc.page may be a page added inside fn; restore whichever margin
    // objects we touched (they are usually the same object).
    doc.page.margins.left = savedPage;
    pageMargins.left = savedPage;
    if (optMargins && savedOpt !== undefined) optMargins.left = savedOpt;
    doc.x = doc.page.margins.left;
  }
}

function currentPageIndex(doc: Doc): number {
  return Math.max(0, doc.bufferedPageRange().count - 1);
}

function parseAuthorities(v: unknown): Authority[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is Authority => typeof x === 'object' && x !== null && 'cite' in x);
}

function renderAuthorities(doc: Doc, list: Authority[]): void {
  if (list.length === 0) return;
  doc.moveDown(0.2);
  eyebrow(doc, 'Authorities cited', MOSS);
  doc.moveDown(0.1);
  for (const a of list) {
    if (!a.cite) continue;
    doc.x = doc.page.margins.left;
    const meta = [a.type, a.weight ? `weight: ${a.weight}` : null]
      .filter(Boolean)
      .map((x) => s(x))
      .join(' · ');
    doc
      .font('Times-Roman')
      .fontSize(9)
      .fillColor(INK)
      .text(
        `• ${s(a.cite)}${a.verified_this_turn ? '  [verified]' : ''}${meta ? `  — ${meta}` : ''}`,
        { width: usableWidth(doc) },
      );
    if (a.source) {
      const isUrl = /^https?:\/\//.test(a.source);
      doc.x = doc.page.margins.left;
      doc
        .font('Helvetica')
        .fontSize(8)
        .fillColor(isUrl ? OXBLOOD : MUTED)
        .text(`   ${s(a.source)}`, {
          width: usableWidth(doc),
          link: isUrl ? a.source : undefined,
          underline: isUrl,
        });
      doc.underline(0, 0, 0, 0, { color: INK });
    }
  }
  doc.moveDown(0.15);
}

export function buildArchivePdf(
  archive: ResearchArchive,
  clientName: string | null,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // bufferPages so the footer, page numbers, and the per-turn left rails
    // can be stamped once the final pagination is known.
    const doc = new PDFDocument({
      size: 'LETTER',
      bufferPages: true,
      margins: {
        top: MARGIN,
        bottom: MARGIN + FOOTER_RESERVE,
        left: MARGIN,
        right: MARGIN,
      },
      info: {
        Title: `Research archive — ${archive.title}`,
        Author: 'Vibe Tax Research',
        Subject: 'Archived research session memo',
        CreationDate: archive.archived_at,
      },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    try {
      renderBody(doc, archive, clientName);
      doc.end();
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

function renderBody(doc: Doc, archive: ResearchArchive, clientName: string | null): void {
  // ── Memo header ──
  eyebrow(doc, 'Research archive');
  doc.moveDown(0.15);
  doc.x = doc.page.margins.left;
  doc
    .font('Times-Bold')
    .fontSize(19)
    .fillColor(INK)
    .text(s(archive.title), { width: usableWidth(doc) });
  doc.moveDown(0.35);

  metaLine(doc, `Filed to: ${clientName ?? (archive.firm_archive ? 'Firm archive' : '—')}`);
  metaLine(doc, `Archived: ${archive.archived_at.toLocaleString()}`);
  if (archive.topic_tags.length > 0) metaLine(doc, `Tags: ${archive.topic_tags.join(' · ')}`);
  if (archive.status !== 'active') metaLine(doc, `Status: ${archive.status}`, OXBLOOD);
  if (archive.tombstone) {
    metaLine(
      doc,
      `Originally filed to ${archive.tombstone.original_client.name} — reassigned to the firm archive on client deletion (${archive.tombstone.at}).`,
      OXBLOOD,
    );
  }
  if (archive.note) {
    doc.moveDown(0.2);
    doc.x = doc.page.margins.left;
    doc
      .font('Times-Italic')
      .fontSize(10)
      .fillColor(INK)
      .text(`Note: ${s(archive.note)}`, { width: usableWidth(doc) });
  }
  doc.moveDown(0.25);
  doc.x = doc.page.margins.left;
  doc
    .font('Courier')
    .fontSize(7)
    .fillColor(FAINT)
    .text(`SHA-256 ${archive.sha256}`, { width: usableWidth(doc) });
  doc.moveDown(0.5);
  hr(doc);

  // ── Transcript ──
  const rails: Rail[] = [];
  for (const m of archive.snapshot.messages) {
    doc.moveDown(0.7);
    // Keep a turn's label with at least the first lines of its body.
    if (doc.y > doc.page.height - doc.page.margins.bottom - 64) doc.addPage();

    const startPage = currentPageIndex(doc);
    const startY = doc.y;

    doc.x = doc.page.margins.left + RAIL_INDENT;
    doc
      .font('Helvetica-Bold')
      .fontSize(7.5)
      .fillColor(m.role === 'assistant' ? OXBLOOD : FAINT)
      .text(`${s(m.role).toUpperCase()}  ·  ${new Date(m.created_at).toLocaleString()}`, {
        characterSpacing: 0.7,
        width: usableWidth(doc) - RAIL_INDENT,
      });
    doc.font('Helvetica').fontSize(9);
    doc.moveDown(0.3);

    withIndent(doc, RAIL_INDENT, () => {
      // The structured authorities/compliance sidecars are rendered below as
      // their own section (and the viewer never shows the raw JSON), so the
      // prose is what belongs in the transcript.
      const prose = stripSidecars(m.content ?? '').trim();
      if (prose) {
        renderMarkdown(doc, prose, {
          ink: INK,
          muted: MUTED,
          rule: RULE,
          link: OXBLOOD,
          size: 10.5,
          headingScale: 1.15,
        });
      }
      renderAuthorities(doc, parseAuthorities(m.authorities));
    });

    rails.push({ startPage, startY, endPage: currentPageIndex(doc), endY: doc.y });
  }

  // ── Consultation trail ──
  const consultations = archive.snapshot.consultations as Array<{
    tool_name?: string;
    url?: string | null;
    query?: string | null;
    fetched_at?: string;
  }>;
  if (consultations.length > 0) {
    doc.moveDown(0.9);
    if (doc.y > doc.page.height - doc.page.margins.bottom - 90) doc.addPage();
    hr(doc);
    doc.moveDown(0.3);
    doc.x = doc.page.margins.left;
    doc
      .font('Times-Bold')
      .fontSize(13)
      .fillColor(INK)
      .text('Primary-source consultations', { width: usableWidth(doc) });
    doc.moveDown(0.25);
    for (const c of consultations) {
      const target = c.url ?? c.query ?? '';
      const isUrl = typeof c.url === 'string' && /^https?:\/\//.test(c.url);
      doc.x = doc.page.margins.left;
      doc
        .font('Helvetica')
        .fontSize(8)
        .fillColor(MUTED)
        .text(`${s(c.tool_name ?? 'tool')}  ·  `, { continued: true, width: usableWidth(doc) })
        .fillColor(isUrl ? OXBLOOD : MUTED)
        .text(s(target), {
          continued: true,
          link: isUrl ? (c.url ?? undefined) : undefined,
          underline: isUrl,
        })
        .fillColor(FAINT)
        .text(c.fetched_at ? `  ·  ${new Date(c.fetched_at).toLocaleString()}` : '', {
          link: undefined,
          underline: false,
        });
      doc.underline(0, 0, 0, 0, { color: INK });
    }
  }

  stampChrome(doc, rails);
}

/**
 * Draw the per-turn rails, the footer disclaimer, and page numbers on every
 * buffered page.
 *
 * Chrome is written with the page margins temporarily zeroed: PDFKit starts a
 * new page whenever text lands inside the bottom margin, and a `pageAdded`
 * listener doing the same work would recurse (the bug that produced "Maximum
 * call stack size exceeded" in response-pdf.ts's first version).
 */
function stampChrome(doc: Doc, rails: Rail[]): void {
  const range = doc.bufferedPageRange();
  const pages = range.count;
  for (let i = 0; i < pages; i++) {
    doc.switchToPage(range.start + i);
    doc.save();
    const saved = { ...doc.page.margins };
    const top = saved.top;
    const bottom = doc.page.height - saved.bottom;
    doc.page.margins = { top: 0, bottom: 0, left: 0, right: 0 };

    // Left rails for any turn that covers this page.
    for (const r of rails) {
      if (i < r.startPage || i > r.endPage) continue;
      const y0 = i === r.startPage ? r.startY : top;
      const y1 = i === r.endPage ? r.endY : bottom;
      if (y1 - y0 < 2) continue;
      doc
        .strokeColor(RAIL)
        .lineWidth(1.5)
        .moveTo(MARGIN + 1.5, y0)
        .lineTo(MARGIN + 1.5, y1)
        .stroke();
    }

    const footerY = doc.page.height - MARGIN - 12;
    doc
      .strokeColor(RULE)
      .lineWidth(0.5)
      .moveTo(MARGIN, footerY - 6)
      .lineTo(doc.page.width - MARGIN, footerY - 6)
      .stroke();
    doc
      .font('Times-Italic')
      .fontSize(8)
      .fillColor('#888888')
      .text(
        'Vibe Tax Research · Immutable archived session; content frozen at archival. AI-generated research — verify citations before reliance.',
        MARGIN,
        footerY,
        {
          lineBreak: false,
          width: doc.page.width - MARGIN * 2 - 70,
          height: 12,
          ellipsis: true,
        },
      );
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor('#888888')
      .text(`Page ${i + 1} of ${pages}`, doc.page.width - MARGIN - 70, footerY, {
        lineBreak: false,
        width: 70,
        align: 'right',
      });

    doc.page.margins = saved;
    doc.restore();
  }
}
