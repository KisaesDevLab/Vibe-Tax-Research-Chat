// Phase 13 — chat CRUD; messages router mounted under /:id/messages.
import { Router } from 'express';
import { z } from 'zod';
import { eq, and, desc, asc } from 'drizzle-orm';
import { getDb } from '@vibe/db';
import { chats, messages } from '@vibe/db/schema';
import { requireAuth } from '../../middleware/auth.js';
import { audit } from '../../lib/audit.js';
import { messagesRouter } from './messages.js';
import { attachmentsRouter } from './attachments.js';

export const chatsRouter = Router();
chatsRouter.use(requireAuth);

const createSchema = z.object({
  title: z.string().max(200).optional(),
  default_model_id: z.string().nullable().optional(),
});

chatsRouter.post('/', async (req, res) => {
  const parsed = createSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  const inserted = await getDb()
    .insert(chats)
    .values({
      user_id: req.auth!.user_id,
      title: parsed.data.title ?? 'Untitled chat',
      default_model_id: parsed.data.default_model_id ?? null,
    })
    .returning();
  res.status(201).json({ chat: inserted[0] });
});

chatsRouter.get('/', async (req, res) => {
  const isAdmin = req.auth!.role === 'admin';
  const targetUserId =
    isAdmin && typeof req.query.user_id === 'string' ? req.query.user_id : req.auth!.user_id;
  const rows = await getDb()
    .select()
    .from(chats)
    .where(eq(chats.user_id, targetUserId))
    .orderBy(desc(chats.updated_at))
    .limit(200);
  res.json({ chats: rows });
});

// ── Authorization helper ─────────────────────────────────────────────────
// All single-chat operations are owner-scoped, EXCEPT admins who can act on
// any chat. messages.ts already follows this rule, so the chat-CRUD endpoints
// follow it too — no UI affordance reads or edits a chat the actor cannot see.
function ownerOrAdminFilter(chatId: string, userId: string, isAdmin: boolean) {
  if (isAdmin) return eq(chats.id, chatId);
  return and(eq(chats.id, chatId), eq(chats.user_id, userId));
}

chatsRouter.get('/:id', async (req, res) => {
  const db = getDb();
  const isAdmin = req.auth!.role === 'admin';
  const [chat] = await db
    .select()
    .from(chats)
    .where(ownerOrAdminFilter(req.params.id, req.auth!.user_id, isAdmin))
    .limit(1);
  if (!chat) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const msgs = await db
    .select()
    .from(messages)
    .where(eq(messages.chat_id, chat.id))
    .orderBy(asc(messages.created_at));
  // The DB stores token + cost columns flat on the messages row, but the
  // wire format the SPA expects (MessageDTO) carries them under `usage`
  // for the CostLedger to read. Project here.
  const dto = msgs.map((m) => ({
    ...m,
    cost_usd: m.cost_usd != null ? Number(m.cost_usd) : 0,
    usage:
      m.role === 'assistant'
        ? {
            input_tokens: m.input_tokens,
            output_tokens: m.output_tokens,
            cache_creation_input_tokens: m.cache_creation_input_tokens,
            cache_read_input_tokens: m.cache_read_input_tokens,
            web_fetch_calls: m.web_fetch_calls,
            web_search_calls: m.web_search_calls,
          }
        : undefined,
  }));
  res.json({ chat, messages: dto });
});

const patchSchema = z.object({
  title: z.string().max(200).optional(),
  archived: z.boolean().optional(),
  pinned_pack_version: z.string().nullable().optional(),
  default_model_id: z.string().nullable().optional(),
  pii_disclosure_acknowledged: z.boolean().optional(),
});

chatsRouter.patch('/:id', async (req, res) => {
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  const isAdmin = req.auth!.role === 'admin';
  const update: Record<string, unknown> = { updated_at: new Date() };
  if (parsed.data.title !== undefined) update.title = parsed.data.title;
  if (parsed.data.archived !== undefined)
    update.archived_at = parsed.data.archived ? new Date() : null;
  if (parsed.data.pinned_pack_version !== undefined)
    update.pinned_pack_version = parsed.data.pinned_pack_version;
  if (parsed.data.default_model_id !== undefined)
    update.default_model_id = parsed.data.default_model_id;
  if (parsed.data.pii_disclosure_acknowledged !== undefined)
    update.pii_disclosure_acknowledged = parsed.data.pii_disclosure_acknowledged;

  const where = isAdmin
    ? eq(chats.id, req.params.id)
    : and(eq(chats.id, req.params.id), eq(chats.user_id, req.auth!.user_id));
  const updated = await getDb().update(chats).set(update).where(where).returning({ id: chats.id });
  if (updated.length === 0) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.status(204).end();
});

chatsRouter.delete('/:id', async (req, res) => {
  const isAdmin = req.auth!.role === 'admin';
  const where = isAdmin
    ? eq(chats.id, req.params.id)
    : and(eq(chats.id, req.params.id), eq(chats.user_id, req.auth!.user_id));
  const deleted = await getDb().delete(chats).where(where).returning({ id: chats.id });
  if (deleted.length === 0) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  await audit({
    actor_user_id: req.auth!.user_id,
    action: 'chat.delete',
    target_type: 'chat',
    target_id: req.params.id,
    metadata: { acted_as_admin: isAdmin },
    ip: req.ip,
  });
  res.status(204).end();
});

chatsRouter.use('/:id/messages', messagesRouter);
chatsRouter.use('/:id/attachments', attachmentsRouter);
