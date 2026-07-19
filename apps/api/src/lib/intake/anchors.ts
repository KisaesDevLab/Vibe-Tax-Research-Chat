// TP-7 — anchor-regex matching over positioned tokens. Per the master
// plan: match a line label, look in the label row's y-band, drop the
// left line-number column and echoed line numbers, and take the
// RIGHT-MOST number in the band. First match in page order wins.
// Per-vendor anchor overrides live in anchor-overrides.json (config,
// not code).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PdfToken } from './pdf-extract.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface AnchorSpec {
  /** Field key in the extraction output. */
  field: string;
  /** Regex source matched against a joined row of label-side tokens. */
  label: string;
  /** Optional page-scoping regex: only pages whose text matches. */
  pageMarker?: string;
}

/** Base anchors for standard IRS 1040 prints (2025/2026 layout). */
export const BASE_ANCHORS: AnchorSpec[] = [
  { field: 'wages', label: 'Total amount from Form\\(s\\) W-2, box 1|^1a\\b.*W-2' },
  { field: 'interestIncome', label: 'Taxable interest' },
  { field: 'ordinaryDividends', label: 'Ordinary dividends' },
  { field: 'qualifiedDividends', label: 'Qualified dividends' },
  { field: 'capitalGain1040', label: 'Capital gain or \\(loss\\)' },
  { field: 'schedule1Income', label: 'Additional income from Schedule 1' },
  { field: 'agi', label: 'adjusted gross income|Adjusted gross income' },
  { field: 'taxableIncome', label: '^15\\b.*Taxable income|Taxable income\\. Subtract' },
  { field: 'totalTax', label: 'Total tax\\b' },
  // Schedule 1
  {
    field: 'scheduleCNet',
    label: 'Business income or \\(loss\\)',
    pageMarker: 'SCHEDULE 1|Additional Income and Adjustments',
  },
  {
    field: 'schedule1Line5',
    label: 'Rental real estate, royalties, partnerships',
    pageMarker: 'SCHEDULE 1|Additional Income and Adjustments',
  },
  // Schedule 2 / SE
  { field: 'seTax', label: 'Self-employment tax' },
  // Schedule E
  {
    field: 'schERentalNet',
    label: 'Total rental real estate and royalty income',
    pageMarker: 'SCHEDULE E|Supplemental Income',
  },
  {
    field: 'schEPartnershipNet',
    label: 'Total partnership and S corporation income',
    pageMarker: 'SCHEDULE E|Supplemental Income',
  },
  {
    field: 'schETotal',
    label: 'Total income or \\(loss\\)',
    pageMarker: 'SCHEDULE E|Supplemental Income',
  },
  // Schedule D
  {
    field: 'schDShortTerm',
    label: 'Net short-term capital gain or \\(loss\\)',
    pageMarker: 'SCHEDULE D|Capital Gains and Losses',
  },
  {
    field: 'schDLongTerm',
    label: 'Net long-term capital gain or \\(loss\\)',
    pageMarker: 'SCHEDULE D|Capital Gains and Losses',
  },
  // Standard deduction row — used to infer filing status.
  { field: 'standardDeduction', label: 'Standard deduction or itemized deductions' },
];

export interface VendorOverride {
  vendor: string;
  /** Regex detected anywhere in the document text. */
  detect: string;
  anchors: AnchorSpec[];
}

export function loadVendorOverrides(): VendorOverride[] {
  const file = path.join(__dirname, 'anchor-overrides.json');
  return JSON.parse(readFileSync(file, 'utf-8')) as VendorOverride[];
}

const Y_BAND = 4; // PDF points half-height for same-row grouping
// A "number" token: 1,234 / (1,234) / 1234.56 / -1,234 / 0
const NUMBER_RE = /^\(?-?\$?[\d,]+(?:\.\d{1,2})?\)?\.?$/;
// The left line-number column and echoed line numbers ("15", "8b").
const LINE_NO_RE = /^\d{1,2}[a-z]?$/;

export function parseNumberToken(raw: string): number | null {
  let s = raw.trim().replace(/[$,]/g, '').replace(/\.$/, '');
  let negative = false;
  if (s.startsWith('(') && s.endsWith(')')) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (s.startsWith('-')) {
    negative = true;
    s = s.slice(1);
  }
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const n = Number(s);
  return negative ? -n : n;
}

export interface AnchorHit {
  field: string;
  value: number;
  page: number;
  label: string;
}

export function matchAnchors(tokens: PdfToken[], anchors: AnchorSpec[]): AnchorHit[] {
  // Group tokens per page and per row (y-band).
  const pages = new Map<number, PdfToken[]>();
  for (const t of tokens) {
    const list = pages.get(t.page) ?? [];
    list.push(t);
    pages.set(t.page, list);
  }
  const pageText = new Map<number, string>();
  for (const [p, list] of pages) {
    pageText.set(p, list.map((t) => t.str).join(' '));
  }

  const hits: AnchorHit[] = [];
  const found = new Set<string>();

  const pageNumbers = Array.from(pages.keys()).sort((a, b) => a - b);
  for (const pageNo of pageNumbers) {
    const pageTokens = pages.get(pageNo)!;
    // Row grouping by y.
    const rows = new Map<number, PdfToken[]>();
    for (const t of pageTokens) {
      // Bucket y so slightly-offset tokens land in one row.
      const key = Math.round(t.y / Y_BAND);
      const row = rows.get(key) ?? [];
      row.push(t);
      rows.set(key, row);
    }

    for (const anchor of anchors) {
      if (found.has(anchor.field)) continue; // first match in page order wins
      if (anchor.pageMarker && !new RegExp(anchor.pageMarker, 'i').test(pageText.get(pageNo)!)) {
        continue;
      }
      const labelRe = new RegExp(anchor.label, 'i');
      for (const row of rows.values()) {
        const sorted = [...row].sort((a, b) => a.x - b.x);
        const rowText = sorted.map((t) => t.str).join(' ');
        if (!labelRe.test(rowText)) continue;
        // Value = right-most number token, skipping line-number echoes.
        const numbers = sorted
          .filter((t) => !LINE_NO_RE.test(t.str))
          .filter((t) => NUMBER_RE.test(t.str))
          .map((t) => ({ t, value: parseNumberToken(t.str) }))
          .filter((x): x is { t: PdfToken; value: number } => x.value !== null);
        if (numbers.length === 0) continue;
        const rightMost = numbers[numbers.length - 1]!;
        hits.push({
          field: anchor.field,
          value: rightMost.value,
          page: pageNo,
          label: rowText.slice(0, 120),
        });
        found.add(anchor.field);
        break;
      }
    }
  }
  return hits;
}

/** Pick the anchor set: vendor override when its detect regex matches. */
export function selectAnchors(tokens: PdfToken[]): { anchors: AnchorSpec[]; vendor: string } {
  const fullText = tokens.map((t) => t.str).join(' ');
  for (const override of loadVendorOverrides()) {
    if (new RegExp(override.detect, 'i').test(fullText)) {
      // Overrides REPLACE matching fields and append new ones.
      const merged = [...BASE_ANCHORS];
      for (const a of override.anchors) {
        const i = merged.findIndex((b) => b.field === a.field);
        if (i >= 0) merged[i] = a;
        else merged.push(a);
      }
      return { anchors: merged, vendor: override.vendor };
    }
  }
  return { anchors: BASE_ANCHORS, vendor: 'generic' };
}
