// Phase 25 — BullMQ queue declarations.
// BullMQ ≥5 forbids ':' in queue names; we use '-' as the separator.
import { Queue } from 'bullmq';
import { getRedis } from '../lib/redis.js';

const connection = getRedis();

export const skillsSyncQueue = new Queue('skills-sync', { connection });
export const skillsIngestQueue = new Queue('skills-ingest', { connection });
export const chatTitleQueue = new Queue('chat-title', { connection });
export const usageRollupQueue = new Queue('usage-rollup', { connection });
export const attachmentSummarizeQueue = new Queue('attachment-summarize', { connection });
export const notificationsEmailQueue = new Queue('notifications-email', { connection });
// Phase 32 — chunk + embed firm-uploaded reference documents. Job payload:
// { document_id }. The worker walks the document end-to-end so retries
// are idempotent (it scrubs prior chunks before re-inserting).
export const referencesIngestQueue = new Queue('references-ingest', { connection });
// TP-9 — worker-side Chromium rendering. Payload: { deliverable_id }.
export const pdfRenderQueue = new Queue('pdf-render', { connection });

export const QUEUES = [
  skillsSyncQueue,
  skillsIngestQueue,
  chatTitleQueue,
  usageRollupQueue,
  attachmentSummarizeQueue,
  notificationsEmailQueue,
  referencesIngestQueue,
  pdfRenderQueue,
];
