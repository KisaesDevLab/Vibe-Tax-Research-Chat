// TP-3a — page-bounded chunking. Wraps the reference chunker PER PAGE so no
// chunk ever spans pages (addendum §6 default: ~800 tokens / 100 overlap =
// the chunker's existing 3200/400-char defaults). chunk_index runs globally
// across the document; char offsets are page-relative.
import { chunkText } from '../references/chunker.js';
import type { DocumentPage } from './pages.js';

export interface PageChunk {
  page: number;
  chunkIndex: number;
  text: string;
  charStart: number;
  charEnd: number;
  tokenCount: number;
}

export function chunkPages(pages: DocumentPage[]): PageChunk[] {
  const out: PageChunk[] = [];
  let chunkIndex = 0;
  for (const page of pages) {
    if (!page.text.trim()) continue;
    for (const chunk of chunkText(page.text)) {
      out.push({
        page: page.page,
        chunkIndex: chunkIndex++,
        text: chunk.text,
        charStart: chunk.charStart,
        charEnd: chunk.charEnd,
        tokenCount: Math.ceil(chunk.text.length / 4),
      });
    }
  }
  return out;
}
