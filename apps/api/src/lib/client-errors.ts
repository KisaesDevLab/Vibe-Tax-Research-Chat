// Browser error reports (POST /api/client-errors). The payload is untrusted
// browser input, so everything is length-capped here and the fingerprint is
// computed server-side — a client cannot pick which row it increments.
import crypto from 'node:crypto';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { getDb } from '@vibe/db';
import { client_errors } from '@vibe/db/schema';

// Rows not seen for this long are pruned on the next report.
export const CLIENT_ERROR_RETENTION_DAYS = 90;

const uuidOrNull = z
  .string()
  .uuid()
  .nullish()
  .catch(null)
  .transform((v) => v ?? null);
const capped = (max: number) =>
  z
    .string()
    .nullish()
    .catch(null)
    .transform((v) => (v ? v.slice(0, max) : null));

export const clientErrorSchema = z.object({
  kind: z.enum(['panel', 'app', 'window']),
  source: capped(100),
  message: z
    .string()
    .min(1)
    .transform((v) => v.slice(0, 1000)),
  stack: capped(8000),
  component_stack: capped(8000),
  route: capped(500),
  chat_id: uuidOrNull,
  message_id: uuidOrNull,
});

export type ClientErrorReport = z.infer<typeof clientErrorSchema>;

/** First stack line that names a code location — stable across reloads of one build. */
function topFrame(stack: string | null): string {
  if (!stack) return '';
  const frame = stack.split('\n').find((l) => /\bat\b|@/.test(l));
  return frame?.trim() ?? '';
}

/**
 * One row per distinct failure: same kind/source/error on the same message
 * (or route, for page-level failures) in the same build. Different chats with
 * the same bad shape stay separate rows, which is what an admin needs to find
 * every affected chat.
 */
export function fingerprintOf(r: ClientErrorReport, appVersion: string): string {
  const where = r.message_id ?? r.chat_id ?? r.route ?? '';
  return crypto
    .createHash('sha256')
    .update([appVersion, r.kind, r.source ?? '', r.message, topFrame(r.stack), where].join('\n'))
    .digest('hex');
}

export async function recordClientError(
  r: ClientErrorReport,
  ctx: { user_id: string; user_agent: string | null; app_version: string },
): Promise<void> {
  const db = getDb();
  const now = new Date();
  await db
    .insert(client_errors)
    .values({
      fingerprint: fingerprintOf(r, ctx.app_version),
      kind: r.kind,
      source: r.source,
      message: r.message,
      stack: r.stack,
      component_stack: r.component_stack,
      route: r.route,
      chat_id: r.chat_id,
      message_id: r.message_id,
      app_version: ctx.app_version,
      user_agent: ctx.user_agent?.slice(0, 500) ?? null,
      user_id: ctx.user_id,
    })
    .onConflictDoUpdate({
      target: client_errors.fingerprint,
      set: {
        count: sql`${client_errors.count} + 1`,
        last_seen_at: now,
        user_id: ctx.user_id,
        user_agent: ctx.user_agent?.slice(0, 500) ?? null,
      },
    });
  await db
    .delete(client_errors)
    .where(
      sql`${client_errors.last_seen_at} < now() - make_interval(days => ${CLIENT_ERROR_RETENTION_DAYS})`,
    );
}
