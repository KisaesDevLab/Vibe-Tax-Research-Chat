// Phase 32 — query-time retrieval over the firm reference library.
//
// embedQuery → cosine top-k against reference_chunks → format as
// <reference_excerpts>...</reference_excerpts> for injection into the
// system prompt. Returns [] when there are no indexed references, when
// the embeddings client is unconfigured, or when retrieval errors —
// callers should treat retrieval as best-effort and never fail the chat
// turn on its account.
import { sql } from 'drizzle-orm';
import { getDb } from '@vibe/db';
import { logger } from '../logger.js';
import { getEmbeddingsClient } from '../embeddings/index.js';

export interface RetrievedExcerpt {
  document_id: string;
  document_title: string;
  document_tags: string[];
  chunk_id: string;
  chunk_index: number;
  similarity: number;
  text: string;
  page_number: number | null;
}

export interface RetrieveOptions {
  /** Top-k chunks to fetch from the index. */
  k?: number;
  /** Minimum similarity (cosine) to include — anything below is dropped. */
  minSimilarity?: number;
  /** Filter to a specific subset of documents (by id). When unset, query the whole library. */
  documentIds?: string[];
}

const DEFAULTS: Required<Omit<RetrieveOptions, 'documentIds'>> = {
  k: 6,
  minSimilarity: 0.45,
};

/**
 * Retrieve top-k chunks similar to a query string. Best-effort: returns
 * an empty array on any failure, with the error logged. Caller can
 * detect "retrieval not configured" by passing skipIfUnconfigured=true.
 */
export async function retrieveReferenceExcerpts(
  query: string,
  opts: RetrieveOptions = {},
): Promise<RetrievedExcerpt[]> {
  if (!query || query.trim().length === 0) return [];
  const k = opts.k ?? DEFAULTS.k;
  const minSimilarity = opts.minSimilarity ?? DEFAULTS.minSimilarity;

  let queryVector: number[];
  try {
    const client = getEmbeddingsClient();
    const result = await client.embed([query], 'query');
    queryVector = result.vectors[0] ?? [];
  } catch (err) {
    logger.warn({ err }, 'reference retrieval skipped — embeddings client unavailable');
    return [];
  }
  if (queryVector.length === 0) return [];

  // pgvector accepts the literal `[a,b,c]` text form cast via ::vector.
  // Building the literal client-side avoids the postgres-js array-of-
  // floats conversion (which would emit `{a,b,c}`, the array literal,
  // not the vector literal).
  const vec = `[${queryVector.join(',')}]`;

  try {
    const db = getDb();
    const docFilter =
      opts.documentIds && opts.documentIds.length > 0
        ? sql`AND rc.document_id = ANY(${opts.documentIds}::uuid[])`
        : sql``;
    // 1 - cosine_distance = cosine similarity. <=> is the cosine operator
    // when the column was indexed with vector_cosine_ops (it was — see
    // the HNSW index in 0002_reference_pgvector.sql).
    const rows = (await db.execute(sql`
      SELECT
        rc.id              AS chunk_id,
        rc.document_id     AS document_id,
        rc.chunk_index     AS chunk_index,
        rc.text            AS text,
        rc.page_number     AS page_number,
        rd.title           AS document_title,
        rd.tags            AS document_tags,
        1 - (rc.embedding <=> ${vec}::vector) AS similarity
      FROM reference_chunks rc
      JOIN reference_documents rd ON rd.id = rc.document_id
      WHERE rc.embedding IS NOT NULL
        AND rd.status = 'indexed'
        ${docFilter}
      ORDER BY rc.embedding <=> ${vec}::vector
      LIMIT ${k}
    `)) as unknown as Array<{
      chunk_id: string;
      document_id: string;
      chunk_index: number;
      text: string;
      page_number: number | null;
      document_title: string;
      document_tags: string[] | null;
      similarity: number;
    }>;

    return rows
      .filter((r) => r.similarity >= minSimilarity)
      .map((r) => ({
        chunk_id: r.chunk_id,
        document_id: r.document_id,
        chunk_index: r.chunk_index,
        text: r.text,
        page_number: r.page_number,
        document_title: r.document_title,
        document_tags: r.document_tags ?? [],
        similarity: r.similarity,
      }));
  } catch (err) {
    logger.warn({ err }, 'reference retrieval query failed — proceeding without excerpts');
    return [];
  }
}

/**
 * Render retrieved excerpts as a `<reference_excerpts>` block suitable
 * for concatenating onto the existing system prompt. Returns an empty
 * string when there's nothing to inject so callers can do
 * `prompt + formatExcerptsForPrompt(...)` without conditional logic.
 *
 * Format mirrors the citation discipline already used elsewhere in the
 * system prompt: each excerpt is tagged with title and similarity score
 * so Claude can weight low-confidence matches accordingly. The
 * "Firm Reference" tag in the source attribution lets the assistant
 * distinguish firm-internal research from primary authority in the
 * authorities sidecar JSON.
 */
export function formatExcerptsForPrompt(excerpts: RetrievedExcerpt[]): string {
  if (excerpts.length === 0) return '';
  const lines = ['', '<reference_excerpts>'];
  lines.push(
    "The following excerpts come from your firm's private reference library. Cite them as " +
      '[Firm Reference: <title>, p.<page>] when you use them. They are firm-internal — not ' +
      'primary authority — so flag them as type="firm_reference" in the authorities sidecar.',
  );
  for (const ex of excerpts) {
    const page = ex.page_number != null ? `, p.${ex.page_number}` : '';
    const sim = ex.similarity.toFixed(2);
    lines.push('');
    lines.push(`<excerpt title="${escapeAttr(ex.document_title)}${page}" similarity="${sim}">`);
    lines.push(ex.text);
    lines.push('</excerpt>');
  }
  lines.push('</reference_excerpts>', '');
  return lines.join('\n');
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
