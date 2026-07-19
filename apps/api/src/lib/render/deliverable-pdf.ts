// Deliverable rendering on PDFKit — the same server-side engine the chat
// response export uses (lib/export/response-pdf.ts) and for the same
// reasons: real selectable text, reliable base-14 font metrics, small
// files, and zero browser dependency. This replaced the TP-9
// React → HTML → Chromium pipeline.
//
// Layout family: Times (serif) body to keep the deliverables' print
// identity, Helvetica for table chrome, Courier-aligned numerals in the
// money columns. Every page gets the firm footer via bufferPages
// stamping (the recursion-safe pattern proven in response-pdf.ts).
// Advisory strategies always render as qualitative structural
// recommendations — never $0 rows. Strategy names stay hidden on the
// pitch deck and slideshow until the plan is engaged (revealStrategies).
import PDFDocument from 'pdfkit';
import { sanitizeForHelvetica } from '../export/response-pdf.js';
import type { DeliverableKind, RenderData, StrategyRenderData } from './types.js';

const MARGIN = 54; // 0.75in
const FOOTER_RESERVE = 30;
const INK = '#1a1714';
const MUTED = '#666666';
const FAINT = '#999999';
const SAVINGS = '#2f4a30';
const COST = '#7a2a1a';
const RULE = '#dddddd';
const HEADER_FILL = '#f5efe3';

const s = sanitizeForHelvetica; // WinAnsi guard applies to Times/Courier too

const money = (n: number): string =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

function firstYearDelta(d: RenderData): number {
  if (d.baseline.length === 0 || d.scenario.length === 0) return 0;
  return d.scenario[0]!.totalBurden - d.baseline[0]!.totalBurden;
}
function cumulativeDelta(d: RenderData): number {
  const base = d.baseline.reduce((a, y) => a + y.totalBurden, 0);
  const scen = d.scenario.reduce((a, y) => a + y.totalBurden, 0);
  return scen - base;
}

// ── low-level helpers ────────────────────────────────────────────────────

type Doc = PDFKit.PDFDocument;

function usableWidth(doc: Doc): number {
  return doc.page.width - doc.page.margins.left - doc.page.margins.right;
}

function h1(doc: Doc, text: string): void {
  doc.x = doc.page.margins.left;
  doc.font('Times-Bold').fontSize(22).fillColor(INK).text(s(text));
  doc.moveDown(0.3);
}

function h2(doc: Doc, text: string): void {
  doc.x = doc.page.margins.left;
  doc.moveDown(0.6);
  doc.font('Times-Bold').fontSize(15).fillColor(INK).text(s(text));
  doc.moveDown(0.25);
}

function h3(doc: Doc, text: string): void {
  doc.x = doc.page.margins.left;
  doc.moveDown(0.45);
  doc.font('Times-Bold').fontSize(12).fillColor(INK).text(s(text));
  doc.moveDown(0.15);
}

function para(
  doc: Doc,
  text: string,
  opts: { size?: number; color?: string; italic?: boolean } = {},
): void {
  doc.x = doc.page.margins.left;
  doc
    .font(opts.italic ? 'Times-Italic' : 'Times-Roman')
    .fontSize(opts.size ?? 11)
    .fillColor(opts.color ?? INK)
    .text(s(text));
  doc.moveDown(0.35);
}

function bullets(
  doc: Doc,
  items: string[],
  opts: { size?: number; numbered?: boolean } = {},
): void {
  if (items.length === 0) return;
  doc.x = doc.page.margins.left;
  doc
    .font('Times-Roman')
    .fontSize(opts.size ?? 11)
    .fillColor(INK);
  doc.list(items.map(s), {
    bulletRadius: 1.6,
    textIndent: 14,
    bulletIndent: 4,
    listType: opts.numbered ? 'numbered' : 'bullet',
    paragraphGap: 2,
  });
  doc.moveDown(0.3);
}

/** Uppercase pill like the print CSS `.band` chips. */
function band(doc: Doc, label: string): void {
  const text = s(label).toUpperCase();
  doc.font('Helvetica').fontSize(7.5);
  const w = doc.widthOfString(text) + 10;
  const x = doc.x;
  const y = doc.y;
  doc.save();
  doc.roundedRect(x, y, w, 13, 2).lineWidth(0.7).strokeColor(FAINT).stroke();
  doc.restore();
  doc.fillColor(MUTED).text(text, x + 5, y + 3.5, { lineBreak: false });
  doc.x = x + w + 6;
  doc.y = y;
}

/** Heading line with trailing band chips (risk / advisory). */
function strategyHeading(doc: Doc, title: string, chips: string[]): void {
  doc.x = doc.page.margins.left;
  doc.font('Times-Bold').fontSize(15).fillColor(INK).text(s(title));
  if (chips.length > 0) {
    doc.moveDown(0.1);
    const y = doc.y;
    doc.x = doc.page.margins.left;
    for (const chip of chips) band(doc, chip);
    doc.x = doc.page.margins.left;
    doc.y = y + 17;
  }
  doc.moveDown(0.25);
}

/** Advisory strategies: qualitative block with the savings-green bar. */
function advisoryBlock(doc: Doc, strat: StrategyRenderData): void {
  doc.moveDown(0.2);
  const left = doc.page.margins.left;
  const startY = doc.y;
  doc.x = left + 12;
  doc
    .font('Times-Bold')
    .fontSize(10.5)
    .fillColor(INK)
    .text(
      s(
        `Structural recommendation — savings not computed; typical impact band: ${strat.typicalSavingsBand}`,
      ),
      left + 12,
      startY,
      { width: usableWidth(doc) - 12 },
    );
  doc
    .font('Times-Roman')
    .fontSize(10.5)
    .fillColor(INK)
    .text(s(strat.client.headline), left + 12, doc.y + 2, { width: usableWidth(doc) - 12 });
  doc
    .strokeColor(SAVINGS)
    .lineWidth(2.5)
    .moveTo(left + 3, startY)
    .lineTo(left + 3, doc.y)
    .stroke();
  doc.x = left;
  doc.moveDown(0.4);
}

// ── comparison table (Year / Current path / With plan / Difference) ─────

function comparisonTable(doc: Doc, d: RenderData): void {
  const left = doc.page.margins.left;
  const usable = usableWidth(doc);
  const widths = [0.16, 0.28, 0.28, 0.28].map((f) => Math.floor(usable * f));
  const rowH = 20;
  const headers = ['Year', 'Current path', 'With plan', 'Annual difference'];

  const drawRule = (y: number, color: string, weight = 0.5) =>
    doc
      .strokeColor(color)
      .lineWidth(weight)
      .moveTo(left, y)
      .lineTo(left + usable, y)
      .stroke();

  const cell = (
    text: string,
    col: number,
    y: number,
    opts: { bold?: boolean; color?: string; header?: boolean } = {},
  ) => {
    const x = left + widths.slice(0, col).reduce((a, b) => a + b, 0);
    doc
      .font(
        opts.header
          ? 'Helvetica-Bold'
          : opts.bold
            ? 'Courier-Bold'
            : col === 0
              ? 'Times-Roman'
              : 'Courier',
      )
      .fontSize(opts.header ? 8 : 10)
      .fillColor(opts.color ?? (opts.header ? MUTED : INK))
      .text(opts.header ? text.toUpperCase() : text, x + 6, y + 6, {
        width: widths[col]! - 12,
        align: col === 0 ? 'left' : 'right',
        lineBreak: false,
      });
  };

  const rowFits = (n = 1) => doc.y + rowH * n <= doc.page.height - doc.page.margins.bottom;

  const header = () => {
    const y = doc.y;
    doc.save();
    doc.rect(left, y, usable, rowH).fill(HEADER_FILL);
    doc.restore();
    headers.forEach((t, i) => cell(t, i, y, { header: true }));
    doc.y = y + rowH;
    drawRule(doc.y, '#aaaaaa');
  };

  doc.moveDown(0.3);
  drawRule(doc.y, '#aaaaaa');
  header();

  const row = (label: string, base: number, scen: number, bold = false) => {
    if (!rowFits()) {
      doc.addPage();
      header();
    }
    const y = doc.y;
    const delta = scen - base;
    cell(label, 0, y, { bold: false });
    cell(money(base), 1, y, { bold });
    cell(money(scen), 2, y, { bold });
    cell(money(delta), 3, y, { bold: true, color: delta < 0 ? SAVINGS : COST });
    doc.y = y + rowH;
    drawRule(doc.y, RULE);
  };

  d.baseline.forEach((y, i) => row(String(y.year), y.totalBurden, d.scenario[i]?.totalBurden ?? 0));
  row(
    'Cumulative',
    d.baseline.reduce((a, y) => a + y.totalBurden, 0),
    d.scenario.reduce((a, y) => a + y.totalBurden, 0),
    true,
  );
  doc.x = left;
  doc.moveDown(0.5);
}

// ── document shell ───────────────────────────────────────────────────────

function createDoc(d: RenderData, title: string): Doc {
  return new PDFDocument({
    size: 'LETTER',
    bufferPages: true,
    margins: { top: MARGIN, bottom: MARGIN + FOOTER_RESERVE, left: MARGIN, right: MARGIN },
    info: {
      Title: title,
      Author: d.branding.firmName,
      Subject: 'Tax planning deliverable',
    },
  });
}

/** Cover page content, vertically centered like the print CSS `.cover`. */
function cover(doc: Doc, lines: () => void): void {
  doc.y = doc.page.height * 0.34;
  lines();
}

/** Stamp the disclaimer footer + page numbers on every buffered page. */
function stampFooter(doc: Doc, d: RenderData, withPageNumbers: boolean): void {
  const range = doc.bufferedPageRange();
  const pages = range.count;
  const disclaimer = `${d.branding.firmName} · Deterministic projections from published tax tables; planning estimates, not tax advice or a filed return. Figures depend on facts as provided.`;
  for (let i = 0; i < pages; i++) {
    doc.switchToPage(range.start + i);
    doc.save();
    const saved = { ...doc.page.margins };
    doc.page.margins = { top: 0, bottom: 0, left: 0, right: 0 };
    const footerY = doc.page.height - MARGIN - 12;
    doc
      .strokeColor(RULE)
      .lineWidth(0.5)
      .moveTo(MARGIN, footerY - 5)
      .lineTo(doc.page.width - MARGIN, footerY - 5)
      .stroke();
    doc
      .font('Times-Italic')
      .fontSize(8)
      .fillColor('#888888')
      .text(s(disclaimer), MARGIN, footerY, {
        lineBreak: false,
        width: doc.page.width - MARGIN * 2 - (withPageNumbers ? 70 : 0),
        height: 12,
        ellipsis: true,
      });
    if (withPageNumbers) {
      doc
        .font('Helvetica')
        .fontSize(8)
        .fillColor('#888888')
        .text(`Page ${i + 1} of ${pages}`, doc.page.width - MARGIN - 70, footerY, {
          lineBreak: false,
          width: 70,
          align: 'right',
        });
    }
    doc.page.margins = saved;
    doc.restore();
  }
}

// ── the five kinds ───────────────────────────────────────────────────────

function renderAdvisorPdf(doc: Doc, d: RenderData): void {
  cover(doc, () => {
    h1(doc, d.plan.title);
    para(
      doc,
      `Advisor technical copy · ${d.clientName} · ${d.plan.years}-year window · engine ${d.plan.engine_version}`,
      { color: MUTED },
    );
    para(doc, `Generated ${d.generatedAt}`, { size: 9, color: MUTED });
  });

  doc.addPage();
  h2(doc, `Projection — ${d.scenarioLabel}`);
  comparisonTable(doc, d);

  for (const strat of d.strategies) {
    doc.addPage();
    const chips = [`${strat.riskRating} risk`, ...(strat.modeled ? [] : ['advisory'])];
    strategyHeading(doc, strat.name, chips);
    para(doc, strat.advisor.summary);
    if (!strat.modeled) advisoryBlock(doc, strat);
    h3(doc, 'Mechanics');
    bullets(doc, strat.advisor.mechanics, { numbered: true });
    h3(doc, 'Authority');
    bullets(
      doc,
      strat.advisor.authority.map((a) => `[${a.type}] ${a.cite}${a.note ? ` — ${a.note}` : ''}`),
      { size: 9.5 },
    );
    h3(doc, 'Risks');
    bullets(doc, strat.advisor.risks);
    h3(doc, 'Review checklist');
    bullets(doc, strat.advisor.reviewChecklist, { size: 9.5 });
  }
}

function renderClientPdf(doc: Doc, d: RenderData): void {
  cover(doc, () => {
    h1(doc, 'Your tax plan');
    para(doc, `Prepared for ${d.clientName} by ${d.branding.firmName}`, { color: MUTED });
    if (firstYearDelta(d) < 0) {
      doc.moveDown(0.8);
      doc.font('Times-Roman').fontSize(15).fillColor(INK).text('First-year projected savings: ', {
        continued: true,
      });
      doc
        .font('Times-Bold')
        .fillColor(SAVINGS)
        .text(money(-firstYearDelta(d)));
      doc.moveDown(0.2);
      doc
        .font('Times-Roman')
        .fillColor(INK)
        .text(`${d.plan.years}-year projected savings: `, { continued: true });
      doc
        .font('Times-Bold')
        .fillColor(SAVINGS)
        .text(money(-cumulativeDelta(d)));
    }
  });

  doc.addPage();
  h2(doc, 'Where the numbers land');
  comparisonTable(doc, d);
  para(
    doc,
    'Projections use published IRS figures and assume the facts you provided; they are planning estimates, not a promise of results.',
    { size: 9, color: MUTED },
  );

  for (const strat of d.strategies) {
    doc.addPage();
    h2(doc, strat.client.headline);
    for (const p of strat.client.plainEnglish) para(doc, p);
    if (!strat.modeled) advisoryBlock(doc, strat);
    h3(doc, 'What happens next');
    bullets(doc, strat.client.steps);
    h3(doc, 'What we ask of you');
    bullets(doc, strat.client.clientCommitments);
  }
}

function renderHandout(doc: Doc, d: RenderData, strat: StrategyRenderData): void {
  h1(doc, strat.name);
  para(doc, `${d.branding.firmName} · prepared for ${d.clientName}`, { size: 9, color: MUTED });
  h2(doc, strat.client.headline);
  for (const p of strat.client.plainEnglish) para(doc, p);
  h3(doc, 'Benefits');
  bullets(doc, strat.client.benefits);
  h3(doc, 'Steps');
  bullets(doc, strat.client.steps);
  if (!strat.modeled) advisoryBlock(doc, strat);
}

function renderPitchDeck(doc: Doc, d: RenderData): void {
  cover(doc, () => {
    h1(doc, 'Tax planning opportunity review');
    para(doc, `Prepared for ${d.clientName}`, { color: MUTED });
    if (cumulativeDelta(d) < 0) {
      doc.moveDown(0.8);
      doc
        .font('Times-Roman')
        .fontSize(15)
        .fillColor(INK)
        .text('Projected first-year net benefit: ', { continued: true });
      doc
        .font('Times-Bold')
        .fillColor(SAVINGS)
        .text(money(-firstYearDelta(d)));
      doc.moveDown(0.2);
      doc
        .font('Times-Roman')
        .fillColor(INK)
        .text(`Projected ${d.plan.years}-year cumulative benefit: `, { continued: true });
      doc
        .font('Times-Bold')
        .fillColor(SAVINGS)
        .text(money(-cumulativeDelta(d)));
    }
    if (d.plan.fee_plan?.flatFee != null) {
      doc.moveDown(0.6);
      doc
        .font('Times-Roman')
        .fontSize(12)
        .fillColor(INK)
        .text('Engagement fee: ', { continued: true });
      doc.font('Times-Bold').text(money(d.plan.fee_plan.flatFee));
    }
  });

  doc.addPage();
  h2(doc, 'The opportunities');
  const left = doc.page.margins.left;
  const usable = usableWidth(doc);
  const widths = [Math.floor(usable * 0.08), Math.floor(usable * 0.64), Math.floor(usable * 0.28)];
  const headers = ['#', 'Opportunity', 'Typical impact'];
  let y = doc.y + 4;
  doc.save();
  doc.rect(left, y, usable, 18).fill(HEADER_FILL);
  doc.restore();
  headers.forEach((t, i) => {
    const x = left + widths.slice(0, i).reduce((a, b) => a + b, 0);
    doc
      .font('Helvetica-Bold')
      .fontSize(8)
      .fillColor(MUTED)
      .text(t.toUpperCase(), x + 6, y + 5, { width: widths[i]! - 12, lineBreak: false });
  });
  y += 18;
  doc
    .strokeColor('#aaaaaa')
    .lineWidth(0.5)
    .moveTo(left, y)
    .lineTo(left + usable, y)
    .stroke();
  d.strategies.forEach((strat, i) => {
    const label = d.revealStrategies ? strat.name : strat.client.teaser;
    doc.font('Times-Roman').fontSize(10.5);
    const rowH = Math.max(doc.heightOfString(s(label), { width: widths[1]! - 12 }), 12) + 10;
    if (y + rowH > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      y = doc.y;
    }
    doc
      .fillColor(INK)
      .text(String(i + 1), left + 6, y + 5, { width: widths[0]! - 12, lineBreak: false });
    doc.fillColor(INK).text(s(label), left + widths[0]! + 6, y + 5, { width: widths[1]! - 12 });
    doc
      .font('Helvetica')
      .fontSize(7.5)
      .fillColor(MUTED)
      .text(strat.typicalSavingsBand.toUpperCase(), left + widths[0]! + widths[1]! + 6, y + 6, {
        width: widths[2]! - 12,
        lineBreak: false,
      });
    y += rowH;
    doc
      .strokeColor(RULE)
      .lineWidth(0.5)
      .moveTo(left, y)
      .lineTo(left + usable, y)
      .stroke();
  });
  doc.x = left;
  doc.y = y + 10;
  if (!d.revealStrategies) {
    para(
      doc,
      'Full strategy detail, authority citations, and implementation steps are delivered on engagement.',
      { size: 9, color: MUTED },
    );
  }
}

function renderSlideshow(doc: Doc, d: RenderData): void {
  cover(doc, () => {
    h1(doc, d.plan.title);
    para(doc, d.clientName, { color: MUTED });
  });
  doc.addPage();
  h2(doc, 'Projection');
  comparisonTable(doc, d);
  for (const strat of d.strategies) {
    doc.addPage();
    h2(doc, d.revealStrategies ? strat.name : strat.client.teaser);
    para(doc, strat.client.headline);
    bullets(doc, strat.client.benefits);
    if (!strat.modeled) advisoryBlock(doc, strat);
  }
}

// ── entry point ──────────────────────────────────────────────────────────

export function buildDeliverablePdf(
  kind: DeliverableKind,
  d: RenderData,
  handoutStrategyId?: string,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const titles: Record<DeliverableKind, string> = {
      'advisor-pdf': `${d.plan.title} — advisor copy`,
      'client-pdf': `Your tax plan — ${d.clientName}`,
      handout: 'Strategy handout',
      'pitch-deck': 'Tax planning opportunity review',
      slideshow: d.plan.title,
    };
    const doc = createDoc(d, titles[kind]);
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    switch (kind) {
      case 'advisor-pdf':
        renderAdvisorPdf(doc, d);
        break;
      case 'client-pdf':
        renderClientPdf(doc, d);
        break;
      case 'handout': {
        const strat = d.strategies.find((x) => x.id === handoutStrategyId) ?? d.strategies[0];
        if (!strat) throw new Error('no strategy for handout');
        renderHandout(doc, d, strat);
        break;
      }
      case 'pitch-deck':
        renderPitchDeck(doc, d);
        break;
      case 'slideshow':
        renderSlideshow(doc, d);
        break;
    }

    stampFooter(doc, d, kind === 'advisor-pdf' || kind === 'client-pdf');
    doc.end();
  });
}
