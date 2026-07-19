// TP-7 — 1040 PDF intake. POST /pdf parses and returns fields +
// warnings + tie-out — nothing persists. POST /confirm merges the
// staff-confirmed fields into the DRAFT plan's baseline profile,
// audited. Local parsing only, no AI (master-plan ground rule 3).
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { getDb } from '@vibe/db';
import { plans, table_sets } from '@vibe/db/schema';
import type { TableSetPayload } from '@vibe/shared';
import { audit } from '../../lib/audit.js';
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
  await getDb()
    .update(plans)
    .set({
      baseline_profile: parsed.data.baseline_profile as never,
      updated_at: new Date(),
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
