// Phase 32 — firm reference library admin API.
//
// Endpoints (all gated to role=admin):
//   POST   /                    — upload a document (multipart). Persists bytes,
//                                  inserts a row in `queued`, enqueues references-ingest.
//   GET    /                    — list with optional ?status= and ?tag= filters.
//   GET    /:id                 — single document with chunk count.
//   PATCH  /:id                 — update title/tags.
//   DELETE /:id                 — delete row (cascades chunks) + bytes.
//   POST   /:id/reingest        — re-enqueue ingest (e.g., after a transient
//                                  embedding-API failure).
//   POST   /test-retrieval      — debug: run a query through retrieveReferenceExcerpts
//                                  and return the top-k with similarity scores. Lets
//                                  the admin verify the pipeline end-to-end without
//                                  going through a real chat turn.
import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import multer from 'multer';
import { eq, desc, count, and, sql } from 'drizzle-orm';
import { getDb } from '@vibe/db';
import { reference_documents, reference_chunks } from '@vibe/db/schema';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { audit } from '../../lib/audit.js';
import { logger } from '../../lib/logger.js';
import { referencesIngestQueue } from '../../jobs/queues.js';
import { writeReferenceBytes, deleteReferenceFiles } from '../../lib/references/storage.js';
import { retrieveReferenceExcerpts } from '../../lib/references/retrieve.js';

export const adminReferencesRouter = Router();
adminReferencesRouter.use(requireAuth, requireRole('admin'));

const upload = multer({
  storage: multer.memoryStorage(),
  // Reference docs are firm research memos / regs / treatises — bigger
  // than chat attachments (50MB). 100MB matches the Phase 23 attachments
  // ceiling on a generous interpretation.
  limits: { fileSize: 100 * 1024 * 1024 },
});

const uuidSchema = z.string().uuid();
const tagsSchema = z.array(z.string().min(1).max(64)).max(32).default([]);

const createMetaSchema = z.object({
  title: z.string().min(1).max(300).optional(),
  tags: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((v) => {
      if (v === undefined) return [] as string[];
      if (Array.isArray(v)) return v;
      // multipart form: tags arrives as a single comma-separated string.
      return v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    })
    .pipe(tagsSchema),
});

const patchSchema = z.object({
  title: z.string().min(1).max(300).optional(),
  tags: tagsSchema.optional(),
});

const listQuerySchema = z.object({
  status: z.enum(['queued', 'processing', 'indexed', 'failed']).optional(),
  tag: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const testQuerySchema = z.object({
  query: z.string().min(1).max(2000),
  k: z.number().int().min(1).max(20).default(8),
  document_ids: z.array(z.string().uuid()).optional(),
});

// ── List ─────────────────────────────────────────────────────────────
adminReferencesRouter.get('/', async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  const { status, tag, limit, offset } = parsed.data;
  const db = getDb();
  const filters = [];
  if (status) filters.push(eq(reference_documents.status, status));
  if (tag) filters.push(sql`${reference_documents.tags} @> ARRAY[${tag}]::text[]`);
  const where = filters.length > 0 ? and(...filters) : undefined;

  const rows = await db
    .select({
      id: reference_documents.id,
      title: reference_documents.title,
      source: reference_documents.source,
      original_filename: reference_documents.original_filename,
      mime_type: reference_documents.mime_type,
      size_bytes: reference_documents.size_bytes,
      tags: reference_documents.tags,
      status: reference_documents.status,
      error_message: reference_documents.error_message,
      token_count: reference_documents.token_count,
      sha256: reference_documents.sha256,
      created_at: reference_documents.created_at,
      processed_at: reference_documents.processed_at,
    })
    .from(reference_documents)
    .where(where)
    .orderBy(desc(reference_documents.created_at))
    .limit(limit)
    .offset(offset);

  res.json({ references: rows });
});

// ── Single ───────────────────────────────────────────────────────────
adminReferencesRouter.get('/:id', async (req, res) => {
  if (!uuidSchema.safeParse(req.params.id).success) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  const db = getDb();
  const [doc] = await db
    .select()
    .from(reference_documents)
    .where(eq(reference_documents.id, req.params.id))
    .limit(1);
  if (!doc) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const chunkRows = await db
    .select({ value: count() })
    .from(reference_chunks)
    .where(eq(reference_chunks.document_id, doc.id));
  const chunkCount = Number(chunkRows[0]?.value ?? 0);
  // full_text omitted from the response — it can be megabytes for long
  // memos and the admin UI doesn't render it inline.
  const { full_text: _full, ...rest } = doc;
  void _full;
  res.json({ reference: { ...rest, chunk_count: chunkCount } });
});

// ── Upload ───────────────────────────────────────────────────────────
adminReferencesRouter.post('/', upload.single('file'), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'no_file' });
    return;
  }
  const meta = createMetaSchema.safeParse(req.body);
  if (!meta.success) {
    res.status(400).json({ error: 'bad_request', detail: meta.error.flatten() });
    return;
  }
  const title = meta.data.title?.trim() || req.file.originalname;
  const db = getDb();

  // Generate the document id up front so the bytes-before-row order has a
  // stable directory name. If the row insert fails downstream we clean
  // the bytes back up — no orphans either way.
  const documentId = crypto.randomUUID();
  let storagePath: string;
  try {
    storagePath = await writeReferenceBytes(documentId, req.file.originalname, req.file.buffer);
  } catch (err) {
    logger.error({ err, document_id: documentId }, 'reference upload write failed');
    res.status(500).json({ error: 'storage_write_failed' });
    return;
  }

  let inserted: { id: string }[];
  try {
    inserted = await db
      .insert(reference_documents)
      .values({
        id: documentId,
        title,
        source: 'upload',
        original_filename: req.file.originalname,
        mime_type: req.file.mimetype,
        size_bytes: req.file.size,
        storage_path: storagePath,
        tags: meta.data.tags,
        status: 'queued',
        created_by: req.auth!.user_id,
      })
      .returning({ id: reference_documents.id });
  } catch (err) {
    // Row insert failed (e.g., DB transient error). Clean the bytes we
    // wrote a moment ago so we don't leak disk on retry.
    await deleteReferenceFiles(documentId).catch(() => undefined);
    throw err;
  }
  void inserted;

  // BullMQ silently returns the prior job for any duplicate jobId
  // (including completed ones), which would block legitimate re-ingest.
  // The ingest worker is idempotent on document_id (delete chunks →
  // re-insert), so double-enqueue is safe; we just pay extra embedding
  // tokens on a true double-click. Acceptable v1 trade-off.
  await referencesIngestQueue.add('ingest', { document_id: documentId });
  await audit({
    actor_user_id: req.auth!.user_id,
    action: 'references.upload',
    metadata: { document_id: documentId, title, size_bytes: req.file.size },
    ip: req.ip,
  });
  logger.info({ document_id: documentId, title }, 'reference uploaded — ingest queued');

  res.status(201).json({ id: documentId, status: 'queued' });
});

// ── Patch (title / tags) ─────────────────────────────────────────────
adminReferencesRouter.patch('/:id', async (req, res) => {
  if (!uuidSchema.safeParse(req.params.id).success) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'bad_request', detail: parsed.error.flatten() });
    return;
  }
  const update: Record<string, unknown> = {};
  if (parsed.data.title !== undefined) update.title = parsed.data.title;
  if (parsed.data.tags !== undefined) update.tags = parsed.data.tags;
  if (Object.keys(update).length === 0) {
    res.status(400).json({ error: 'no_fields' });
    return;
  }
  const updated = await getDb()
    .update(reference_documents)
    .set(update)
    .where(eq(reference_documents.id, req.params.id))
    .returning({ id: reference_documents.id });
  if (updated.length === 0) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  await audit({
    actor_user_id: req.auth!.user_id,
    action: 'references.patch',
    metadata: { document_id: req.params.id, fields: Object.keys(update) },
    ip: req.ip,
  });
  res.status(204).end();
});

// ── Delete ───────────────────────────────────────────────────────────
adminReferencesRouter.delete('/:id', async (req, res) => {
  if (!uuidSchema.safeParse(req.params.id).success) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  const db = getDb();
  // Tear chunks down via cascade; clean bytes off disk regardless of DB
  // state (a partial-row case from a failed ingest still has files).
  const deleted = await db
    .delete(reference_documents)
    .where(eq(reference_documents.id, req.params.id))
    .returning({ id: reference_documents.id });
  await deleteReferenceFiles(req.params.id);
  if (deleted.length === 0) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  await audit({
    actor_user_id: req.auth!.user_id,
    action: 'references.delete',
    metadata: { document_id: req.params.id },
    ip: req.ip,
  });
  res.status(204).end();
});

// ── Reingest ─────────────────────────────────────────────────────────
adminReferencesRouter.post('/:id/reingest', async (req, res) => {
  if (!uuidSchema.safeParse(req.params.id).success) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  const db = getDb();
  const [doc] = await db
    .select({ id: reference_documents.id, storage_path: reference_documents.storage_path })
    .from(reference_documents)
    .where(eq(reference_documents.id, req.params.id))
    .limit(1);
  if (!doc) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  if (!doc.storage_path) {
    res.status(409).json({ error: 'no_storage', detail: 'document has no bytes on disk' });
    return;
  }
  await db
    .update(reference_documents)
    .set({ status: 'queued', error_message: null })
    .where(eq(reference_documents.id, doc.id));
  await referencesIngestQueue.add('ingest', { document_id: doc.id });
  await audit({
    actor_user_id: req.auth!.user_id,
    action: 'references.reingest',
    metadata: { document_id: doc.id },
    ip: req.ip,
  });
  res.status(202).json({ id: doc.id, status: 'queued' });
});

// ── Test retrieval ───────────────────────────────────────────────────
adminReferencesRouter.post('/test-retrieval', async (req, res) => {
  const parsed = testQuerySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'bad_request', detail: parsed.error.flatten() });
    return;
  }
  const excerpts = await retrieveReferenceExcerpts(parsed.data.query, {
    k: parsed.data.k,
    documentIds: parsed.data.document_ids,
    // For the test tool, return raw scores even when low — the admin
    // wants to see the full ranking, including near-misses.
    minSimilarity: 0,
  });
  res.json({ excerpts });
});
