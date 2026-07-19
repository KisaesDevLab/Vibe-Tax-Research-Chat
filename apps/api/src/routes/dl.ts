// TP-9 — public signed-link download endpoint. NO auth: possession of a
// valid, unexpired, unrevoked HMAC token is the credential. Every
// download is audited; revocation wins over a valid signature.
import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { getDb } from '@vibe/db';
import { deliverables, deliverable_links } from '@vibe/db/schema';
import { audit } from '../lib/audit.js';
import { verifyLinkToken } from '../lib/signed-links.js';
import { deliverableStoragePath } from '../jobs/handlers/pdf-render.js';

export const dlRouter = Router();

dlRouter.get('/:token', async (req, res) => {
  let verified;
  try {
    verified = verifyLinkToken(req.params.token);
  } catch {
    res.status(503).json({ error: 'link_signing_unconfigured' });
    return;
  }
  if (!verified) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const db = getDb();
  const [link] = await db
    .select()
    .from(deliverable_links)
    .where(eq(deliverable_links.token_hash, verified.tokenHash))
    .limit(1);
  if (!link || link.revoked_at) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const [row] = await db
    .select()
    .from(deliverables)
    .where(eq(deliverables.id, verified.deliverableId))
    .limit(1);
  if (!row || row.status !== 'ready' || !row.storage_ref) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  await db
    .update(deliverable_links)
    .set({ last_downloaded_at: new Date() })
    .where(eq(deliverable_links.id, link.id));
  await audit({
    actor_user_id: null,
    action: 'deliverable.link.download',
    target_type: 'deliverable',
    target_id: row.id,
    metadata: { link_id: link.id, kind: row.kind, sha256: row.sha256 },
    ip: req.ip,
  });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${row.kind}.pdf"`);
  res.sendFile(deliverableStoragePath(row.storage_ref));
});
