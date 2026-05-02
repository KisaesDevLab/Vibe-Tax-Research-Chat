// Phase 32 — reference-document ingest pipeline.
//
// Driven from the references-ingest BullMQ worker. The worker calls
// ingestReferenceDocument(documentId), which is idempotent: on retry it
// scrubs prior chunks for the same document_id before re-inserting, so a
// transient embedding-API failure can be retried safely.
//
// Steps:
//   1. Load reference_documents row.
//   2. Mark status = 'processing'.
//   3. Read bytes from storage_path; parse to text via the existing Phase 23
//      parser (PDF/DOCX/TXT/MD/HTML/CSV/XLSX path).
//   4. SHA-256 the parsed text — used for cross-document dedup detection
//      in the admin UI.
//   5. Chunk to ~800-token windows with sentence-boundary awareness and
//      ~100-token overlap.
//   6. Embed each chunk batch via the configured embeddings provider
//      (Voyage by default; 1024 dim).
//   7. Wipe any prior chunks for this document, insert the new ones.
//   8. Mark status = 'indexed', stamp processed_at, store full_text.
//
// Errors anywhere in the pipeline mark status = 'failed' with
// error_message; the admin UI surfaces it for retry.
import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '@vibe/db';
import { reference_documents, reference_chunks } from '@vibe/db/schema';
import { logger } from '../logger.js';
import { parseAttachment } from '../parsers/index.js';
import { getEmbeddingsClient } from '../embeddings/index.js';
import { chunkText } from './chunker.js';
import { readReferenceBytes } from './storage.js';

// Voyage's per-request limit is 16K tokens for voyage-3-large. We chunk
// each call to ~32 chunks (32 * 800 = ~25K tokens estimated, but in
// practice chars/token varies so we leave headroom). If a customer
// configures a smaller-context model we'll need to make this dynamic.
const EMBED_BATCH_SIZE = 16;

export interface IngestResult {
  documentId: string;
  chunkCount: number;
  embeddingTokens: number;
}

export async function ingestReferenceDocument(documentId: string): Promise<IngestResult> {
  const db = getDb();
  const [doc] = await db
    .select()
    .from(reference_documents)
    .where(eq(reference_documents.id, documentId))
    .limit(1);
  if (!doc) throw new Error(`reference_documents row not found: ${documentId}`);

  await db
    .update(reference_documents)
    .set({ status: 'processing', error_message: null })
    .where(eq(reference_documents.id, documentId));

  try {
    if (!doc.storage_path) throw new Error('document has no storage_path');
    const bytes = await readReferenceBytes(doc.storage_path);

    const parsed = await parseAttachment({
      buffer: bytes,
      mime_type: doc.mime_type ?? 'application/octet-stream',
      filename: doc.original_filename ?? doc.title,
    });
    const fullText = parsed.full_text ?? '';
    if (fullText.trim().length === 0) {
      throw new Error('parsed text is empty — unsupported format or scan-only PDF');
    }
    const sha256 = crypto.createHash('sha256').update(fullText).digest('hex');
    const tokenCount = approximateTokens(fullText);

    const chunks = chunkText(fullText);
    if (chunks.length === 0) {
      throw new Error('chunker produced 0 chunks');
    }

    const client = getEmbeddingsClient();
    const allVectors: number[][] = new Array(chunks.length);
    let embeddingTokens = 0;
    for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
      const batch = chunks.slice(i, i + EMBED_BATCH_SIZE);
      const result = await client.embed(
        batch.map((c) => c.text),
        'document',
      );
      if (result.vectors.length !== batch.length) {
        throw new Error(
          `embedding batch size mismatch: expected ${batch.length}, got ${result.vectors.length}`,
        );
      }
      result.vectors.forEach((v, j) => {
        allVectors[i + j] = v;
      });
      embeddingTokens += result.inputTokens;
    }

    // Idempotent re-insert. A retry of the same job replaces prior chunks
    // for this document_id rather than appending.
    await db.transaction(async (tx) => {
      await tx.delete(reference_chunks).where(eq(reference_chunks.document_id, documentId));
      const rows = chunks.map((c, idx) => ({
        document_id: documentId,
        chunk_index: c.index,
        text: c.text,
        embedding: allVectors[idx]!,
        embedding_model: client.model,
        char_start: c.charStart,
        char_end: c.charEnd,
        token_count: approximateTokens(c.text),
      }));
      // Bulk insert chunks. pg-driver chunks the SQL automatically; for
      // very large documents (>1000 chunks) we may want to break into
      // sub-batches but the firm reference library's typical 5–50 page
      // memos stay well under that.
      if (rows.length > 0) {
        await tx.insert(reference_chunks).values(rows);
      }
      await tx
        .update(reference_documents)
        .set({
          full_text: fullText,
          sha256,
          token_count: tokenCount,
          status: 'indexed',
          processed_at: new Date(),
          error_message: null,
        })
        .where(eq(reference_documents.id, documentId));
    });

    logger.info(
      {
        document_id: documentId,
        chunks: chunks.length,
        embedding_tokens: embeddingTokens,
        model: client.model,
      },
      'reference ingest complete',
    );
    return {
      documentId,
      chunkCount: chunks.length,
      embeddingTokens,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await db
      .update(reference_documents)
      .set({ status: 'failed', error_message: msg.slice(0, 1000) })
      .where(eq(reference_documents.id, documentId));
    logger.error({ err, document_id: documentId }, 'reference ingest failed');
    throw err;
  }
}

// ~4 chars/token approximation for English prose. Used for budgeting and
// admin reporting only — not for billing. The actual billable count comes
// from the embeddings provider's response.
function approximateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
