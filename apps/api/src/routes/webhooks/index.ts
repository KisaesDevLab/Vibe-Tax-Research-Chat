// Phase 8 — webhook receivers.
import { Router } from 'express';
import crypto from 'node:crypto';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { audit } from '../../lib/audit.js';
import { skillsSyncQueue } from '../../jobs/queues.js';

export const webhooksRouter = Router();

// GitHub push webhook for skills repo. HMAC-verified via X-Hub-Signature-256.
webhooksRouter.post('/github', async (req, res) => {
  const secret = env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    res.status(503).json({ error: 'webhook_secret_not_configured' });
    return;
  }
  const sig = req.header('X-Hub-Signature-256');
  if (!sig) {
    res.status(401).json({ error: 'no_signature' });
    return;
  }
  const expected = `sha256=${crypto
    .createHmac('sha256', secret)
    .update(JSON.stringify(req.body))
    .digest('hex')}`;
  const match =
    sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  if (!match) {
    res.status(401).json({ error: 'bad_signature' });
    return;
  }
  const event = req.header('X-GitHub-Event');
  if (event !== 'push') {
    res.status(204).end();
    return;
  }
  // Schedule a dry-run.
  await skillsSyncQueue.add('webhook-dry-run', { triggered_by: 'webhook' });
  await audit({ action: 'webhook.github.push.received', metadata: { event }, ip: req.ip });
  logger.info('skills sync webhook accepted; dry-run queued');
  res.status(202).json({ accepted: true });
});
