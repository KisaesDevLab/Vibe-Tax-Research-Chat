// Phase 25 — BullMQ workers + cron schedules.
//
// Each Worker instance is wrapped with a `failed` + `error` listener so a
// thrown job (e.g. a missing upstream tag for skills-sync) gets recorded and
// logged, but never propagates to the Node process as an unhandledRejection
// — which previously crashed the API the first time the nightly cron tried
// to checkout a non-existent tag.
import { Worker, type Job } from 'bullmq';
import { eq, asc, sql } from 'drizzle-orm';
import { getRedis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import { runDryRun } from '../lib/skills/sync.js';
import { skillsSyncQueue, usageRollupQueue } from './queues.js';
import { env } from '../config/env.js';
import { getDb } from '@vibe/db';
import { chats, messages, chat_attachments, usage_events, usage_daily } from '@vibe/db/schema';
import { getAnthropic } from '../lib/anthropic/client.js';

const connection = getRedis();

// Default to `any` for the job-data shape — BullMQ's own Worker<T> default
// is `any` and the existing call sites read job.data?.x without runtime
// guards. The handlers narrow with `typeof === 'string'` checks before use.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WorkerHandler = (job: Job<any>) => Promise<unknown>;

// Wrap Worker construction so every queue gets uniform error handling. If a
// job throws, BullMQ marks it failed; we log it and DO NOT let it bubble to
// process-level unhandledRejection (which Node 20 treats as fatal).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createWorker(name: string, handler: WorkerHandler): Worker<any> {
  const w = new Worker(name, handler, { connection });
  w.on('failed', (job, err) => {
    logger.error({ queue: name, job_id: job?.id, job_name: job?.name, err }, 'job failed');
  });
  w.on('error', (err) => {
    // Connection-level errors (Redis blip, etc.). Logged, never fatal.
    logger.error({ queue: name, err }, 'worker error');
  });
  return w;
}

export function startWorkers(): void {
  // ── skills-sync — dry-run only by default
  createWorker('skills-sync', async (job) => {
    logger.info({ id: job.id, name: job.name }, 'skills:sync job start');
    await runDryRun({
      triggered_by: typeof job.data?.triggered_by === 'string' ? job.data.triggered_by : 'cron',
      pin_type: env.SKILLS_REPO_PIN_TYPE as 'tag' | 'branch' | 'sha',
      pin_value: env.SKILLS_REPO_PIN_VALUE,
    });
  });

  // ── chat-title — Haiku 4.5 auto-titler after the first assistant turn.
  createWorker('chat-title', async (job) => {
    const chat_id = job.data?.chat_id as string | undefined;
    if (!chat_id) return;
    await titleChat(chat_id);
  });

  // ── attachment-summarize — async Haiku 4.5 summary on PDF/DOCX upload.
  createWorker('attachment-summarize', async (job) => {
    const attachment_id = job.data?.attachment_id as string | undefined;
    if (!attachment_id) return;
    await summarizeAttachment(attachment_id);
  });

  // ── usage-rollup — UPSERT usage_daily from the last 48h of usage_events.
  createWorker('usage-rollup', async () => {
    await rollupUsageDaily();
  });

  void scheduleCrons();
}

async function titleChat(chat_id: string): Promise<void> {
  const db = getDb();
  const recent = await db
    .select({ role: messages.role, content: messages.content })
    .from(messages)
    .where(eq(messages.chat_id, chat_id))
    .orderBy(asc(messages.created_at))
    .limit(4);
  if (recent.length === 0) return;
  const transcript = recent
    .map((r) => `${r.role.toUpperCase()}: ${r.content.slice(0, 800)}`)
    .join('\n\n');
  let title = 'Untitled chat';
  try {
    const { client } = await getAnthropic();
    const r = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 32,
      messages: [
        {
          role: 'user',
          content:
            'Generate a 3–6 word descriptive title for the following tax research chat. Return only the title text, no quotes, no period.\n\n' +
            transcript,
        },
      ],
    });
    const block = r.content.find((c) => c.type === 'text');
    if (block && block.type === 'text') title = block.text.trim().slice(0, 80);
  } catch (err) {
    logger.warn({ err, chat_id }, 'chat:title generation failed');
    return;
  }
  await db.update(chats).set({ title, updated_at: new Date() }).where(eq(chats.id, chat_id));
  logger.info({ chat_id, title }, 'chat titled');
}

async function summarizeAttachment(attachment_id: string): Promise<void> {
  const db = getDb();
  const [att] = await db
    .select()
    .from(chat_attachments)
    .where(eq(chat_attachments.id, attachment_id))
    .limit(1);
  if (!att || !att.full_text) return;
  const text = att.full_text.slice(0, 80_000);
  let summary = '';
  try {
    const { client } = await getAnthropic();
    const r = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 600,
      messages: [
        {
          role: 'user',
          content:
            `Summarize the following document in 5–8 sentences for a CPA. Focus on: client identifiers, ` +
            `tax years, dollar amounts, dates, and any flags requiring follow-up. Document name: ` +
            `${att.filename}\n\n---\n\n${text}`,
        },
      ],
    });
    const block = r.content.find((c) => c.type === 'text');
    if (block && block.type === 'text') summary = block.text.trim();
  } catch (err) {
    logger.warn({ err, attachment_id }, 'attachment:summarize failed');
    return;
  }
  if (summary) {
    await db
      .update(chat_attachments)
      .set({ summary })
      .where(eq(chat_attachments.id, attachment_id));
  }
}

async function rollupUsageDaily(): Promise<void> {
  await getDb().execute(sql`
    INSERT INTO usage_daily (day, user_id, model_id, message_count, total_tokens, total_cost_usd)
    SELECT
      date_trunc('day', occurred_at)::date AS day,
      user_id,
      model_id,
      COUNT(*) AS message_count,
      SUM(input_tokens + output_tokens + cache_creation_input_tokens + cache_read_input_tokens) AS total_tokens,
      SUM(cost_usd) AS total_cost_usd
    FROM usage_events
    WHERE occurred_at >= NOW() - INTERVAL '2 days'
    GROUP BY 1, 2, 3
    ON CONFLICT (day, user_id, model_id) DO UPDATE SET
      message_count = EXCLUDED.message_count,
      total_tokens = EXCLUDED.total_tokens,
      total_cost_usd = EXCLUDED.total_cost_usd
  `);
  logger.info('usage:rollup done');
  void usage_events;
  void usage_daily;
}

async function scheduleCrons() {
  await skillsSyncQueue.add(
    'nightly-dry-run',
    { triggered_by: 'cron' },
    { repeat: { pattern: '0 3 * * *' }, jobId: 'cron-skills-sync-nightly' },
  );
  await usageRollupQueue.add(
    'hourly',
    {},
    { repeat: { pattern: '5 * * * *' }, jobId: 'cron-usage-rollup-hourly' },
  );
}
