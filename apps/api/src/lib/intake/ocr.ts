// TP-7 — OCR seam for scanned returns. The master plan routes scans to
// GLM-OCR on vibellm; no vibellm exists in this deployment, so the
// provider interface ships with a not-configured stub (QUESTIONS.md).
// A future provider returns positioned tokens compatible with the same
// anchor matcher.
import type { PdfToken } from './pdf-extract.js';

export interface OcrProvider {
  name: string;
  extractTokens(buffer: Buffer): Promise<PdfToken[]>;
}

export class OcrNotConfiguredError extends Error {
  code = 'ocr_not_configured' as const;
  constructor() {
    super(
      'This PDF has no text layer (scanned return) and no OCR provider is configured. Configure vibellm GLM-OCR or enter the profile manually.',
    );
  }
}

export function getOcrProvider(): OcrProvider | null {
  // Seam: read OCR_PROVIDER_URL etc. here when a provider exists.
  return null;
}
