// Markdown → PDFKit for the plan memo and the research-archive export.
//
// The rest of the render pipeline draws from structured RenderData, but the
// memo is free-form markdown authored in the WYSIWYG editor, so it needs a
// real renderer: without one, PDFKit prints the source verbatim ("## Situation",
// "**bold**"). marked does the tokenizing; this module owns the drawing and
// renders what those documents actually contain — headings, paragraphs, lists,
// blockquotes, fenced code, GFM tables, rules, and inline bold/italic/code/
// links — degrading unknown tokens to plain text rather than dropping them.
// Tables and code blocks are drawn by the shared block renderers in
// export/pdf-blocks.ts, the same ones the chat-response PDF uses.
import { marked, type Token, type Tokens } from 'marked';
import { sanitizeForHelvetica, sanitizeRun } from '../export/pdf-text.js';
import { renderCodeBlock, renderTable, type CellAlign } from '../export/pdf-blocks.js';

type Doc = PDFKit.PDFDocument;

const s = sanitizeForHelvetica;

export interface MarkdownPdfStyle {
  ink: string;
  muted: string;
  rule: string;
  link: string;
  /** Body size; headings and code derive from it. */
  size?: number;
  /**
   * Multiplier on the heading scale. The memo's headings sit UNDER the
   * deliverable's own h2 and stay at 1; the archive transcript owns its page
   * and opens them up a little.
   */
  headingScale?: number;
}

interface Run {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  href?: string;
}

/** Flatten marked's inline tokens into styled runs. */
function toRuns(tokens: Token[] | undefined, inherited: Omit<Run, 'text'> = {}): Run[] {
  if (!tokens) return [];
  const out: Run[] = [];
  for (const t of tokens) {
    const tok = t as Tokens.Generic & {
      tokens?: Token[];
      text?: string;
      href?: string;
      raw?: string;
    };
    switch (t.type) {
      case 'strong':
        out.push(...toRuns(tok.tokens, { ...inherited, bold: true }));
        break;
      case 'em':
        out.push(...toRuns(tok.tokens, { ...inherited, italic: true }));
        break;
      case 'codespan':
        out.push({ ...inherited, code: true, text: tok.text ?? '' });
        break;
      case 'link':
        out.push(
          ...(tok.tokens?.length
            ? toRuns(tok.tokens, { ...inherited, href: tok.href })
            : [{ ...inherited, href: tok.href, text: tok.text ?? tok.href ?? '' }]),
        );
        break;
      case 'br':
        out.push({ ...inherited, text: '\n' });
        break;
      case 'del':
      case 'text':
        // `text` tokens can themselves carry nested inline tokens.
        if (tok.tokens?.length) out.push(...toRuns(tok.tokens, inherited));
        else out.push({ ...inherited, text: tok.text ?? '' });
        break;
      default:
        // Anything unmodelled (html, escape, …) still contributes its text.
        if (tok.tokens?.length) out.push(...toRuns(tok.tokens, inherited));
        else if (tok.text) out.push({ ...inherited, text: tok.text });
        break;
    }
  }
  return out.filter((r) => r.text !== '');
}

function fontFor(run: Run): string {
  if (run.code) return 'Courier';
  if (run.bold && run.italic) return 'Times-BoldItalic';
  if (run.bold) return 'Times-Bold';
  if (run.italic) return 'Times-Italic';
  return 'Times-Roman';
}

function usableWidth(doc: Doc): number {
  return doc.page.width - doc.page.margins.left - doc.page.margins.right;
}

/**
 * Draw styled runs as one flowing paragraph. PDFKit joins runs with
 * `continued: true`; only the final run closes the paragraph, so the whole
 * line wraps and breaks pages as a unit.
 */
function drawRuns(
  doc: Doc,
  runs: Run[],
  style: MarkdownPdfStyle,
  opts: { size: number; indent?: number; color?: string; bold?: boolean } = { size: 11 },
): void {
  if (runs.length === 0) {
    doc.moveDown(0.3);
    return;
  }
  const indent = opts.indent ?? 0;
  const width = usableWidth(doc) - indent;
  doc.x = doc.page.margins.left + indent;
  runs.forEach((run, i) => {
    const last = i === runs.length - 1;
    const base = opts.bold && !run.code ? { ...run, bold: true } : run;
    doc
      .font(fontFor(base))
      .fontSize(run.code ? opts.size - 0.5 : opts.size)
      .fillColor(run.href ? style.link : (opts.color ?? style.ink));
    // sanitizeRun, not the trimming sanitizer: the space between a plain run
    // and the bold/linked run that follows it belongs to the run boundary.
    // Only the paragraph's own outer edges get trimmed.
    let text = sanitizeRun(run.text);
    if (i === 0) text = text.replace(/^[ \t]+/, '');
    if (last) text = text.replace(/[ \t]+$/, '');
    doc.text(text, {
      continued: !last,
      width,
      link: run.href,
      underline: Boolean(run.href),
    });
  });
  // A continued sequence leaves underline/link state on the doc; reset so
  // the next block does not inherit them.
  doc.underline(0, 0, 0, 0, { color: style.ink });
}

function horizontalRule(doc: Doc, style: MarkdownPdfStyle): void {
  doc.moveDown(0.4);
  const y = doc.y;
  doc
    .save()
    .strokeColor(style.rule)
    .lineWidth(0.5)
    .moveTo(doc.page.margins.left, y)
    .lineTo(doc.page.width - doc.page.margins.right, y)
    .stroke()
    .restore();
  doc.y = y + 6;
  doc.moveDown(0.3);
}

function renderTokens(doc: Doc, tokens: Token[], style: MarkdownPdfStyle, depth = 0): void {
  const body = style.size ?? 11;
  for (const t of tokens) {
    const tok = t as Tokens.Generic & { tokens?: Token[]; text?: string };
    switch (t.type) {
      case 'heading': {
        const h = t as Tokens.Heading;
        // Memo headings sit UNDER the section's own h2, so they start a step
        // down from it and never compete with the document's title scale.
        const sizes: Record<number, number> = { 1: 13.5, 2: 12, 3: 11, 4: 10.5, 5: 10, 6: 10 };
        const scale = style.headingScale ?? 1;
        doc.moveDown(h.depth <= 2 ? 0.5 : 0.35);
        drawRuns(doc, toRuns(h.tokens), style, {
          size: (sizes[h.depth] ?? 11) * scale,
          bold: true,
        });
        doc.moveDown(0.15);
        break;
      }
      case 'paragraph': {
        drawRuns(doc, toRuns((t as Tokens.Paragraph).tokens), style, { size: body });
        doc.moveDown(0.3);
        break;
      }
      case 'list': {
        const list = t as Tokens.List;
        let n = typeof list.start === 'number' && list.start > 0 ? list.start : 1;
        for (const item of list.items) {
          const marker = list.ordered ? `${n}.` : '•';
          n += 1;
          const indent = 14 + depth * 14;
          // Marker and text are drawn separately so wrapped lines align to
          // the text column rather than sliding back under the bullet.
          const markerWidth = 14;
          const yStart = doc.y;
          doc
            .font('Times-Roman')
            .fontSize(body)
            .fillColor(style.ink)
            .text(s(marker), doc.page.margins.left + indent - markerWidth, yStart, {
              width: markerWidth,
              continued: false,
            });
          doc.y = yStart;
          // An item's own paragraph/nested-list children render inside it.
          const inlineTokens = item.tokens.filter((c) => c.type !== 'list');
          const nested = item.tokens.filter((c) => c.type === 'list');
          const runs = inlineTokens.flatMap((c) => {
            const g = c as Tokens.Generic & { tokens?: Token[]; text?: string };
            return g.tokens ? toRuns(g.tokens) : g.text ? [{ text: g.text }] : [];
          });
          drawRuns(doc, runs, style, { size: body, indent });
          if (nested.length > 0) renderTokens(doc, nested, style, depth + 1);
          doc.moveDown(0.1);
        }
        doc.moveDown(0.25);
        break;
      }
      case 'blockquote': {
        const q = t as Tokens.Blockquote;
        doc.moveDown(0.2);
        const startY = doc.y;
        // Render first, then draw the accent bar beside it — but only when the
        // quote stayed on one page, since a bar spanning a page break would
        // paint over the footer.
        const startPage = doc.bufferedPageRange().count;
        renderTokens(doc, q.tokens, { ...style, ink: style.muted }, depth);
        const endPage = doc.bufferedPageRange().count;
        if (endPage === startPage && doc.y > startY) {
          doc
            .save()
            .strokeColor(style.rule)
            .lineWidth(2)
            .moveTo(doc.page.margins.left + 3, startY)
            .lineTo(doc.page.margins.left + 3, doc.y - 4)
            .stroke()
            .restore();
        }
        doc.moveDown(0.2);
        break;
      }
      case 'code': {
        const c = t as Tokens.Code;
        // Tinted Courier block: alignment in ASCII tables / decision trees is
        // the whole reason a fenced block was used, so it is measured and
        // drawn line-by-line rather than flowed as one wrapped string.
        renderCodeBlock(doc, c.text.split('\n'), { ink: style.ink, size: body - 2 });
        break;
      }
      case 'table': {
        const tbl = t as Tokens.Table;
        // The shared renderer works on raw cell markdown — it strips the
        // inline syntax itself and keeps whole-cell bold.
        const rows = [tbl.header.map((c) => c.text), ...tbl.rows.map((r) => r.map((c) => c.text))];
        const alignments: CellAlign[] = tbl.header.map(
          (_, i) => (tbl.align[i] ?? 'left') as CellAlign,
        );
        renderTable(doc, rows, alignments, {
          family: 'Times',
          size: Math.max(8, body - 1),
          ink: style.ink,
        });
        break;
      }
      case 'hr':
        horizontalRule(doc, style);
        break;
      case 'space':
        break;
      case 'html':
        // The editor writes html:false, so this is stray text, not markup.
        if (tok.text?.trim()) {
          drawRuns(doc, [{ text: tok.text.trim() }], style, { size: body });
        }
        break;
      default: {
        if (tok.tokens?.length) renderTokens(doc, tok.tokens, style, depth);
        else if (tok.text?.trim()) drawRuns(doc, [{ text: tok.text }], style, { size: body });
        break;
      }
    }
  }
}

/** Render a markdown string into the document at the current cursor. */
export function renderMarkdown(doc: Doc, markdown: string, style: MarkdownPdfStyle): void {
  const text = markdown?.trim();
  if (!text) return;
  const tokens = marked.lexer(text, { gfm: true, breaks: false });
  renderTokens(doc, tokens, style);
  doc.x = doc.page.margins.left;
}
