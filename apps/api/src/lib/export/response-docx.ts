// Server-side DOCX generation for assistant responses.
//
// Mirrors response-pdf.ts in structure but emits a Word document via
// the `docx` library. DOCX uses native Unicode so we don't need the
// WinAnsi fallback table the PDF renderer carries — emojis and
// box-drawing characters render natively.
//
// We render from the same structured message data as the PDF path:
//   - the prose body (markdown, with sidecar JSON stripped)
//   - the parsed authorities[] sidecar
//   - the parsed compliance_check sidecar
// Block-level features supported: headings, bullets/ordered lists,
// horizontal rules, blockquotes, GFM pipe tables, fenced code blocks.
// Inline: bold, italic, inline code, [text](url) links.

import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  Footer,
  Header,
  HeadingLevel,
  LevelFormat,
  Packer,
  PageNumber,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
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

interface Authority {
  cite?: unknown;
  type?: unknown;
  weight?: unknown;
  source?: unknown;
  verified_this_turn?: boolean;
  warning?: unknown;
}

type ComplianceRule = boolean | string | null | { ok?: boolean; note?: string } | undefined;

interface ComplianceCheckShape {
  engagement_type?: unknown;
  confidence_band?: unknown;
  ssts_1_1?: ComplianceRule;
  ssts_2_3?: ComplianceRule;
  circ230_10_22?: ComplianceRule;
  circ230_10_35?: ComplianceRule;
  circ230_10_37?: ComplianceRule;
  circ_230_10_22?: ComplianceRule;
  circ_230_10_35?: ComplianceRule;
  circ_230_10_37?: ComplianceRule;
  disclosure_forms?: unknown[];
  form_disclosure_required?: unknown[];
  notes?: unknown;
  loper_bright_caveat?: boolean;
}

const NUMBERED_LIST_REF = 'numbered-list';

// Defensive coercion at every value-rendering boundary, mirroring
// response-pdf.ts. Authorities and compliance_check are JSONB columns
// populated from the LLM's sidecar output, which is not strictly
// schema-validated — a rogue {"cite": 1234} would otherwise throw.
function toRenderString(s: unknown): string {
  if (typeof s === 'string') return s;
  if (s == null) return '';
  if (typeof s === 'object') {
    try {
      return JSON.stringify(s);
    } catch {
      return '';
    }
  }
  return String(s);
}

export async function buildResponseDocx(m: MessageForExport): Promise<Buffer> {
  const children: (Paragraph | Table)[] = [];

  const prose = stripSidecars(m.content).trim();
  if (prose) renderMarkdownToDocx(prose, children);

  const authorities = parseAuthorityArray(m.authorities);
  if (authorities.length > 0) {
    children.push(sectionHeading('Authorities'));
    authorities.forEach((a, i) => renderAuthority(a, i + 1, children));
  }

  const compliance = parseCompliance(m.compliance_check);
  if (compliance) {
    children.push(sectionHeading('Compliance'));
    renderCompliance(compliance, children);
  }

  const created = new Date(m.created_at).toLocaleString();
  const headerMeta = `Generated ${created} · model ${m.model_id ?? 'unknown'}${
    m.cost_usd != null ? ` · cost $${Number(m.cost_usd).toFixed(4)}` : ''
  }`;

  const doc = new Document({
    creator: 'Vibe Tax Research',
    title: 'Vibe Tax Research response',
    description: 'AI-generated tax research response',
    numbering: {
      config: [
        {
          reference: NUMBERED_LIST_REF,
          levels: [
            {
              level: 0,
              format: LevelFormat.DECIMAL,
              text: '%1.',
              alignment: AlignmentType.LEFT,
              style: { paragraph: { indent: { left: 720, hanging: 360 } } },
            },
          ],
        },
      ],
    },
    styles: {
      default: {
        document: {
          run: { font: 'Calibri', size: 22 }, // 11pt (docx half-points)
        },
      },
    },
    sections: [
      {
        properties: {
          page: {
            // 0.75" margins (1 in = 1440 twentieths-of-a-point).
            margin: { top: 1080, bottom: 1080, left: 1080, right: 1080 },
          },
        },
        headers: {
          default: new Header({
            children: [
              new Paragraph({
                children: [new TextRun({ text: 'Tax research response', bold: true, size: 26 })],
              }),
              new Paragraph({
                children: [new TextRun({ text: headerMeta, size: 18, color: '666666' })],
                border: {
                  bottom: { color: 'DDDDDD', space: 1, style: BorderStyle.SINGLE, size: 4 },
                },
              }),
            ],
          }),
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                border: {
                  top: { color: 'DDDDDD', space: 1, style: BorderStyle.SINGLE, size: 4 },
                },
                tabStops: [{ type: AlignmentType.RIGHT, position: 9000 }],
                children: [
                  new TextRun({
                    text: 'Vibe Tax Research · AI-generated; verify all citations before reliance.',
                    italics: true,
                    size: 16,
                    color: '888888',
                  }),
                  new TextRun({ text: '\t', size: 16 }),
                  new TextRun({
                    children: ['Page ', PageNumber.CURRENT, ' of ', PageNumber.TOTAL_PAGES],
                    size: 16,
                    color: '888888',
                  }),
                ],
              }),
            ],
          }),
        },
        children,
      },
    ],
  });

  return Packer.toBuffer(doc);
}

function sectionHeading(label: string): Paragraph {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    children: [new TextRun({ text: label, bold: true, size: 28 })],
    spacing: { before: 240, after: 120 },
  });
}

// ── Inline ────────────────────────────────────────────────────────────────

// Convert markdown-flavored inline text into an array of TextRun /
// ExternalHyperlink children. Single-pass tokenizer: at each position
// we try the longest-prefix-matching marker; if none, we collect plain
// chars until the next marker. Markers: **bold**, *italic*, `code`,
// [text](url). Order matters: ** matches before *, [...](...) before
// any backtick that might appear inside the link text.
//
// `baseStyle` is merged into every emitted run so callers can apply a
// uniform color / italic flag (e.g., a blockquote's grey italic) on
// top of inline emphasis without needing to introspect TextRun
// internals.
interface InlineBaseStyle {
  italics?: boolean;
  color?: string;
}

function inlineToRuns(
  s: unknown,
  baseStyle: InlineBaseStyle = {},
): (TextRun | ExternalHyperlink)[] {
  const text = toRenderString(s);
  type Token = {
    kind: 'plain' | 'bold' | 'italic' | 'code' | 'link';
    text: string;
    href?: string;
  };
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    const link = rest.match(/^\[([^\]]+)\]\((https?:\/\/[^)]+)\)/);
    if (link) {
      tokens.push({ kind: 'link', text: link[1]!, href: link[2]! });
      i += link[0].length;
      continue;
    }
    const bold = rest.match(/^\*\*([^*]+)\*\*/);
    if (bold) {
      tokens.push({ kind: 'bold', text: bold[1]! });
      i += bold[0].length;
      continue;
    }
    const italic = rest.match(/^\*([^*\n]+?)\*/);
    if (italic) {
      tokens.push({ kind: 'italic', text: italic[1]! });
      i += italic[0].length;
      continue;
    }
    const code = rest.match(/^`([^`]+)`/);
    if (code) {
      tokens.push({ kind: 'code', text: code[1]! });
      i += code[0].length;
      continue;
    }
    let j = i;
    while (j < text.length) {
      const slice = text.slice(j);
      if (
        slice.startsWith('**') ||
        slice.startsWith('*') ||
        slice.startsWith('`') ||
        slice.startsWith('[')
      )
        break;
      j++;
    }
    if (j === i) j++; // safety: never infinite-loop
    tokens.push({ kind: 'plain', text: text.slice(i, j) });
    i = j;
  }

  const filtered = tokens.filter((t) => t.text.length > 0);
  if (filtered.length === 0) return [new TextRun({ text: '', ...baseStyle })];

  return filtered.map((t) => {
    switch (t.kind) {
      case 'bold':
        return new TextRun({ text: t.text, bold: true, ...baseStyle });
      case 'italic':
        return new TextRun({ text: t.text, italics: true, ...baseStyle });
      case 'code':
        return new TextRun({ text: t.text, font: 'Courier New', ...baseStyle });
      case 'link':
        return new ExternalHyperlink({
          link: t.href!,
          children: [new TextRun({ text: t.text, color: '7A2A1A', underline: {} })],
        });
      default:
        return new TextRun({ text: t.text, ...baseStyle });
    }
  });
}

// ── Markdown → DOCX ───────────────────────────────────────────────────────

function renderMarkdownToDocx(md: string, out: (Paragraph | Table)[]): void {
  const lines = md.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;

    if (line.trim() === '') {
      i++;
      continue;
    }

    // Fenced code block — must be detected before the heading branch
    // since the inline backtick-stripper would otherwise chew the
    // outer fences.
    if (/^\s*```/.test(line)) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i]!)) {
        codeLines.push(lines[i]!);
        i++;
      }
      if (i < lines.length) i++;
      renderCodeBlock(codeLines, out);
      continue;
    }

    // Heading.
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const level = h[1]!.length;
      const headingMap = [
        HeadingLevel.HEADING_1,
        HeadingLevel.HEADING_2,
        HeadingLevel.HEADING_3,
        HeadingLevel.HEADING_4,
      ];
      const sizesHalfPt = [32, 28, 24, 22]; // 16pt, 14pt, 12pt, 11pt
      out.push(
        new Paragraph({
          heading: headingMap[level - 1],
          children: [
            new TextRun({
              text: toRenderString(h[2]),
              bold: true,
              size: sizesHalfPt[level - 1]!,
            }),
          ],
          spacing: { before: 240, after: 120 },
        }),
      );
      i++;
      continue;
    }

    // Horizontal rule.
    if (/^---+\s*$/.test(line.trim())) {
      out.push(
        new Paragraph({
          border: { bottom: { color: 'DDDDDD', space: 1, style: BorderStyle.SINGLE, size: 6 } },
          spacing: { before: 120, after: 120 },
        }),
      );
      i++;
      continue;
    }

    // List block.
    const listMatch = line.match(/^(\s*)([*-]|\d+\.)\s+(.*)$/);
    if (listMatch) {
      const isOrdered = /\d/.test(listMatch[2]!);
      while (i < lines.length) {
        const m2 = lines[i]!.match(/^(\s*)([*-]|\d+\.)\s+(.*)$/);
        if (!m2) break;
        out.push(
          new Paragraph({
            children: inlineToRuns(m2[3]!),
            ...(isOrdered
              ? { numbering: { reference: NUMBERED_LIST_REF, level: 0 } }
              : { bullet: { level: 0 } }),
          }),
        );
        i++;
      }
      continue;
    }

    // GFM pipe table.
    const table = tryParseTable(lines, i);
    if (table) {
      out.push(buildTable(table.rows, table.alignments));
      i = table.nextIdx;
      continue;
    }

    // Blockquote — italic + indent + left bar.
    if (/^>\s+/.test(line)) {
      const text = line.replace(/^>\s+/, '');
      out.push(
        new Paragraph({
          children: inlineToRuns(text, { italics: true, color: '555555' }),
          indent: { left: 360 },
          border: { left: { color: 'BBBBBB', space: 8, style: BorderStyle.SINGLE, size: 12 } },
          spacing: { after: 120 },
        }),
      );
      i++;
      continue;
    }

    // Plain paragraph — collect contiguous lines, then split inline.
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
        (lines[j + 1] !== undefined &&
          nxt.includes('|') &&
          /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(lines[j + 1]!))
      ) {
        break;
      }
      paraLines.push(nxt);
      j++;
    }
    const joined = paraLines.join(' ').trim();
    const italicWhole = /^\*[^*\n]+\*$/.test(joined);
    const body = italicWhole ? joined.slice(1, -1) : joined;
    out.push(
      new Paragraph({
        children: italicWhole
          ? [new TextRun({ text: body, italics: true, color: '555555' })]
          : inlineToRuns(body),
        spacing: { after: 120 },
      }),
    );
    i = j;
  }
}

// One-cell Table acts as a tinted "block" container so the shading is
// contiguous across all code lines instead of having gaps between
// individual paragraphs (which docx would render with white margins).
function renderCodeBlock(codeLines: string[], out: (Paragraph | Table)[]): void {
  const lineParas = codeLines.map(
    (raw) =>
      new Paragraph({
        children: [
          new TextRun({ text: toRenderString(raw) || ' ', font: 'Courier New', size: 18 }),
        ],
        spacing: { after: 0, line: 240 },
      }),
  );
  if (lineParas.length === 0) return;
  out.push(
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: {
        top: { style: BorderStyle.NONE, size: 0, color: 'auto' },
        bottom: { style: BorderStyle.NONE, size: 0, color: 'auto' },
        left: { style: BorderStyle.NONE, size: 0, color: 'auto' },
        right: { style: BorderStyle.NONE, size: 0, color: 'auto' },
        insideHorizontal: { style: BorderStyle.NONE, size: 0, color: 'auto' },
        insideVertical: { style: BorderStyle.NONE, size: 0, color: 'auto' },
      },
      rows: [
        new TableRow({
          children: [
            new TableCell({
              shading: { type: ShadingType.SOLID, color: 'F5EFE3', fill: 'F5EFE3' },
              margins: { top: 120, bottom: 120, left: 160, right: 160 },
              children: lineParas,
            }),
          ],
        }),
      ],
    }),
  );
}

// ── Tables ────────────────────────────────────────────────────────────────

type CellAlign = 'left' | 'center' | 'right';

interface ParsedTable {
  rows: string[][];
  alignments: CellAlign[];
  nextIdx: number;
}

function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
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
    while (cells.length < headerCells.length) cells.push('');
    if (cells.length > headerCells.length) cells.length = headerCells.length;
    rows.push(cells);
    i++;
  }
  if (rows.length < 2) return null;
  return { rows, alignments, nextIdx: i };
}

const ALIGN_MAP: Record<CellAlign, (typeof AlignmentType)[keyof typeof AlignmentType]> = {
  left: AlignmentType.LEFT,
  center: AlignmentType.CENTER,
  right: AlignmentType.RIGHT,
};

function buildTable(rows: string[][], alignments: CellAlign[]): Table {
  const headerRow = rows[0]!;
  const bodyRows = rows.slice(1);

  const docxRows = [
    new TableRow({
      tableHeader: true,
      children: headerRow.map(
        (cell, c) =>
          new TableCell({
            shading: { type: ShadingType.SOLID, color: 'F5EFE3', fill: 'F5EFE3' },
            margins: { top: 80, bottom: 80, left: 100, right: 100 },
            children: [
              new Paragraph({
                children: [new TextRun({ text: toRenderString(cell), bold: true })],
                alignment: ALIGN_MAP[alignments[c] ?? 'left'],
              }),
            ],
          }),
      ),
    }),
    ...bodyRows.map(
      (row) =>
        new TableRow({
          children: row.map(
            (cell, c) =>
              new TableCell({
                margins: { top: 80, bottom: 80, left: 100, right: 100 },
                children: [
                  new Paragraph({
                    children: inlineToRuns(cell),
                    alignment: ALIGN_MAP[alignments[c] ?? 'left'],
                  }),
                ],
              }),
          ),
        }),
    ),
  ];

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: { color: 'AAAAAA', size: 4, style: BorderStyle.SINGLE },
      bottom: { color: 'AAAAAA', size: 4, style: BorderStyle.SINGLE },
      left: { color: 'AAAAAA', size: 4, style: BorderStyle.SINGLE },
      right: { color: 'AAAAAA', size: 4, style: BorderStyle.SINGLE },
      insideHorizontal: { color: 'E2DCCF', size: 4, style: BorderStyle.SINGLE },
      insideVertical: { color: 'E2DCCF', size: 4, style: BorderStyle.SINGLE },
    },
    rows: docxRows,
  });
}

// ── Authorities ───────────────────────────────────────────────────────────

function parseAuthorityArray(v: unknown): Authority[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is Authority => typeof x === 'object' && x !== null && 'cite' in x);
}

function renderAuthority(a: Authority, n: number, out: (Paragraph | Table)[]): void {
  const status = a.verified_this_turn ? 'verified' : 'unverified';
  out.push(
    new Paragraph({
      spacing: { before: 80, after: 40 },
      children: [
        new TextRun({ text: `${n}. `, bold: true }),
        new TextRun({ text: toRenderString(a.cite), bold: true }),
        new TextRun({ text: `    [${status}]`, bold: true }),
      ],
    }),
  );
  const meta: string[] = [];
  if (a.type) meta.push(toRenderString(a.type));
  if (a.weight) meta.push(`weight: ${toRenderString(a.weight)}`);
  if (meta.length) {
    out.push(
      new Paragraph({
        children: [new TextRun({ text: meta.join(' · '), size: 18, color: '666666' })],
        spacing: { after: 40 },
      }),
    );
  }
  if (a.source) {
    const src = toRenderString(a.source);
    const isUrl = /^https?:\/\//.test(src);
    out.push(
      new Paragraph({
        spacing: { after: 40 },
        children: isUrl
          ? [
              new ExternalHyperlink({
                link: src,
                children: [new TextRun({ text: src, color: '7A2A1A', underline: {}, size: 18 })],
              }),
            ]
          : [new TextRun({ text: src, color: '7A2A1A', size: 18 })],
      }),
    );
  }
  if (a.warning) {
    out.push(
      new Paragraph({
        children: [
          new TextRun({
            text: `Warning: ${toRenderString(a.warning)}`,
            italics: true,
            color: '7A2A1A',
            size: 18,
          }),
        ],
        spacing: { after: 80 },
      }),
    );
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

function renderCompliance(c: ComplianceCheckShape, out: (Paragraph | Table)[]): void {
  if (c.confidence_band) {
    out.push(
      new Paragraph({
        children: [
          new TextRun({ text: toRenderString(c.confidence_band), color: '2F4A30', size: 18 }),
        ],
        spacing: { after: 80 },
      }),
    );
  }
  if (c.engagement_type) {
    out.push(
      new Paragraph({
        children: [
          new TextRun({ text: `Engagement: ${toRenderString(c.engagement_type)}`, bold: true }),
        ],
        spacing: { after: 80 },
      }),
    );
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
    out.push(
      new Paragraph({
        children: [new TextRun({ text: `${row.label}    [${statusText}]` })],
        spacing: { after: 40 },
      }),
    );
    if (n.note) {
      out.push(
        new Paragraph({
          children: [new TextRun({ text: toRenderString(n.note), size: 18, color: '666666' })],
          spacing: { after: 80 },
        }),
      );
    }
  }
  const formsRaw = (c.disclosure_forms ?? c.form_disclosure_required ?? []) as unknown[];
  const forms = formsRaw
    .map(toRenderString)
    .filter((f) => f && f.toLowerCase() !== 'none' && f.toLowerCase() !== 'n/a');
  if (forms.length > 0) {
    out.push(
      new Paragraph({
        children: [new TextRun({ text: `Disclosure forms: ${forms.join(', ')}`, bold: true })],
        spacing: { before: 80, after: 80 },
      }),
    );
  }
  if (c.notes) {
    out.push(
      new Paragraph({
        children: [new TextRun({ text: `Notes: ${toRenderString(c.notes)}`, bold: true })],
        spacing: { before: 80, after: 80 },
      }),
    );
  }
  if (c.loper_bright_caveat) {
    out.push(
      new Paragraph({
        children: [
          new TextRun({
            text: 'Post-Loper Bright: cited Treasury Regulations carry only Skidmore weight.',
            italics: true,
            color: '666666',
            size: 18,
          }),
        ],
        spacing: { before: 80 },
      }),
    );
  }
}
