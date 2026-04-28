// Phase 25 — BullMQ queue declarations.
import { Queue } from 'bullmq';
import { getRedis } from '../lib/redis.js';

const connection = getRedis();

export const skillsSyncQueue = new Queue('skills:sync', { connection });
export const skillsIngestQueue = new Queue('skills:ingest', { connection });
export const chatTitleQueue = new Queue('chat:title', { connection });
export const usageRollupQueue = new Queue('usage:rollup', { connection });
export const attachmentSummarizeQueue = new Queue('attachment:summarize', { connection });
export const notificationsEmailQueue = new Queue('notifications:email', { connection });

export const QUEUES = [
  skillsSyncQueue,
  skillsIngestQueue,
  chatTitleQueue,
  usageRollupQueue,
  attachmentSummarizeQueue,
  notificationsEmailQueue,
];
