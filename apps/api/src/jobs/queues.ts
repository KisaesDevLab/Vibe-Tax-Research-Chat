// Phase 25 — BullMQ queue declarations.
// BullMQ ≥5 forbids ':' in queue names; we use '-' as the separator.
import { Queue } from 'bullmq';
import { getRedis } from '../lib/redis.js';

const connection = getRedis();

// Bounded retention on every queue: completed jobs are only useful for a
// short debugging window; failed jobs keep a week for the admin Queues UI.
// Unbounded retention also meant notifications-email payloads (which carry
// the plaintext password-reset token) lived in Redis forever.
const defaultJobOptions = {
  removeOnComplete: { age: 3600, count: 500 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

export const skillsSyncQueue = new Queue('skills-sync', { connection, defaultJobOptions });
export const chatTitleQueue = new Queue('chat-title', { connection, defaultJobOptions });
export const usageRollupQueue = new Queue('usage-rollup', { connection, defaultJobOptions });
export const attachmentSummarizeQueue = new Queue('attachment-summarize', {
  connection,
  defaultJobOptions,
});
export const notificationsEmailQueue = new Queue('notifications-email', {
  connection,
  defaultJobOptions,
});
// Phase 32 — chunk + embed firm-uploaded reference documents. Job payload:
// { document_id }. The worker walks the document end-to-end so retries
// are idempotent (it scrubs prior chunks before re-inserting).
export const referencesIngestQueue = new Queue('references-ingest', {
  connection,
  defaultJobOptions,
});
// TP-9 — worker-side Chromium rendering. Payload: { deliverable_id }.
export const pdfRenderQueue = new Queue('pdf-render', { connection, defaultJobOptions });
// TP-12 — Claude drafts a refreshed strategy record into the review
// queue. Payload: { strategy_id, triggered_by }. No key → logged skip.
export const strategyAuthorQueue = new Queue('strategy-author', { connection, defaultJobOptions });
// TP-14 — currency jobs. All Claude-dependent handlers degrade to a
// logged skip without a key; golden-regression and archive-scan are
// pure-local and always run.
export const tablesDraftQueue = new Queue('tables-draft', { connection, defaultJobOptions });
export const strategyRefreshQueue = new Queue('strategy-refresh', {
  connection,
  defaultJobOptions,
});
export const strategyWatchQueue = new Queue('strategy-watch', { connection, defaultJobOptions });
export const goldenRegressionQueue = new Queue('golden-regression', {
  connection,
  defaultJobOptions,
});
export const archiveScanQueue = new Queue('archive-scan', { connection, defaultJobOptions });
// TP-3a — shield → classify → extract → chunk + embed a client source
// document. Payload: { document_id, actor_user_id? }. Idempotent (chunk
// replace; resolved candidates preserved on re-ingest).
export const clientDocumentsIngestQueue = new Queue('client-documents-ingest', {
  connection,
  defaultJobOptions,
});

export const QUEUES = [
  skillsSyncQueue,
  chatTitleQueue,
  usageRollupQueue,
  attachmentSummarizeQueue,
  notificationsEmailQueue,
  referencesIngestQueue,
  pdfRenderQueue,
  strategyAuthorQueue,
  tablesDraftQueue,
  strategyRefreshQueue,
  strategyWatchQueue,
  goldenRegressionQueue,
  archiveScanQueue,
  clientDocumentsIngestQueue,
];
