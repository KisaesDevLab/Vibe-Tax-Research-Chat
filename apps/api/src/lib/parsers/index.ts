// Phase 23 — attachment parsers. Dispatches by mime type.
import mammoth from 'mammoth';
import pdfParse from 'pdf-parse';

export interface ParsedAttachment {
  full_text: string;
  ocr_applied: boolean;
}

export async function parseAttachment(input: {
  buffer: Buffer;
  mime_type: string;
  filename: string;
}): Promise<ParsedAttachment> {
  const mt = input.mime_type.toLowerCase();
  if (mt === 'application/pdf') {
    const r = await pdfParse(input.buffer);
    if (r.text.trim().length < 32) {
      // Likely a scanned PDF — TODO Phase 23: hand off to Tesseract bridge.
      return { full_text: r.text ?? '', ocr_applied: false };
    }
    return { full_text: r.text, ocr_applied: false };
  }
  if (
    mt === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    input.filename.toLowerCase().endsWith('.docx')
  ) {
    const r = await mammoth.extractRawText({ buffer: input.buffer });
    return { full_text: r.value, ocr_applied: false };
  }
  if (mt.startsWith('text/') || mt === 'application/json') {
    return { full_text: input.buffer.toString('utf-8'), ocr_applied: false };
  }
  if (mt.startsWith('image/')) {
    // TODO Phase 23: OCR via Tesseract bridge; v1.5 swaps to GLM-OCR.
    return { full_text: '', ocr_applied: false };
  }
  return { full_text: '', ocr_applied: false };
}
