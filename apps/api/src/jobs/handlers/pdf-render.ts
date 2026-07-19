// TP-9 — pdf-render job: assemble render data, build the PDF via PDFKit
// (the same server-side rendering as chat exports — no Chromium),
// content-address the artifact, register it on the deliverable row.
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { getDb } from '@vibe/db';
import { deliverables } from '@vibe/db/schema';
import { logger } from '../../lib/logger.js';
import { audit } from '../../lib/audit.js';
import { buildRenderData } from '../../lib/render/data.js';
import { buildDeliverablePdf } from '../../lib/render/deliverable-pdf.js';
import type { DeliverableKind } from '../../lib/render/types.js';

const STORAGE_ROOT = path.resolve(process.env.DELIVERABLES_DIR ?? './storage/deliverables');

export async function renderDeliverable(deliverableId: string): Promise<void> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(deliverables)
    .where(eq(deliverables.id, deliverableId))
    .limit(1);
  if (!row) {
    logger.warn({ deliverableId }, 'pdf-render: deliverable vanished');
    return;
  }
  await db
    .update(deliverables)
    .set({ status: 'rendering', error: null })
    .where(eq(deliverables.id, row.id));
  try {
    const data = await buildRenderData(row.plan_id, row.reveal_strategies);
    const pdf = await buildDeliverablePdf(row.kind as DeliverableKind, data);
    const sha256 = createHash('sha256').update(pdf).digest('hex');
    mkdirSync(STORAGE_ROOT, { recursive: true });
    const storageRef = `${sha256}.pdf`;
    await writeFile(path.join(STORAGE_ROOT, storageRef), pdf);
    await db
      .update(deliverables)
      .set({ status: 'ready', sha256, storage_ref: storageRef, rendered_at: new Date() })
      .where(eq(deliverables.id, row.id));
    await audit({
      actor_user_id: row.created_by,
      action: 'deliverable.rendered',
      target_type: 'deliverable',
      target_id: row.id,
      metadata: { plan_id: row.plan_id, kind: row.kind, sha256 },
    });
    logger.info({ deliverableId: row.id, kind: row.kind, sha256 }, 'deliverable rendered');
  } catch (err) {
    await db
      .update(deliverables)
      .set({ status: 'failed', error: (err as Error).message })
      .where(eq(deliverables.id, row.id));
    throw err;
  }
}

export function deliverableStoragePath(storageRef: string): string {
  return path.join(STORAGE_ROOT, storageRef);
}
