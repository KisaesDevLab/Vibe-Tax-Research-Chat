// TP-2 — client records API (local-only in this slice). Every route is
// behind the planning flag: with the module off these endpoints are
// indistinguishable from not existing.
import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, ilike, isNull, or, sql, count } from 'drizzle-orm';
import { getDb } from '@vibe/db';
import {
  clients,
  chats,
  audit_log,
  client_documents,
  client_fact_patterns,
  deliverables,
  plans,
  research_archives,
} from '@vibe/db/schema';
import { requireAuth } from '../../middleware/auth.js';
import { requirePlanning } from '../../middleware/planning-flag.js';
import { audit } from '../../lib/audit.js';
import { deleteClientDocumentFiles } from '../../lib/client-documents/storage.js';
import { logger } from '../../lib/logger.js';

export const clientsRouter = Router();
clientsRouter.use(requireAuth, requirePlanning);

const contactSchema = z.object({
  name: z.string().max(200).optional(),
  email: z.string().email().optional(),
  phone: z.string().max(50).optional(),
  role: z.string().max(100).optional(),
});

const createSchema = z.object({
  name: z.string().min(1).max(300),
  entity_type: z.string().min(1).max(60).default('individual'),
  contacts: z.array(contactSchema).max(20).default([]),
});

clientsRouter.get('/', async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  // Merged rows are hidden from lists/pickers — their links still resolve,
  // but no new work should attach to them.
  const notMerged = isNull(clients.merged_into_id);
  const where = q ? and(notMerged, ilike(clients.name, `%${q}%`)) : notMerged;
  const rows = await getDb().select().from(clients).where(where).orderBy(clients.name).limit(200);
  res.json({ clients: rows });
});

clientsRouter.post('/', async (req, res) => {
  const parsed = createSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'bad_request', detail: parsed.error.flatten() });
    return;
  }
  const [row] = await getDb()
    .insert(clients)
    .values({
      name: parsed.data.name,
      entity_type: parsed.data.entity_type,
      contacts: parsed.data.contacts,
      created_by: req.auth!.user_id,
    })
    .returning();
  await audit({
    actor_user_id: req.auth!.user_id,
    action: 'client.create',
    target_type: 'client',
    target_id: row!.id,
    metadata: { client_id: row!.id, name: row!.name },
    ip: req.ip,
  });
  res.status(201).json({ client: row });
});

// Resolves a client id to an attachable (existing, un-merged) row, or null.
export async function findAttachableClient(clientId: string) {
  const [row] = await getDb()
    .select()
    .from(clients)
    .where(and(eq(clients.id, clientId), isNull(clients.merged_into_id)))
    .limit(1);
  return row ?? null;
}

const uuidSchema = z.string().uuid();

// ── TP-3 — cross-client search ───────────────────────────────────────────
// PII-safe by construction: matches only client name / entity type (and,
// from TP-11, archive titles + topic tags) — never message or snapshot
// bodies. Registered before /:id so 'search' isn't shadowed.
clientsRouter.get('/search', async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (!q) {
    res.json({ clients: [], archives: [] });
    return;
  }
  const db = getDb();
  const rows = await db
    .select()
    .from(clients)
    .where(and(isNull(clients.merged_into_id), ilike(clients.name, `%${q}%`)))
    .orderBy(clients.name)
    .limit(50);
  // TP-11 — archive hits by title/topic-tag ONLY. Snapshot bodies are
  // deliberately excluded from the cross-client index (no PII in it);
  // body-text FTS lives behind the per-client archive listing.
  const archiveRows = await db
    .select({
      id: research_archives.id,
      title: research_archives.title,
      topic_tags: research_archives.topic_tags,
      client_id: research_archives.client_id,
      firm_archive: research_archives.firm_archive,
      archived_at: research_archives.archived_at,
      status: research_archives.status,
    })
    .from(research_archives)
    .where(
      or(
        ilike(research_archives.title, `%${q}%`),
        sql`${q} = ANY(${research_archives.topic_tags})`,
      ),
    )
    .orderBy(desc(research_archives.archived_at))
    .limit(50);
  res.json({ clients: rows, archives: archiveRows });
});

// ── TP-3 — client detail ─────────────────────────────────────────────────
clientsRouter.get('/:id', async (req, res) => {
  if (!uuidSchema.safeParse(req.params.id).success) {
    res.status(400).json({ error: 'bad_request', detail: 'invalid id' });
    return;
  }
  const db = getDb();
  const [client] = await db.select().from(clients).where(eq(clients.id, req.params.id)).limit(1);
  if (!client) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const [chatCount] = await db
    .select({ n: count() })
    .from(chats)
    .where(eq(chats.client_id, client.id));
  const [archiveCount] = await db
    .select({ n: count() })
    .from(research_archives)
    .where(and(eq(research_archives.client_id, client.id), eq(research_archives.status, 'active')));
  const [planCount] = await db
    .select({ n: count() })
    .from(plans)
    .where(eq(plans.client_id, client.id));
  const [documentCount] = await db
    .select({ n: count() })
    .from(deliverables)
    .innerJoin(plans, eq(plans.id, deliverables.plan_id))
    .where(and(eq(plans.client_id, client.id), eq(deliverables.status, 'ready')));
  res.json({
    client,
    counts: {
      chats: chatCount?.n ?? 0,
      archives: archiveCount?.n ?? 0,
      plans: planCount?.n ?? 0,
      documents: documentCount?.n ?? 0,
    },
  });
});

const patchClientSchema = z.object({
  name: z.string().min(1).max(300).optional(),
  entity_type: z.string().min(1).max(60).optional(),
  contacts: z.array(contactSchema).max(20).optional(),
});

clientsRouter.patch('/:id', async (req, res) => {
  if (!uuidSchema.safeParse(req.params.id).success) {
    res.status(400).json({ error: 'bad_request', detail: 'invalid id' });
    return;
  }
  const parsed = patchClientSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'bad_request', detail: parsed.error.flatten() });
    return;
  }
  const existing = await findAttachableClient(req.params.id);
  if (!existing) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const [row] = await getDb()
    .update(clients)
    .set({ ...parsed.data, updated_at: new Date() })
    .where(eq(clients.id, req.params.id))
    .returning();
  await audit({
    actor_user_id: req.auth!.user_id,
    action: 'client.update',
    target_type: 'client',
    target_id: req.params.id,
    metadata: { client_id: req.params.id, fields: Object.keys(parsed.data) },
    ip: req.ip,
  });
  res.json({ client: row });
});

// ── TP-3 — merge ─────────────────────────────────────────────────────────
// Marks the source record merged and re-points its links to the survivor.
// The source row is never deleted, so anything created before the merge
// keeps resolving. TP-11 extends the same transaction to research archives.
const mergeSchema = z.object({ into_client_id: z.string().uuid() });

clientsRouter.post('/:id/merge', async (req, res) => {
  if (!uuidSchema.safeParse(req.params.id).success) {
    res.status(400).json({ error: 'bad_request', detail: 'invalid id' });
    return;
  }
  const parsed = mergeSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  if (parsed.data.into_client_id === req.params.id) {
    res.status(400).json({ error: 'cannot_merge_into_self' });
    return;
  }
  const source = await findAttachableClient(req.params.id);
  const target = await findAttachableClient(parsed.data.into_client_id);
  if (!source || !target) {
    res.status(404).json({ error: 'not_found', detail: 'source or target missing/merged' });
    return;
  }
  await getDb().transaction(async (tx) => {
    await tx
      .update(clients)
      .set({ merged_into_id: target.id, updated_at: new Date() })
      .where(eq(clients.id, source.id));
    await tx.update(chats).set({ client_id: target.id }).where(eq(chats.client_id, source.id));
    // TP-11 retention (FINAL): archives follow the surviving record.
    await tx
      .update(research_archives)
      .set({ client_id: target.id })
      .where(eq(research_archives.client_id, source.id));
    // Plans follow too — otherwise they strand on the hidden merged
    // record, and their research-link candidates (scoped to the plan's
    // client) can never match the just-re-pointed archives again.
    // Deliverables and engagements ride along via plan_id.
    await tx.update(plans).set({ client_id: target.id }).where(eq(plans.client_id, source.id));
    // TP-3a — fact patterns and source documents follow the survivor.
    // If BOTH sides have a current fact pattern, the source's is superseded
    // first — otherwise the one-current-per-client partial unique index
    // aborts the repoint. Historical version numbers may then collide
    // across the merged lineages; history UIs order by created_at.
    const [targetCurrent] = await tx
      .select({ id: client_fact_patterns.id })
      .from(client_fact_patterns)
      .where(
        and(
          eq(client_fact_patterns.client_id, target.id),
          isNull(client_fact_patterns.superseded_at),
        ),
      )
      .limit(1);
    if (targetCurrent) {
      await tx
        .update(client_fact_patterns)
        .set({ superseded_at: new Date() })
        .where(
          and(
            eq(client_fact_patterns.client_id, source.id),
            isNull(client_fact_patterns.superseded_at),
          ),
        );
    }
    await tx
      .update(client_fact_patterns)
      .set({ client_id: target.id })
      .where(eq(client_fact_patterns.client_id, source.id));
    await tx
      .update(client_documents)
      .set({ client_id: target.id })
      .where(eq(client_documents.client_id, source.id));
  });
  await audit({
    actor_user_id: req.auth!.user_id,
    action: 'client.merge',
    target_type: 'client',
    target_id: source.id,
    metadata: { client_id: target.id, merged_client_id: source.id, merged_name: source.name },
    ip: req.ip,
  });
  res.json({ ok: true, merged_into: target.id });
});

// ── TP-3 — delete ────────────────────────────────────────────────────────
// chats.client_id is ON DELETE SET NULL so research links degrade to
// unlinked. TP-11 prepends archive reassignment (firm-level + tombstone)
// to this transaction. Deleting a client that others were merged into is
// refused — the merge trail must stay resolvable.
clientsRouter.delete('/:id', async (req, res) => {
  if (!uuidSchema.safeParse(req.params.id).success) {
    res.status(400).json({ error: 'bad_request', detail: 'invalid id' });
    return;
  }
  const db = getDb();
  const [client] = await db.select().from(clients).where(eq(clients.id, req.params.id)).limit(1);
  if (!client) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const [mergedChild] = await db
    .select({ id: clients.id })
    .from(clients)
    .where(eq(clients.merged_into_id, client.id))
    .limit(1);
  if (mergedChild) {
    res.status(409).json({ error: 'has_merged_records' });
    return;
  }
  // plans.client_id is NOT NULL / NO ACTION: a delete with plans present
  // would abort with a raw FK violation. Plans carry pinned results and
  // engagement history — they must be deliberately deleted or the client
  // merged, never silently dropped.
  const [planRow] = await db
    .select({ id: plans.id })
    .from(plans)
    .where(eq(plans.client_id, client.id))
    .limit(1);
  if (planRow) {
    res.status(409).json({ error: 'has_plans' });
    return;
  }
  // TP-11 retention (FINAL): archives are NEVER cascade-deleted. Reassign
  // to the firm-level archive with a tombstone recording the original
  // client, then delete. The FK on research_archives.client_id is NO
  // ACTION, so a delete that skipped this step would fail loudly.
  const tombstone = {
    original_client: { id: client.id, name: client.name },
    event: 'client-deleted' as const,
    actor_user_id: req.auth!.user_id,
    at: new Date().toISOString(),
  };
  // TP-3a (applied default): fact patterns and source documents are client
  // work product carrying client-derived data — they are DELETED with the
  // client (rows cascade via FK; files removed after commit), never moved
  // firm-level. The archives rule above is unchanged.
  const docRows = await db
    .select({ id: client_documents.id })
    .from(client_documents)
    .where(eq(client_documents.client_id, client.id));
  await db.transaction(async (tx) => {
    await tx
      .update(research_archives)
      .set({ client_id: null, firm_archive: true, tombstone })
      .where(eq(research_archives.client_id, client.id));
    await tx.delete(clients).where(eq(clients.id, client.id));
  });
  for (const doc of docRows) {
    try {
      await deleteClientDocumentFiles(doc.id);
    } catch (err) {
      logger.warn({ err, document_id: doc.id }, 'client delete: document file cleanup failed');
    }
  }
  await audit({
    actor_user_id: req.auth!.user_id,
    action: 'client.delete',
    target_type: 'client',
    target_id: client.id,
    metadata: { client_id: client.id, name: client.name, documents_deleted: docRows.length },
    ip: req.ip,
  });
  res.status(204).end();
});

// ── TP-3 — activity (audit slice) ────────────────────────────────────────
// Convention: every client-touching audit() call carries client_id in
// metadata, so one query covers direct actions and side effects alike.
clientsRouter.get('/:id/activity', async (req, res) => {
  if (!uuidSchema.safeParse(req.params.id).success) {
    res.status(400).json({ error: 'bad_request', detail: 'invalid id' });
    return;
  }
  const rows = await getDb()
    .select()
    .from(audit_log)
    .where(
      or(
        and(eq(audit_log.target_type, 'client'), eq(audit_log.target_id, req.params.id)),
        sql`${audit_log.metadata}->>'client_id' = ${req.params.id}`,
      ),
    )
    .orderBy(desc(audit_log.occurred_at))
    .limit(100);
  res.json({ activity: rows });
});
