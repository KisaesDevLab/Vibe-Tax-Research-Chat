// TP-11 — research-session archival. Two routers:
//   archivesRouter     → /api/archives (list, nudges, detail, pdf, bulk)
//   chatArchiveRouter  → /api/chats/:id/archive (draft + freeze)
// Snapshots are immutable: there is no update path for snapshot/sha256,
// and re-archiving a session supersedes the prior active archive instead
// of touching it.
import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, isNull, lte, sql } from 'drizzle-orm';
import { getDb } from '@vibe/db';
import {
  chats,
  clients,
  plans,
  plan_research_links,
  research_archives,
  type Chat,
} from '@vibe/db/schema';
import { requireAuth } from '../middleware/auth.js';
import { requirePlanning } from '../middleware/planning-flag.js';
import { audit } from '../lib/audit.js';
import { logger } from '../lib/logger.js';
import { callClaude } from '../lib/anthropic/client.js';
import { detectPii } from '../lib/pii/detect.js';
import { applyRedactions } from '../lib/pii/redact.js';
import { loadSnapshotSource, snapshotToText } from '../lib/archives/snapshot.js';
import { sha256Canonical } from '../lib/canonical-json.js';
import { buildArchivePdf } from '../lib/export/archive-pdf.js';
import { findAttachableClient } from './clients/index.js';

const uuidSchema = z.string().uuid();
const NUDGE_AGE_DAYS = 90;

async function loadOwnedChat(
  chatId: string,
  userId: string,
  isAdmin: boolean,
): Promise<Chat | null> {
  const where = isAdmin
    ? eq(chats.id, chatId)
    : and(eq(chats.id, chatId), eq(chats.user_id, userId));
  const [chat] = await getDb().select().from(chats).where(where).limit(1);
  return chat ?? null;
}

// ── Claude-drafted title + tags (graceful without a key) ─────────────────
async function draftTitleTags(
  chat: Chat,
  texts: string[],
): Promise<{ title: string; tags: string[] }> {
  const fallback = { title: chat.title, tags: [] as string[] };
  const transcript = texts
    .slice(0, 6)
    .map((t) => t.slice(0, 700))
    .join('\n\n');
  if (!transcript) return fallback;
  try {
    const r = await callClaude('archive-title-tags', {
      messages: [
        {
          role: 'user',
          content:
            'This is an archived tax research session. Reply with STRICT JSON only: ' +
            '{"title": "<3-8 word descriptive title>", "tags": ["<3-6 short topic tags>"]}\n\n' +
            transcript,
        },
      ],
    });
    if (!r.text) return fallback;
    const jsonText = r.text.slice(r.text.indexOf('{'), r.text.lastIndexOf('}') + 1);
    const parsed = JSON.parse(jsonText) as { title?: unknown; tags?: unknown };
    const title =
      typeof parsed.title === 'string' && parsed.title.trim()
        ? parsed.title.trim().slice(0, 120)
        : chat.title;
    const tags = Array.isArray(parsed.tags)
      ? parsed.tags
          .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
          .map((t) => t.trim().slice(0, 40))
          .slice(0, 6)
      : [];
    return { title, tags };
  } catch (err) {
    // No key / timeout / parse failure — never block archival on Claude.
    logger.warn({ err, chat_id: chat.id }, 'archive title/tag draft failed; using fallback');
    return fallback;
  }
}

// ── The freeze transaction ───────────────────────────────────────────────
interface FreezeOpts {
  chat: Chat;
  clientId: string | null; // null = firm archive
  title: string;
  topicTags: string[];
  note: string | null;
  acceptedRedactionIds: string[];
  planId: string | null;
  strategyId: string | null;
  actorUserId: string;
  ip: string | undefined;
}

async function freezeArchive(opts: FreezeOpts) {
  const source = await loadSnapshotSource(opts.chat);
  const hits = detectPii(source.messageTexts);
  const accepted = hits.filter((h) => opts.acceptedRedactionIds.includes(h.id));
  const redactedTexts = applyRedactions(source.messageTexts, accepted);
  const snapshot = source.buildSnapshot(redactedTexts);
  const snapshotText = snapshotToText(snapshot);
  const sha256 = sha256Canonical(snapshot);

  const db = getDb();
  const inserted = await db.transaction(async (tx) => {
    // Supersede any prior active archive of the same session.
    await tx
      .update(research_archives)
      .set({ status: 'superseded' })
      .where(
        and(
          eq(research_archives.source_session_id, opts.chat.id),
          eq(research_archives.status, 'active'),
        ),
      );
    const [row] = await tx
      .insert(research_archives)
      .values({
        client_id: opts.clientId,
        firm_archive: opts.clientId === null,
        source_session_id: opts.chat.id,
        title: opts.title,
        topic_tags: opts.topicTags,
        note: opts.note,
        snapshot,
        snapshot_text: snapshotText,
        sha256,
        archived_by: opts.actorUserId,
        plan_id: opts.planId,
        strategy_id: opts.strategyId,
      })
      .returning();
    // Mark the chat archived and promote the soft link.
    await tx
      .update(chats)
      .set({
        archived_at: new Date(),
        ...(opts.clientId ? { client_id: opts.clientId } : {}),
      })
      .where(eq(chats.id, opts.chat.id));
    // TP-16 — archiving against a plan IS the link (the "Research this"
    // launcher flow): create the plan_research_links row the review gate
    // checks, so the elevated-risk gate clears without a second manual
    // linking step. Explicit linking in the Review tab remains available
    // for archives created without a plan.
    if (opts.planId) {
      await tx.insert(plan_research_links).values({
        plan_id: opts.planId,
        strategy_id: opts.strategyId,
        research_archive_id: row!.id,
        created_by: opts.actorUserId,
      });
    }
    return row!;
  });

  await audit({
    actor_user_id: opts.actorUserId,
    action: 'archive.create',
    target_type: 'research_archive',
    target_id: inserted.id,
    metadata: {
      client_id: opts.clientId,
      firm_archive: opts.clientId === null,
      source_session_id: opts.chat.id,
      sha256,
      redactions_applied: accepted.length,
    },
    ip: opts.ip,
  });
  return inserted;
}

// ── Chat-nested actions: /api/chats/:id/archive ──────────────────────────
export const chatArchiveRouter = Router({ mergeParams: true });
chatArchiveRouter.use(requirePlanning);

chatArchiveRouter.post('/draft', async (req, res) => {
  const chatId = (req.params as { id?: string }).id ?? '';
  if (!uuidSchema.safeParse(chatId).success) {
    res.status(400).json({ error: 'bad_request', detail: 'invalid id' });
    return;
  }
  const chat = await loadOwnedChat(chatId, req.auth!.user_id, req.auth!.role === 'admin');
  if (!chat) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const source = await loadSnapshotSource(chat);
  const [{ title, tags }, pii_hits] = await Promise.all([
    draftTitleTags(chat, source.messageTexts),
    Promise.resolve(detectPii(source.messageTexts)),
  ]);
  res.json({ suggested_title: title, suggested_tags: tags, pii_hits });
});

const archiveSchema = z
  .object({
    client_id: z.string().uuid().nullable().optional(),
    firm_archive: z.boolean().default(false),
    title: z.string().min(1).max(200),
    topic_tags: z.array(z.string().min(1).max(40)).max(6).default([]),
    note: z.string().max(2000).nullable().optional(),
    accepted_redaction_ids: z.array(z.string()).default([]),
    plan_id: z.string().uuid().nullable().optional(),
    strategy_id: z.string().max(100).nullable().optional(),
  })
  .refine((v) => v.firm_archive || v.client_id, {
    message: 'client_id required unless firm_archive',
  });

chatArchiveRouter.post('/', async (req, res) => {
  const chatId = (req.params as { id?: string }).id ?? '';
  if (!uuidSchema.safeParse(chatId).success) {
    res.status(400).json({ error: 'bad_request', detail: 'invalid id' });
    return;
  }
  const parsed = archiveSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'bad_request', detail: parsed.error.flatten() });
    return;
  }
  const chat = await loadOwnedChat(chatId, req.auth!.user_id, req.auth!.role === 'admin');
  if (!chat) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  let clientId: string | null = null;
  if (!parsed.data.firm_archive && parsed.data.client_id) {
    const client = await findAttachableClient(parsed.data.client_id);
    if (!client) {
      res.status(400).json({ error: 'unknown_or_merged_client' });
      return;
    }
    clientId = client.id;
  }
  // TP-8 — a plan link must stay inside the same client.
  if (parsed.data.plan_id) {
    const [plan] = await getDb()
      .select({ client_id: plans.client_id })
      .from(plans)
      .where(eq(plans.id, parsed.data.plan_id))
      .limit(1);
    if (!plan || plan.client_id !== clientId) {
      res.status(400).json({ error: 'plan_belongs_to_other_client' });
      return;
    }
  }
  const archive = await freezeArchive({
    chat,
    clientId,
    title: parsed.data.title,
    topicTags: parsed.data.topic_tags,
    note: parsed.data.note ?? null,
    acceptedRedactionIds: parsed.data.accepted_redaction_ids,
    planId: parsed.data.plan_id ?? null,
    strategyId: parsed.data.strategy_id ?? null,
    actorUserId: req.auth!.user_id,
    ip: req.ip,
  });
  res.status(201).json({ archive: stripSnapshot(archive) });
});

// ── /api/archives ────────────────────────────────────────────────────────
export const archivesRouter = Router();
archivesRouter.use(requireAuth, requirePlanning);

// List: firm archive or by client (client tab uses /api/archives?client_id=…
// with optional q= full-text search over the post-redaction snapshot).
archivesRouter.get('/', async (req, res) => {
  const firm = req.query.firm === 'true';
  const clientId = typeof req.query.client_id === 'string' ? req.query.client_id : null;
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (!firm && !clientId) {
    res.status(400).json({ error: 'bad_request', detail: 'client_id or firm=true required' });
    return;
  }
  if (clientId && !uuidSchema.safeParse(clientId).success) {
    res.status(400).json({ error: 'bad_request', detail: 'invalid client_id' });
    return;
  }
  const scope = firm
    ? eq(research_archives.firm_archive, true)
    : eq(research_archives.client_id, clientId!);
  // Per-client FTS runs over post-redaction snapshot_text + title/tags —
  // authz'd to the client scope. Cross-client search (clients router)
  // never touches snapshot content.
  const where = q
    ? and(
        scope,
        sql`(to_tsvector('english', ${research_archives.snapshot_text}) @@ plainto_tsquery('english', ${q})
             OR ${research_archives.title} ILIKE ${'%' + q + '%'}
             OR ${q} = ANY(${research_archives.topic_tags}))`,
      )
    : scope;
  const rows = await getDb()
    .select()
    .from(research_archives)
    .where(where)
    .orderBy(desc(research_archives.archived_at))
    .limit(100);
  res.json({ archives: rows.map(stripSnapshot) });
});

// "File to a client?" nudges: the actor's own chats, ≥90 days old,
// unlinked, never archived, not dismissed.
archivesRouter.get('/nudges', async (req, res) => {
  const cutoff = new Date(Date.now() - NUDGE_AGE_DAYS * 24 * 60 * 60 * 1000);
  const rows = await getDb()
    .select({ id: chats.id, title: chats.title, updated_at: chats.updated_at })
    .from(chats)
    .where(
      and(
        eq(chats.user_id, req.auth!.user_id),
        lte(chats.updated_at, cutoff),
        isNull(chats.client_id),
        isNull(chats.archived_at),
        isNull(chats.nudge_dismissed_at),
        sql`NOT EXISTS (SELECT 1 FROM research_archives ra
             WHERE ra.source_session_id = ${chats.id} AND ra.status = 'active')`,
      ),
    )
    .orderBy(desc(chats.updated_at))
    .limit(20);
  res.json({ nudges: rows });
});

archivesRouter.post('/nudges/:chatId/dismiss', async (req, res) => {
  if (!uuidSchema.safeParse(req.params.chatId).success) {
    res.status(400).json({ error: 'bad_request', detail: 'invalid id' });
    return;
  }
  const updated = await getDb()
    .update(chats)
    .set({ nudge_dismissed_at: new Date() })
    .where(and(eq(chats.id, req.params.chatId), eq(chats.user_id, req.auth!.user_id)))
    .returning({ id: chats.id });
  if (updated.length === 0) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.status(204).end();
});

// Bulk archive: chat titles as archive titles, no Claude call. Chats with
// PII hits are NOT silently archived — they come back as
// pii_review_required for individual handling in the dialog.
const bulkSchema = z
  .object({
    chat_ids: z.array(z.string().uuid()).min(1).max(50),
    client_id: z.string().uuid().nullable().optional(),
    firm_archive: z.boolean().default(false),
  })
  .refine((v) => v.firm_archive || v.client_id, {
    message: 'client_id required unless firm_archive',
  });

archivesRouter.post('/bulk', async (req, res) => {
  const parsed = bulkSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'bad_request', detail: parsed.error.flatten() });
    return;
  }
  let clientId: string | null = null;
  if (!parsed.data.firm_archive && parsed.data.client_id) {
    const client = await findAttachableClient(parsed.data.client_id);
    if (!client) {
      res.status(400).json({ error: 'unknown_or_merged_client' });
      return;
    }
    clientId = client.id;
  }
  const isAdmin = req.auth!.role === 'admin';
  const archived: string[] = [];
  const piiReviewRequired: string[] = [];
  const notFound: string[] = [];
  for (const chatId of parsed.data.chat_ids) {
    const chat = await loadOwnedChat(chatId, req.auth!.user_id, isAdmin);
    if (!chat) {
      notFound.push(chatId);
      continue;
    }
    const source = await loadSnapshotSource(chat);
    if (detectPii(source.messageTexts).length > 0) {
      piiReviewRequired.push(chatId);
      continue;
    }
    await freezeArchive({
      chat,
      clientId,
      title: chat.title,
      topicTags: [],
      note: null,
      acceptedRedactionIds: [],
      planId: null,
      strategyId: null,
      actorUserId: req.auth!.user_id,
      ip: req.ip,
    });
    archived.push(chatId);
  }
  res.json({ archived, pii_review_required: piiReviewRequired, not_found: notFound });
});

archivesRouter.get('/:id', async (req, res) => {
  if (!uuidSchema.safeParse(req.params.id).success) {
    res.status(400).json({ error: 'bad_request', detail: 'invalid id' });
    return;
  }
  const [row] = await getDb()
    .select()
    .from(research_archives)
    .where(eq(research_archives.id, req.params.id))
    .limit(1);
  if (!row) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.json({ archive: row });
});

archivesRouter.get('/:id/pdf', async (req, res) => {
  if (!uuidSchema.safeParse(req.params.id).success) {
    res.status(400).json({ error: 'bad_request', detail: 'invalid id' });
    return;
  }
  const db = getDb();
  const [row] = await db
    .select()
    .from(research_archives)
    .where(eq(research_archives.id, req.params.id))
    .limit(1);
  if (!row) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  let clientName: string | null = null;
  if (row.client_id) {
    const [client] = await db
      .select({ name: clients.name })
      .from(clients)
      .where(eq(clients.id, row.client_id))
      .limit(1);
    clientName = client?.name ?? null;
  }
  const pdf = await buildArchivePdf(row, clientName);
  const filename = `archive-${row.title.replace(/[^a-z0-9-_ ]/gi, '').slice(0, 60) || row.id}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(pdf);
});

// List DTO: everything except the (potentially large) snapshot body.
function stripSnapshot(row: typeof research_archives.$inferSelect) {
  const { snapshot: _snapshot, snapshot_text: _text, ...rest } = row;
  return { ...rest, message_count: row.snapshot.messages.length };
}
