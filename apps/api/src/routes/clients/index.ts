// TP-2 — client records API (local-only in this slice). Every route is
// behind the planning flag: with the module off these endpoints are
// indistinguishable from not existing.
import { Router } from 'express';
import { z } from 'zod';
import { and, eq, ilike, isNull } from 'drizzle-orm';
import { getDb } from '@vibe/db';
import { clients } from '@vibe/db/schema';
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
