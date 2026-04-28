// Phase 25 — BullMQ workers + cron schedules.
import { Worker } from 'bullmq';
import { getRedis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import { runDryRun } from '../lib/skills/sync.js';
import {
  skillsSyncQueue,
  usageRollupQueue,
} from './queues.js';
import { env } from '../config/env.js';

const connection = getRedis();

export function startWorkers(): void {
  // ── skills:sync — dry-run only by default
  new Worker(
    'skills:sync',
    async (job) => {
      logger.info({ id: job.id, name: job.name }, 'skills:sync job start');
      try {
        await runDryRun({
          triggered_by: typeof job.data?.triggered_by === 'string' ? job.data.triggered_by : 'cron',
          pin_type: env.SKILLS_REPO_PIN_TYPE as 'tag' | 'branch' | 'sha',
          pin_value: env.SKILLS_REPO_PIN_VALUE,
        });
      } catch (err) {
        logger.error({ err }, 'skills:sync failed');
        throw err;
      }
    },
    { connection },
  );

  // ── usage:rollup — hourly, materializes usage_daily.
  new Worker(
    'usage:rollup',
    async () => {
      // TODO Phase 24: implement INSERT … ON CONFLICT … rollup query.
      logger.info('usage:rollup tick');
    },
    { connection },
  );

  // ── attachment:summarize, chat:title, notifications:email — TODO Phase 23/24/25.

  // Cron schedules
  void scheduleCrons();
}

async function scheduleCrons() {
  // Nightly skills sync at 03:00 local
  await skillsSyncQueue.add(
    'nightly-dry-run',
    { triggered_by: 'cron' },
    { repeat: { pattern: '0 3 * * *' }, jobId: 'cron:skills:sync:nightly' },
  );
  // Hourly usage rollup
  await usageRollupQueue.add(
    'hourly',
    {},
    { repeat: { pattern: '5 * * * *' }, jobId: 'cron:usage:rollup:hourly' },
  );
}
