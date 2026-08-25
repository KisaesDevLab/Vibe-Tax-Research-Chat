// TP-3a — client source-document API. Mounted at /api/clients/:id/documents
// (mergeParams) behind requireAuth + requirePlanning in app.ts.
//
// Upload is PDF-only in v1 (the parsers seam exists for later). Bytes are
// written under dataDirs().attachments/client-documents (backup-covered),
// then the row is inserted and ingest enqueued — write-then-insert with a
// compensating file delete on insert failure (references precedent).
import crypto from 'node:crypto';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { getDb } from '@vibe/db';
import { client_documents } from '@vibe/db/schema';
import { audit } from '../../lib/audit.js';
import { logger } from '../../lib/logger.js';
import { clientDocumentsIngestQueue } from '../../jobs/queues.js';
import {
  deleteClientDocumentFiles,
  readClientDocumentBytes,
  sanitizeFilename,
  writeClientDocumentBytes,
} from '../../lib/client-documents/storage.js';
import { findAttachableClient } from './index.js';

export const clientDocumentsRouter = Router({ mergeParams: true });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
});

const uuidSchema = z.string().uuid();

const DOC_TYPES = [
  'f1040',
  'f1120s',
  'f1120',
  'f1065',
  'k1',
  'f990',
  'state_return',
  'engagement_letter',
  'correspondence',
  'other',
] as const;

function clientId(req: { params: Record<string, string | undefined> }): string {
  return req.params.id ?? '';
}

function toDto(doc: typeof client_documents.$inferSelect) {
  const { fact_candidates, profile_candidates, ...rest } = doc;
  return {
    ...rest,
    pending_candidate_count: (fact_candidates ?? []).filter((c) => c.status === 'pending').length,
  };
}

const listQuerySchema = z.object({
  doc_type: z.enum(DOC_TYPES).optional(),
  status: z.enum(['queued', 'processing', 'indexed', 'failed']).optional(),
});

clientDocumentsRouter.get('/', async (req, res) => {
  const id = clientId(req);
  if (!uuidSchema.safeParse(id).success) {
    res.status(400).json({ error: 'bad_request', detail: 'invalid id' });
    return;
  }
  const query = listQuerySchema.safeParse(req.query ?? {});
  if (!query.success) {
    res.status(400).json({ error: 'bad_request', detail: query.error.flatten() });
    return;
  }
  const client = await findAttachableClient(id);
  if (!client) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const conditions = [eq(client_documents.client_id, id)];
  if (query.data.doc_type) conditions.push(eq(client_documents.doc_type, query.data.doc_type));
  if (query.data.status) conditions.push(eq(client_documents.status, query.data.status));
  const rows = await getDb()
    .select()
    .from(client_documents)
    .where(and(...conditions))
    .orderBy(desc(client_documents.uploaded_at));
  res.json({ documents: rows.map(toDto) });
});

const uploadFieldsSchema = z.object({
  doc_type: z.enum(DOC_TYPES).optional(),
  tax_year: z.coerce.number().int().min(1990).max(2100).optional(),
});

clientDocumentsRouter.post('/', upload.single('file'), async (req, res) => {
  const id = clientId(req);
  if (!uuidSchema.safeParse(id).success) {
    res.status(400).json({ error: 'bad_request', detail: 'invalid id' });
    return;
  }
  const client = await findAttachableClient(id);
  if (!client) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  if (!req.file || req.file.mimetype !== 'application/pdf') {
    res.status(400).json({ error: 'pdf_required' });
    return;
  }
  const fields = uploadFieldsSchema.safeParse(req.body ?? {});
  if (!fields.success) {
    res.status(400).json({ error: 'bad_request', detail: fields.error.flatten() });
    return;
  }

  const db = getDb();
  const sha256 = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
  const [existing] = await db
    .select({ id: client_documents.id })
    .from(client_documents)
    .where(and(eq(client_documents.client_id, id), eq(client_documents.sha256, sha256)))
    .limit(1);
  if (existing) {
    res.status(409).json({ error: 'duplicate_document', existing_document_id: existing.id });
    return;
  }

  const documentId = crypto.randomUUID();
  const filename = sanitizeFilename(req.file.originalname || 'document.pdf');
  const storageRef = await writeClientDocumentBytes(documentId, filename, req.file.buffer);
  let row;
  try {
    [row] = await db
      .insert(client_documents)
      .values({
        id: documentId,
        client_id: id,
        sha256,
        filename,
        doc_type: fields.data.doc_type ?? 'other',
        doc_type_method: fields.data.doc_type ? 'manual' : null,
        tax_year: fields.data.tax_year ?? null,
        storage_ref: storageRef,
        uploaded_by: req.auth!.user_id,
      })
      .returning();
  } catch (err) {
    await deleteClientDocumentFiles(documentId).catch(() => undefined);
    throw err;
  }

  await clientDocumentsIngestQueue.add('ingest', {
    document_id: documentId,
    actor_user_id: req.auth!.user_id,
  });
  await audit({
    actor_user_id: req.auth!.user_id,
    action: 'client.document.upload',
    target_type: 'client_document',
    target_id: documentId,
    metadata: { client_id: id, filename, size_bytes: req.file.size, sha256 },
    ip: req.ip,
  });
  res.status(201).json({ document: toDto(row!) });
});

async function loadDocument(clientIdValue: string, docId: string) {
  const [doc] = await getDb()
    .select()
    .from(client_documents)
    .where(and(eq(client_documents.id, docId), eq(client_documents.client_id, clientIdValue)))
    .limit(1);
  return doc ?? null;
}

clientDocumentsRouter.get('/:docId', async (req, res) => {
  const id = clientId(req);
  const docId = req.params.docId ?? '';
  if (!uuidSchema.safeParse(id).success || !uuidSchema.safeParse(docId).success) {
    res.status(400).json({ error: 'bad_request', detail: 'invalid id' });
    return;
  }
  const doc = await loadDocument(id, docId);
  if (!doc) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.json({ document: doc });
});

// Streams the stored PDF for provenance click-through ("open the source at
// page N" — the viewer appends #page=N).
clientDocumentsRouter.get('/:docId/file', async (req, res) => {
  const id = clientId(req);
  const docId = req.params.docId ?? '';
  if (!uuidSchema.safeParse(id).success || !uuidSchema.safeParse(docId).success) {
    res.status(400).json({ error: 'bad_request', detail: 'invalid id' });
    return;
  }
  const doc = await loadDocument(id, docId);
  if (!doc || !doc.storage_ref) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  let bytes: Buffer;
  try {
    bytes = await readClientDocumentBytes(doc.storage_ref);
  } catch {
    res.status(410).json({ error: 'file_missing' });
    return;
  }
  res.setHeader('content-type', 'application/pdf');
  res.setHeader('content-disposition', `inline; filename="${doc.filename}"`);
  res.send(bytes);
});

clientDocumentsRouter.post('/:docId/reingest', async (req, res) => {
  const id = clientId(req);
  const docId = req.params.docId ?? '';
  if (!uuidSchema.safeParse(id).success || !uuidSchema.safeParse(docId).success) {
    res.status(400).json({ error: 'bad_request', detail: 'invalid id' });
    return;
  }
  const doc = await loadDocument(id, docId);
  if (!doc) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  await getDb()
    .update(client_documents)
    .set({ status: 'queued', error_message: null })
    .where(eq(client_documents.id, docId));
  await clientDocumentsIngestQueue.add('ingest', {
    document_id: docId,
    actor_user_id: req.auth!.user_id,
  });
  await audit({
    actor_user_id: req.auth!.user_id,
    action: 'client.document.reingest',
    target_type: 'client_document',
    target_id: docId,
    metadata: { client_id: id },
    ip: req.ip,
  });
  res.status(202).json({ ok: true });
});

clientDocumentsRouter.delete('/:docId', async (req, res) => {
  const id = clientId(req);
  const docId = req.params.docId ?? '';
  if (!uuidSchema.safeParse(id).success || !uuidSchema.safeParse(docId).success) {
    res.status(400).json({ error: 'bad_request', detail: 'invalid id' });
    return;
  }
  const doc = await loadDocument(id, docId);
  if (!doc) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  // Chunks cascade via FK. Fact sources referencing this document keep
  // their {documentId, page} — the UI renders "document removed" for a
  // dangling reference (applied default).
  await getDb().delete(client_documents).where(eq(client_documents.id, docId));
  try {
    await deleteClientDocumentFiles(docId);
  } catch (err) {
    logger.warn({ err, document_id: docId }, 'client document file cleanup failed');
  }
  await audit({
    actor_user_id: req.auth!.user_id,
    action: 'client.document.delete',
    target_type: 'client_document',
    target_id: docId,
    metadata: { client_id: id, filename: doc.filename },
    ip: req.ip,
  });
  res.status(204).end();
});
