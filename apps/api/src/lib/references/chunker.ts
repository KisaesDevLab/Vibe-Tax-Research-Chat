// Phase 32 — text chunker for the firm reference library.
//
// Pragmatic packing: paragraph-aware, sentence-boundary-honoring, with a
// soft target size and a configurable overlap. Voyage's tokenizer ~= 4
// chars/token for English prose; we approximate with chars to avoid
// pulling in a tokenizer dependency just for chunking. The 800-token
// target the plan calls for becomes ~3200 chars; overlap is ~400 chars.
//
// Output is start/end char offsets relative to the input string so the
// admin "test retrieval" UI can highlight the original passage in the
// document, and so future re-chunkings can audit drift against the v1
// segmentation.

export interface Chunk {
  index: number;
  text: string;
  charStart: number;
  charEnd: number;
}

export interface ChunkOptions {
  /** Target chunk size in characters. ~3200 chars ≈ 800 tokens for English prose. */
  targetChars?: number;
  /** Soft maximum before forcing a split mid-paragraph. */
  maxChars?: number;
  /** Overlap between consecutive chunks, in characters. */
  overlapChars?: number;
}

const DEFAULT_OPTS: Required<ChunkOptions> = {
  targetChars: 3200,
  maxChars: 4000,
  overlapChars: 400,
};

// Sentence boundary regex. Captures `[.!?]` followed by whitespace and an
// uppercase letter. Conservative — keeps abbreviations like "Sec." or
// "U.S.C." intact at the cost of occasional missed splits.
const SENTENCE_BREAK = /(?<=[.!?])\s+(?=[A-Z])/g;

export function chunkText(input: string, opts: ChunkOptions = {}): Chunk[] {
  const { targetChars, maxChars, overlapChars } = { ...DEFAULT_OPTS, ...opts };
  const text = input.replace(/\r\n/g, '\n');
  if (text.trim().length === 0) return [];

  const segments = collectSegments(text, maxChars);
  const out: Chunk[] = [];
  let buf = '';
  let bufStart = -1;
  let chunkIdx = 0;

  // Soft flush at a clean boundary (sentence/paragraph end). Used when
  // we're at-target and ready to start a new chunk.
  const softFlush = (endOffset: number) => {
    const trimmed = buf.trim();
    if (trimmed.length === 0) {
      buf = '';
      bufStart = -1;
      return;
    }
    out.push({
      index: chunkIdx++,
      text: trimmed,
      charStart: bufStart,
      charEnd: endOffset,
    });
    // Carry a tail of the prior chunk into the next so a query whose
    // answer straddles a boundary still retrieves the right neighborhood.
    const overlap = buf.slice(-overlapChars);
    buf = overlap;
    bufStart = endOffset - overlap.length;
  };

  // Hard split inside the buffer when it grows past maxChars even after
  // a soft flush — the only case where this kicks in is a paragraph or
  // sentence longer than maxChars. We slice exactly maxChars, push, and
  // keep going. Without this, oversized inputs (a single 10k-char blob
  // with no sentence breaks) emitted oversized chunks that broke the
  // embedding-API-per-request token budget.
  const hardSplit = () => {
    while (buf.length > maxChars) {
      const sliceLen = maxChars;
      const trimmed = buf.slice(0, sliceLen).trim();
      out.push({
        index: chunkIdx++,
        text: trimmed,
        charStart: bufStart,
        charEnd: bufStart + sliceLen,
      });
      const overlap = buf.slice(sliceLen - overlapChars, sliceLen);
      buf = overlap + buf.slice(sliceLen);
      bufStart = bufStart + sliceLen - overlapChars;
    }
  };

  for (const seg of segments) {
    if (bufStart === -1) bufStart = seg.start;
    if (buf.length + seg.text.length > targetChars && buf.trim().length > 0) {
      softFlush(seg.start);
      if (bufStart === -1) bufStart = seg.start;
    }
    buf += (buf.endsWith('\n') || buf === '' ? '' : ' ') + seg.text;
    if (buf.length > maxChars) hardSplit();
  }
  softFlush(text.length);

  return out;
}

interface Segment {
  text: string;
  start: number;
  end: number;
}

// Walk paragraph by paragraph. If a paragraph is bigger than maxChars on
// its own (legal regs and IRBs do this), break by sentence; if a sentence
// is bigger still (rare but happens), hard-split at maxChars.
function collectSegments(text: string, maxChars: number): Segment[] {
  const out: Segment[] = [];
  const paragraphRe = /\n{2,}/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  const handleParagraph = (paraStart: number, paraEnd: number) => {
    const para = text.slice(paraStart, paraEnd);
    if (para.trim().length === 0) return;
    if (para.length <= maxChars) {
      out.push({ text: para, start: paraStart, end: paraEnd });
      return;
    }
    // Paragraph too big — split by sentence using the same string with
    // running offsets so the char positions stay correct.
    let sentStart = 0;
    const breaks = [...para.matchAll(SENTENCE_BREAK)].map((m) => (m.index ?? 0) + m[0].length);
    breaks.push(para.length);
    for (const sentEnd of breaks) {
      const sentence = para.slice(sentStart, sentEnd);
      if (sentence.length <= maxChars) {
        out.push({
          text: sentence,
          start: paraStart + sentStart,
          end: paraStart + sentEnd,
        });
      } else {
        // Hard-split monster sentences.
        for (let i = 0; i < sentence.length; i += maxChars) {
          out.push({
            text: sentence.slice(i, i + maxChars),
            start: paraStart + sentStart + i,
            end: paraStart + sentStart + Math.min(i + maxChars, sentence.length),
          });
        }
      }
      sentStart = sentEnd;
    }
  };

  while ((match = paragraphRe.exec(text)) !== null) {
    handleParagraph(cursor, match.index);
    cursor = match.index + match[0].length;
  }
  handleParagraph(cursor, text.length);

  return out;
}
