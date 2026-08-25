// TP-3a — page-text reconstruction from positioned PDF tokens. PDF-space y
// grows upward, so rows sort y-DESC; tokens within a row sort x-ASC. The
// same Y_BAND row-grouping tolerance the anchor matcher uses works here.
// Heuristic for multi-column layouts (K-1s) — adequate for prompts and
// chunk text, not for pixel-faithful rendering.
import type { PdfToken } from '../intake/pdf-extract.js';

const Y_BAND = 4; // points

export interface DocumentPage {
  page: number; // 1-based
  text: string;
}

export function pagesFromTokens(tokens: PdfToken[]): DocumentPage[] {
  const byPage = new Map<number, PdfToken[]>();
  for (const t of tokens) {
    const list = byPage.get(t.page);
    if (list) list.push(t);
    else byPage.set(t.page, [t]);
  }

  const pages: DocumentPage[] = [];
  for (const pageNo of [...byPage.keys()].sort((a, b) => a - b)) {
    const pageTokens = [...byPage.get(pageNo)!].sort((a, b) => b.y - a.y || a.x - b.x);
    const rows: PdfToken[][] = [];
    for (const token of pageTokens) {
      const current = rows[rows.length - 1];
      if (current && Math.abs(current[0]!.y - token.y) <= Y_BAND) {
        current.push(token);
      } else {
        rows.push([token]);
      }
    }
    const text = rows
      .map((row) =>
        row
          .sort((a, b) => a.x - b.x)
          .map((t) => t.str)
          .join(' '),
      )
      .join('\n');
    pages.push({ page: pageNo, text });
  }
  return pages;
}
