// TP-7 — text-layer extraction with coordinates. pdfjs-dist gives each
// text item a transform matrix; x = transform[4], y = transform[5]
// (PDF-space, origin bottom-left — larger y is HIGHER on the page). The
// anchor matcher only needs same-row grouping, so raw PDF y works.
// Local, no AI: scanned PDFs (no text layer) return zero tokens and the
// caller surfaces the OCR seam's not-configured error.
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

export interface PdfToken {
  str: string;
  x: number;
  y: number;
  width: number;
  page: number; // 1-based
}

export async function extractPdfTokens(buffer: Buffer): Promise<PdfToken[]> {
  const loadingTask = getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
    // No worker in Node.
    disableFontFace: true,
  });
  const doc = await loadingTask.promise;

  const tokens: PdfToken[] = [];
  try {
    for (let pageNo = 1; pageNo <= doc.numPages; pageNo++) {
      const page = await doc.getPage(pageNo);
      const content = await page.getTextContent();
      for (const item of content.items) {
        if (!('str' in item) || typeof item.str !== 'string') continue;
        const str = item.str.trim();
        if (!str) continue;
        const transform = (item as { transform: number[] }).transform;
        tokens.push({
          str,
          x: transform[4] ?? 0,
          y: transform[5] ?? 0,
          width: (item as { width?: number }).width ?? 0,
          page: pageNo,
        });
      }
      page.cleanup();
    }
  } finally {
    await loadingTask.destroy();
  }
  return tokens;
}
