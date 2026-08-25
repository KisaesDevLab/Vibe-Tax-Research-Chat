// TP-8a — query-time retrieval over a CLIENT's source-document chunks
// (document_chunks ⋈ client_documents), cloned from the firm-reference
// retriever. Chunks are page-bounded post-Shield text, so every excerpt
// carries a real {documentId, page} — the mandatory citation unit for
// plan-scoped chat. Same Voyage embeddings client as ingest (one stack —
// a model mismatch here would return garbage similarities silently).
// Best-effort: [] on any failure, never fails the chat turn.
import { sql } from 'drizzle-orm';
import { getDb } from '@vibe/db';
import { logger } from '../logger.js';
import { getEmbeddingsClient } from '../embeddings/index.js';

export interface DocExcerpt {
  document_id: string;
  filename: string;
  doc_type: string;
  page: number;
  chunk_index: number;
  similarity: number;
  text: string;
}

export interface DocRetrieveOptions {
  clientId: string;
  k?: number;
  minSimilarity?: number;
}

const DEFAULTS = { k: 6, minSimilarity: 0.45 };

export async function retrieveClientDocExcerpts(
  query: string,
  opts: DocRetrieveOptions,
): Promise<DocExcerpt[]> {
  if (!query || query.trim().length === 0) return [];
  const k = opts.k ?? DEFAULTS.k;
  const minSimilarity = opts.minSimilarity ?? DEFAULTS.minSimilarity;

  let queryVector: number[];
  try {
    const client = getEmbeddingsClient();
    const result = await client.embed([query], 'query');
    queryVector = result.vectors[0] ?? [];
  } catch (err) {
    logger.warn({ err }, 'client-doc retrieval skipped — embeddings client unavailable');
    return [];
  }
  if (queryVector.length === 0) return [];
  const vec = `[${queryVector.join(',')}]`;

  try {
    const db = getDb();
    const rows = (await db.execute(sql`
      SELECT
        dc.document_id   AS document_id,
        dc.page          AS page,
        dc.chunk_index   AS chunk_index,
        dc.text          AS text,
        cd.filename      AS filename,
        cd.doc_type      AS doc_type,
        1 - (dc.embedding <=> ${vec}::vector) AS similarity
      FROM document_chunks dc
      JOIN client_documents cd ON cd.id = dc.document_id
      WHERE dc.embedding IS NOT NULL
        AND cd.status = 'indexed'
        AND cd.client_id = ${opts.clientId}::uuid
      ORDER BY dc.embedding <=> ${vec}::vector
      LIMIT ${k}
    `)) as unknown as Array<{
      document_id: string;
      page: number;
      chunk_index: number;
      text: string;
      filename: string;
      doc_type: string;
      similarity: number;
    }>;
    return rows
      .filter((r) => r.similarity >= minSimilarity)
      .map((r) => ({
        document_id: r.document_id,
        filename: r.filename,
        doc_type: r.doc_type,
        page: r.page,
        chunk_index: r.chunk_index,
        text: r.text,
        similarity: r.similarity,
      }));
  } catch (err) {
    logger.warn({ err }, 'client-doc retrieval query failed — proceeding without excerpts');
    return [];
  }
}

/**
 * `<client_document_excerpts>` block for the system prompt. Every excerpt
 * carries document_id + page attributes; the instruction binds citations
 * to [Doc: <filename>, p.<N>] inline AND the doc_citations sidecar.
 */
export function formatDocExcerptsForPrompt(excerpts: DocExcerpt[]): string {
  if (excerpts.length === 0) return '';
  const lines = ['', '<client_document_excerpts>'];
  lines.push(
    "The following excerpts come from THIS CLIENT's uploaded source documents (tax returns " +
      'etc.; PII redacted). When a claim rests on one of them, cite it inline as ' +
      '[Doc: <filename>, p.<N>] and record it in the doc_citations sidecar with the ' +
      'document_id and page from the excerpt tag.',
  );
  for (const ex of excerpts) {
    lines.push('');
    lines.push(
      `<excerpt document_id="${ex.document_id}" filename="${escapeAttr(ex.filename)}" doc_type="${ex.doc_type}" page="${ex.page}" similarity="${ex.similarity.toFixed(2)}">`,
    );
    lines.push(ex.text);
    lines.push('</excerpt>');
  }
  lines.push('</client_document_excerpts>', '');
  return lines.join('\n');
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
