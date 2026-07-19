// TP-2 — client records API (local-only in this slice). Every route is
// behind the planning flag: with the module off these endpoints are
// indistinguishable from not existing.
import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, ilike, isNull, or, sql, count } from 'drizzle-orm';
import { getDb } from '@vibe/db';
import { clients, chats, audit_log } from '@vibe/db/schema';
import { requireAuth } from '../../middleware/auth.js';
import { requirePlanning } from '../../middleware/planning-flag.js';
import { audit } from '../../lib/audit.js';

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
    res.json({ clients: [] });
    return;
  }
  const rows = await getDb()
    .select()
    .from(clients)
    .where(and(isNull(clients.merged_into_id), ilike(clients.name, `%${q}%`)))
    .orderBy(clients.name)
    .limit(50);
  res.json({ clients: rows });
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
  res.json({
    client,
    counts: {
      chats: chatCount?.n ?? 0,
      // Populated by later phases: plans (TP-8), archives (TP-11),
      // documents (TP-9).
      plans: 0,
      archives: 0,
      documents: 0,
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
  await db.delete(clients).where(eq(clients.id, client.id));
  await audit({
    actor_user_id: req.auth!.user_id,
    action: 'client.delete',
    target_type: 'client',
    target_id: client.id,
    metadata: { client_id: client.id, name: client.name },
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
