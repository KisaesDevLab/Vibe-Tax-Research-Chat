// On API startup, look for chats whose newest message is a user turn
// (no assistant reply, no system_note). That's the fingerprint of a
// stream that was interrupted by the previous process dying — req.on
// ('close') doesn't fire when the SERVER goes down, so the in-flight
// SSE handler can't run its partial-save path. Without this recovery
// the user is left staring at their own question with no reply and no
// way to tell something went wrong.
//
// We bound the scan to user messages older than 30 s so a stream that
// is currently in flight (typical TTFB is single-digit seconds plus
// tool-use rounds) doesn't get spuriously flagged. The system_note we
// insert tells the user what happened and how to recover.
import { sql } from 'drizzle-orm';
import { getDb } from '@vibe/db';
import { logger } from './logger.js';

interface OrphanRow {
  chat_id: string;
  message_id: string;
  created_at: Date;
}

export async function recoverOrphanedStreams(): Promise<void> {
  try {
    const db = getDb();
    // Find each chat's newest message; if it's a user role and was
    // created more than 30 s ago, the corresponding assistant row never
    // landed. We use a CTE to compute "newest per chat" so the query
    // stays correct even when many chats are active.
    const rows = (await db.execute(
      sql`
        WITH last_per_chat AS (
          SELECT DISTINCT ON (chat_id) chat_id, id, role, created_at
          FROM messages
          ORDER BY chat_id, created_at DESC
        )
        SELECT chat_id, id AS message_id, created_at
        FROM last_per_chat
        WHERE role = 'user'
          AND created_at < NOW() - INTERVAL '30 seconds'
      `,
    )) as unknown as { rows?: OrphanRow[] } | OrphanRow[];

    // postgres-js wraps results inconsistently across drivers; tolerate
    // either array or {rows: array} shape.
    const orphanList: OrphanRow[] = Array.isArray(rows) ? rows : (rows.rows ?? []);
    if (orphanList.length === 0) return;

    logger.warn(
      { count: orphanList.length, chats: orphanList.map((r) => r.chat_id) },
      'recovering orphaned chat streams',
    );

    for (const o of orphanList) {
      await db.execute(sql`
        INSERT INTO messages (chat_id, role, content)
        VALUES (
          ${o.chat_id},
          'system_note',
          '⚠ Server restart interrupted this turn — the assistant did not get a chance to reply. Re-send your question to retry.'
        )
      `);
    }
  } catch (err) {
    // Recovery is best-effort. Never let it block startup.
    logger.error({ err }, 'orphan-stream recovery failed');
  }
}
