// TP-11 — builds the self-contained archive snapshot for a chat: full
// transcript, citation records, and web-consultation audit trail. The
// returned message texts are what the PII pass runs over; the caller
// substitutes the redacted texts back in via buildSnapshot's `texts`
// argument before freezing.
import { eq, asc, inArray } from 'drizzle-orm';
import { getDb } from '@vibe/db';
import { messages, primary_source_consultations, type Chat } from '@vibe/db/schema';
import type { ArchiveSnapshot } from '@vibe/db/schema';

export interface SnapshotSource {
  chat: Chat;
  messageTexts: string[]; // one entry per transcript message, pre-redaction
  buildSnapshot: (texts: string[]) => ArchiveSnapshot;
}

export async function loadSnapshotSource(chat: Chat): Promise<SnapshotSource> {
  const db = getDb();
  const msgs = await db
    .select()
    .from(messages)
    .where(eq(messages.chat_id, chat.id))
    .orderBy(asc(messages.created_at));

  const messageIds = msgs.map((m) => m.id);
  const consultations =
    messageIds.length > 0
      ? await db
          .select()
          .from(primary_source_consultations)
          .where(inArray(primary_source_consultations.message_id, messageIds))
      : [];

  const messageTexts = msgs.map((m) => m.content);

  const buildSnapshot = (texts: string[]): ArchiveSnapshot => ({
    chat: {
      id: chat.id,
      title: chat.title,
      created_at: chat.created_at.toISOString(),
      updated_at: chat.updated_at.toISOString(),
    },
    messages: msgs.map((m, i) => ({
      role: m.role,
      content: texts[i] ?? m.content,
      created_at: m.created_at.toISOString(),
      authorities: m.authorities ?? undefined,
      compliance_check: m.compliance_check ?? undefined,
    })),
    consultations: consultations.map((c) => ({
      tool_name: c.tool_name,
      url: c.url,
      query: c.query,
      domain: c.domain,
      fetched_at: c.fetched_at.toISOString(),
      cited_in_authorities: c.cited_in_authorities,
    })),
    archived_from_version: 1,
  });

  return { chat, messageTexts, buildSnapshot };
}

// Plain-text projection of a snapshot for FTS. Includes titles and
// transcript bodies (post-redaction) — never raw pre-redaction content.
export function snapshotToText(snapshot: ArchiveSnapshot): string {
  return [snapshot.chat.title, ...snapshot.messages.map((m) => m.content)].join('\n\n');
}
