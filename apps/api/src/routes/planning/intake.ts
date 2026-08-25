// TP-7 — 1040 PDF intake. POST /pdf parses and returns fields +
// warnings + tie-out — nothing persists. POST /confirm merges the
// staff-confirmed fields into the DRAFT plan's baseline profile,
// audited. Local parsing only, no AI (master-plan ground rule 3).
import crypto from 'node:crypto';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { getDb } from '@vibe/db';
import { client_documents, plans, table_sets } from '@vibe/db/schema';
import type { TableSetPayload } from '@vibe/shared';
import { clientDocumentsIngestQueue } from '../../jobs/queues.js';
import {
  deleteClientDocumentFiles,
  sanitizeFilename,
  writeClientDocumentBytes,
} from '../../lib/client-documents/storage.js';
import { audit } from '../../lib/audit.js';
import { baselineProfileSchema } from '../../lib/planning/validate.js';
import { logger } from '../../lib/logger.js';
import { extractPdfTokens } from '../../lib/intake/pdf-extract.js';
import { selectAnchors, matchAnchors } from '../../lib/intake/anchors.js';
import { mapReturn } from '../../lib/intake/map-1040.js';
import { getOcrProvider, OcrNotConfiguredError } from '../../lib/intake/ocr.js';
import { FROZEN_STATUSES } from './plans.js';

export const intakeRouter = Router({ mergeParams: true });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

const uuidSchema = z.string().uuid();

async function loadDraftPlan(planId: string) {
  const [plan] = await getDb().select().from(plans).where(eq(plans.id, planId)).limit(1);
  return plan ?? null;
}

intakeRouter.post('/pdf', upload.single('file'), async (req, res) => {
  const planId = (req.params as { id?: string }).id ?? '';
  if (!uuidSchema.safeParse(planId).success) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  const plan = await loadDraftPlan(planId);
  if (!plan) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  if (!req.file || req.file.mimetype !== 'application/pdf') {
    res.status(400).json({ error: 'pdf_required' });
    return;
  }
  let tokens;
  try {
    tokens = await extractPdfTokens(req.file.buffer);
  } catch (err) {
    logger.warn({ err }, 'intake pdf extraction failed');
    res.status(422).json({ error: 'pdf_unreadable' });
    return;
  }
  if (tokens.length < 20) {
    // No usable text layer — the OCR seam.
    const ocr = getOcrProvider();
    if (!ocr) {
      const e = new OcrNotConfiguredError();
      res.status(422).json({ error: e.code, message: e.message });
      return;
    }
    tokens = await ocr.extractTokens(req.file.buffer);
  }
  const [ts] = await getDb()
    .select()
    .from(table_sets)
    .where(eq(table_sets.id, plan.table_set_id))
    .limit(1);
  const { anchors, vendor } = selectAnchors(tokens);
  const hits = matchAnchors(tokens, anchors);
  const result = mapReturn(hits, vendor, ts!.payload as TableSetPayload);
  res.json({ intake: result });
});

// TP-6a — the canonical intake upload: creates a client_documents row for
// the plan's client (full ingest — shield, classify, fact extraction,
// chunks — runs async via the queue) AND runs the TP-7 anchor path inline
// so the Numbers tie-out renders immediately. The anchor result persists on
// the row (profile_candidates) for audit/re-display. A same-bytes re-upload
// returns the existing document with its stored parse instead of duplicating.
intakeRouter.post('/document', upload.single('file'), async (req, res) => {
  const planId = (req.params as { id?: string }).id ?? '';
  if (!uuidSchema.safeParse(planId).success) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  const plan = await loadDraftPlan(planId);
  if (!plan) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  if (FROZEN_STATUSES.includes(plan.status)) {
    res.status(409).json({ error: 'plan_frozen' });
    return;
  }
  if (!req.file || req.file.mimetype !== 'application/pdf') {
    res.status(400).json({ error: 'pdf_required' });
    return;
  }
  const db = getDb();
  const sha256 = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
  const [existing] = await db
    .select()
    .from(client_documents)
    .where(and(eq(client_documents.client_id, plan.client_id), eq(client_documents.sha256, sha256)))
    .limit(1);
  if (existing) {
    res.status(409).json({
      error: 'duplicate_document',
      existing_document_id: existing.id,
      intake: existing.profile_candidates ?? null,
    });
    return;
  }

  // Inline anchor parse (unchanged TP-7 mechanics) — fails BEFORE any row
  // or file is created so a scanned PDF leaves no artifacts.
  let tokens;
  try {
    tokens = await extractPdfTokens(req.file.buffer);
  } catch (err) {
    logger.warn({ err }, 'intake pdf extraction failed');
    res.status(422).json({ error: 'pdf_unreadable' });
    return;
  }
  if (tokens.length < 20) {
    const ocr = getOcrProvider();
    if (!ocr) {
      const e = new OcrNotConfiguredError();
      res.status(422).json({ error: e.code, message: e.message });
      return;
    }
    tokens = await ocr.extractTokens(req.file.buffer);
  }
  const [ts] = await db
    .select()
    .from(table_sets)
    .where(eq(table_sets.id, plan.table_set_id))
    .limit(1);
  const { anchors, vendor } = selectAnchors(tokens);
  const hits = matchAnchors(tokens, anchors);
  const intake = mapReturn(hits, vendor, ts!.payload as TableSetPayload);

  const documentId = crypto.randomUUID();
  const filename = sanitizeFilename(req.file.originalname || 'document.pdf');
  const storageRef = await writeClientDocumentBytes(documentId, filename, req.file.buffer);
  let row;
  try {
    [row] = await db
      .insert(client_documents)
      .values({
        id: documentId,
        client_id: plan.client_id,
        sha256,
        filename,
        storage_ref: storageRef,
        profile_candidates: intake as unknown as Record<string, unknown>,
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
    metadata: { client_id: plan.client_id, plan_id: plan.id, filename, sha256 },
    ip: req.ip,
  });
  const { fact_candidates: _fc, ...docRest } = row!;
  res.status(201).json({
    document: { ...docRest, pending_candidate_count: 0 },
    intake,
  });
});

// Staff-confirmed merge. The client sends exactly the profile they
// reviewed on the tie-out screen; the server only guards status.
const confirmSchema = z.object({
  baseline_profile: z.record(z.unknown()),
  tie_out_note: z.string().max(2000).optional(),
});

intakeRouter.post('/confirm', async (req, res) => {
  const planId = (req.params as { id?: string }).id ?? '';
  if (!uuidSchema.safeParse(planId).success) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  const parsed = confirmSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'bad_request', detail: parsed.error.flatten() });
    return;
  }
  const plan = await loadDraftPlan(planId);
  if (!plan) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  if (FROZEN_STATUSES.includes(plan.status)) {
    res.status(409).json({ error: 'plan_frozen' });
    return;
  }
  const profileCheck = baselineProfileSchema.safeParse(parsed.data.baseline_profile);
  if (!profileCheck.success) {
    res.status(400).json({ error: 'invalid_profile', detail: profileCheck.error.flatten() });
    return;
  }
  await getDb()
    .update(plans)
    .set({
      baseline_profile: parsed.data.baseline_profile as never,
      updated_at: new Date(),
      // Confirming new intake invalidates review sign-off.
      ...(plan.status === 'in-review' ? { review_state: {} } : {}),
    })
    .where(eq(plans.id, plan.id));
  await audit({
    actor_user_id: req.auth!.user_id,
    action: 'plan.intake.confirm',
    target_type: 'plan',
    target_id: plan.id,
    metadata: { client_id: plan.client_id, note: parsed.data.tie_out_note ?? null },
    ip: req.ip,
  });
  res.json({ ok: true });
});
