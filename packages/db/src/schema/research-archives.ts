// TP-11 — immutable research-session snapshots filed to a client (or the
// firm-level archive). The snapshot is self-contained: deleting the source
// chat never touches it, and no update path exists for snapshot/sha256
// once the row is written.
import { pgTable, uuid, text, boolean, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { clients } from './clients.js';
import { chats } from './chats.js';
import { users } from './users.js';

// Shape of the frozen snapshot payload. Kept intentionally plain-JSON so
// the sha256 over its canonical serialization is reproducible forever.
export interface ArchiveSnapshotMessage {
  role: string;
  content: string;
  created_at: string;
  authorities?: unknown;
  compliance_check?: unknown;
}

export interface ArchiveSnapshot {
  chat: {
    id: string;
    title: string;
    created_at: string;
    updated_at: string;
  };
  messages: ArchiveSnapshotMessage[];
  consultations: unknown[];
  archived_from_version: number; // snapshot format version
}

export interface ArchiveTombstone {
  original_client: { id: string; name: string };
  event: 'client-deleted';
  actor_user_id: string | null;
  at: string;
}

export const research_archives = pgTable(
  'research_archives',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // NO cascade and NO set-null: the only way a client with archives goes
    // away is the app's reassign-to-firm-then-delete transaction. A raw
    // DELETE on clients with archives still attached must fail.
    client_id: uuid('client_id').references(() => clients.id),
    firm_archive: boolean('firm_archive').notNull().default(false),
    source_session_id: uuid('source_session_id').references(() => chats.id, {
      onDelete: 'set null',
    }),
    title: text('title').notNull(),
    topic_tags: text('topic_tags').array().notNull().default([]),
    note: text('note'),
    snapshot: jsonb('snapshot').$type<ArchiveSnapshot>().notNull(),
    // Post-redaction plain text — the FTS target (GIN expression index is
    // appended by hand in the migration; drizzle can't express it).
    snapshot_text: text('snapshot_text').notNull(),
    sha256: text('sha256').notNull(),
    archived_by: uuid('archived_by').references(() => users.id),
    archived_at: timestamp('archived_at', { withTimezone: true }).notNull().defaultNow(),
    status: text('status').notNull().default('active'), // 'active' | 'superseded'
    tombstone: jsonb('tombstone').$type<ArchiveTombstone>(),
    // Forward links for TP-8; plan_id gets its FK when plans exist.
    plan_id: uuid('plan_id'),
    strategy_id: text('strategy_id'),
  },
  (t) => ({
    client_idx: index('research_archives_client_idx').on(t.client_id),
    source_idx: index('research_archives_source_idx').on(t.source_session_id),
  }),
);

export type ResearchArchive = typeof research_archives.$inferSelect;
export type NewResearchArchive = typeof research_archives.$inferInsert;
