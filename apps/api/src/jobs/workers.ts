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
import { ingestReferenceDocument } from '../lib/references/ingest.js';
import {
  skillsSyncQueue,
  usageRollupQueue,
  tablesDraftQueue,
  strategyWatchQueue,
  archiveScanQueue,
} from './queues.js';
import { env } from '../config/env.js';
import { getDb } from '@vibe/db';
import {
  chats,
  messages,
  chat_attachments,
  usage_events,
  usage_daily,
  SETTING_KEYS,
} from '@vibe/db/schema';
import { callClaude } from '../lib/anthropic/client.js';
import { buildMailer, renderResetEmail } from '../lib/email/index.js';
import { getSetting } from '../lib/settings-store.js';

const connection = getRedis();

// Default to `any` for the job-data shape — BullMQ's own Worker<T> default
// is `any` and the existing call sites read job.data?.x without runtime
// guards. The handlers narrow with `typeof === 'string'` checks before use.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WorkerHandler = (job: Job<any>) => Promise<unknown>;

// Wrap Worker construction so every queue gets uniform error handling. If a
// job throws, BullMQ marks it failed; we log it and DO NOT let it bubble to
// process-level unhandledRejection (which modern Node treats as fatal).
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

  // ── references-ingest — chunk + embed a firm reference document.
  // Job payload: { document_id }. Idempotent: a retry replaces the prior
  // chunk set for the same document_id, so transient embedding-API
  // failures (e.g., Voyage 5xx) recover cleanly.
  createWorker('references-ingest', async (job) => {
    const document_id = job.data?.document_id as string | undefined;
    if (!document_id) return;
    await ingestReferenceDocument(document_id);
  });

  // ── pdf-render — deliverable rendering via PDFKit (server-side).
  createWorker('pdf-render', async (job) => {
    const deliverable_id = job.data?.deliverable_id as string | undefined;
    if (!deliverable_id) return;
    const handout_strategy_id = job.data?.handout_strategy_id as string | undefined;
    const { renderDeliverable } = await import('./handlers/pdf-render.js');
    await renderDeliverable(deliverable_id, handout_strategy_id);
  });

  // ── strategy-author — TP-12 pipeline draft into the review queue.
  // Gracefully skips (job succeeds) when no Anthropic key is configured.
  createWorker('strategy-author', async (job) => {
    const strategy_id = job.data?.strategy_id as string | undefined;
    if (!strategy_id) return;
    const triggered_by =
      typeof job.data?.triggered_by === 'string' ? job.data.triggered_by : 'manual';
    const { draftStrategy } = await import('./handlers/strategy-author.js');
    return draftStrategy(strategy_id, triggered_by);
  });

  // ── TP-14 currency jobs ────────────────────────────────────────────
  createWorker('tables-draft', async (job) => {
    const { runTablesDraft } = await import('./handlers/currency.js');
    await runTablesDraft(
      typeof job.data?.triggered_by === 'string' ? job.data.triggered_by : 'cron',
    );
  });

  createWorker('golden-regression', async (job) => {
    const table_set_id = job.data?.table_set_id as string | undefined;
    if (!table_set_id) return;
    const { runGoldenRegression } = await import('./handlers/currency.js');
    await runGoldenRegression(
      table_set_id,
      typeof job.data?.triggered_by === 'string' ? job.data.triggered_by : 'publish',
    );
  });

  createWorker('strategy-watch', async (job) => {
    const { runStrategyWatch } = await import('./handlers/currency.js');
    await runStrategyWatch(
      typeof job.data?.triggered_by === 'string' ? job.data.triggered_by : 'cron',
    );
  });

  createWorker('archive-scan', async (job) => {
    const { runArchiveScan } = await import('./handlers/currency.js');
    await runArchiveScan(
      typeof job.data?.triggered_by === 'string' ? job.data.triggered_by : 'cron',
    );
  });

  // strategy-refresh — one strategy per job, or a full sweep when no
  // strategy_id is given (each per-strategy call skips fast without a key).
  createWorker('strategy-refresh', async (job) => {
    const { draftStrategy } = await import('./handlers/strategy-author.js');
    const triggered_by =
      typeof job.data?.triggered_by === 'string' ? job.data.triggered_by : 'refresh';
    const one = job.data?.strategy_id as string | undefined;
    const db = getDb();
    const { strategies } = await import('@vibe/db/schema');
    const targets = one ? [{ id: one }] : await db.select({ id: strategies.id }).from(strategies);
    for (const t of targets) {
      const result = await draftStrategy(t.id, triggered_by);
      if (result.status === 'skipped-no-key') return; // no point iterating
    }
  });

  // ── notifications-email — outbound transactional email.
  // Today's only job type is `password-reset`. The payload carries the
  // plaintext token (the DB stores only its hash) and the recipient.
  // Throwing from the handler marks the job failed in BullMQ — visible
  // in the admin Queues UI — and the createWorker() wrapper logs it.
  createWorker('notifications-email', async (job) => {
    if (job.name !== 'password-reset') {
      logger.warn({ job_name: job.name }, 'notifications-email: unknown job type');
      return;
    }
    const email = job.data?.email as string | undefined;
    const token = job.data?.token as string | undefined;
    const expiresAtIso = job.data?.expires_at as string | undefined;
    if (!email || !token || !expiresAtIso) {
      throw new Error('notifications-email: missing required fields');
    }
    const mailer = await buildMailer();
    if (!mailer) {
      throw new Error('notifications-email: email not configured');
    }
    const baseUrl = await getSetting<string>(SETTING_KEYS.APP_BASE_URL);
    if (!baseUrl) {
      throw new Error('notifications-email: APP_BASE_URL not set');
    }
    const expiresAt = new Date(expiresAtIso);
    const expiresMinutes = Math.max(1, Math.round((expiresAt.getTime() - Date.now()) / 60_000));
    const resetUrl = `${baseUrl.replace(/\/+$/, '')}/reset?token=${encodeURIComponent(token)}`;
    const rendered = renderResetEmail({
      user_email: email,
      reset_url: resetUrl,
      expires_minutes: expiresMinutes,
    });
    await mailer.send({ to: email, ...rendered });
    logger.info({ email, provider: mailer.kind }, 'password-reset email sent');
  });

  // Cron registration talks to Redis; a boot-time blip must not silently
  // mean "no crons until the next restart". Log the failure and retry
  // once after 30s — a second failure is logged and left for operators.
  scheduleCrons().catch((err) => {
    logger.error({ err }, 'cron registration failed — retrying in 30s');
    setTimeout(() => {
      scheduleCrons().catch((retryErr) => {
        logger.error({ err: retryErr }, 'cron registration retry failed — crons not scheduled');
      });
    }, 30_000);
  });
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
    const r = await callClaude('chat-title', {
      messages: [
        {
          role: 'user',
          content:
            'Generate a 3–6 word descriptive title for the following tax research chat. Return only the title text, no quotes, no period.\n\n' +
            transcript,
        },
      ],
    });
    if (r.text.trim()) title = r.text.trim().slice(0, 80);
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
    const r = await callClaude('attachment-summarize', {
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
    summary = r.text.trim();
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
    -- Day-aligned window: yesterday 00:00 onward. A sliding 48h window
    -- would recompute a partially-covered day and overwrite its complete
    -- rollup with a truncated one.
    WHERE occurred_at >= date_trunc('day', NOW() - INTERVAL '1 day')
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
  // TP-14 — annual tables draft when the fall Rev. Proc. cycle starts
  // (Oct 1), weekly watch + archive scans. All degrade without a key.
  await tablesDraftQueue.add(
    'annual',
    { triggered_by: 'cron' },
    { repeat: { pattern: '0 6 1 10 *' }, jobId: 'cron-tables-draft-annual' },
  );
  await strategyWatchQueue.add(
    'weekly',
    { triggered_by: 'cron' },
    { repeat: { pattern: '0 5 * * 1' }, jobId: 'cron-strategy-watch-weekly' },
  );
  await archiveScanQueue.add(
    'weekly',
    { triggered_by: 'cron' },
    { repeat: { pattern: '30 5 * * 1' }, jobId: 'cron-archive-scan-weekly' },
  );
}
