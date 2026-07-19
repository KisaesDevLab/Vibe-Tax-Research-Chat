// Phase 13 — chat CRUD; messages router mounted under /:id/messages.
import { Router } from 'express';
import { z } from 'zod';
import { eq, and, desc, asc, inArray } from 'drizzle-orm';
import { getDb } from '@vibe/db';
import { chats, messages, skills as skillsTable, custom_skills } from '@vibe/db/schema';
import { requireAuth } from '../../middleware/auth.js';
import { audit } from '../../lib/audit.js';
import { messagesRouter } from './messages.js';
import { attachmentsRouter } from './attachments.js';
import { findAttachableClient } from '../clients/index.js';
import { chatArchiveRouter } from '../archives.js';
import type { SkillAttribution } from '@vibe/shared';

// Identifiers the SPA's SkillsPanel uses to colour the chip — kept here
// rather than on the row because they're routing/role markers, not
// configuration. If new dispatcher-class skills land, add them here.
const DISPATCHER_SLUGS = new Set(['cpa-pack-index']);
const COMPLIANCE_SLUGS = new Set(['compliance-ssts-circular230']);

export const chatsRouter = Router();
chatsRouter.use(requireAuth);

const uuidSchema = z.string().uuid();

const createSchema = z.object({
  title: z.string().max(200).optional(),
  default_model_id: z.string().nullable().optional(),
  // TP-2 — soft link from the active-client chip. Optional and never
  // required for research.
  client_id: z.string().uuid().nullable().optional(),
});

chatsRouter.post('/', async (req, res) => {
  const parsed = createSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  if (parsed.data.client_id) {
    const client = await findAttachableClient(parsed.data.client_id);
    if (!client) {
      res.status(400).json({ error: 'unknown_or_merged_client' });
      return;
    }
  }
  const inserted = await getDb()
    .insert(chats)
    .values({
      user_id: req.auth!.user_id,
      title: parsed.data.title ?? 'Untitled chat',
      default_model_id: parsed.data.default_model_id ?? null,
      client_id: parsed.data.client_id ?? null,
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
  if (!uuidSchema.safeParse(req.params.id).success) {
    res.status(400).json({ error: 'bad_request', detail: 'invalid id' });
    return;
  }
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
  // Hydrate the SkillAttribution[] the SPA's SkillsPanel renders. The
  // messages row only stores raw skill_ids + versions captured at send
  // time — without this projection the panel always sees `undefined`
  // and renders nothing, even though the routing did happen and the
  // ids are persisted. Pull both pack skills and custom skills, since
  // attached_skill_ids on a single row can mix the two.
  const allAttachedIds = Array.from(
    new Set(msgs.flatMap((m) => (m.attached_skill_ids ?? []) as string[])),
  );
  type SkillsLookup = Map<string, Omit<SkillAttribution, 'version'> & { default_version: string }>;
  const skillsLookup: SkillsLookup = new Map();
  if (allAttachedIds.length > 0) {
    const packRows = await db
      .select()
      .from(skillsTable)
      .where(inArray(skillsTable.skill_id, allAttachedIds));
    for (const s of packRows) {
      skillsLookup.set(s.skill_id, {
        skill_id: s.skill_id,
        local_slug: s.local_slug,
        display_name: s.display_name,
        always_attached: s.is_always_attached,
        is_dispatcher: DISPATCHER_SLUGS.has(s.local_slug),
        is_compliance: COMPLIANCE_SLUGS.has(s.local_slug),
        default_version: s.current_version,
      });
    }
    const customRows = await db
      .select()
      .from(custom_skills)
      .where(inArray(custom_skills.anthropic_skill_id, allAttachedIds));
    for (const c of customRows) {
      if (!c.anthropic_skill_id) continue;
      skillsLookup.set(c.anthropic_skill_id, {
        skill_id: c.anthropic_skill_id,
        local_slug: c.name,
        display_name: c.display_name,
        always_attached: c.is_always_attached,
        is_dispatcher: false,
        is_compliance: false,
        default_version: c.anthropic_skill_version ?? '?',
      });
    }
  }

  // The DB stores token + cost columns flat on the messages row, but the
  // wire format the SPA expects (MessageDTO) carries them under `usage`
  // for the CostLedger to read. Project here.
  const dto = msgs.map((m) => {
    const ids = (m.attached_skill_ids ?? []) as string[];
    const versions = (m.attached_skill_versions ?? []) as string[];
    const skillsForMsg: SkillAttribution[] = ids
      .map((id, idx) => {
        const meta = skillsLookup.get(id);
        if (!meta) return null;
        return {
          skill_id: meta.skill_id,
          local_slug: meta.local_slug,
          display_name: meta.display_name,
          always_attached: meta.always_attached,
          is_dispatcher: meta.is_dispatcher,
          is_compliance: meta.is_compliance,
          // Prefer the version captured at send-time (frozen against
          // mid-flight pack updates); fall back to the row's current
          // version when send-time wasn't recorded.
          version: versions[idx] ?? meta.default_version,
        } satisfies SkillAttribution;
      })
      .filter((x): x is SkillAttribution => x !== null);

    return {
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
      skills: m.role === 'assistant' && skillsForMsg.length > 0 ? skillsForMsg : undefined,
    };
  });
  res.json({ chat, messages: dto });
});

const patchSchema = z.object({
  title: z.string().max(200).optional(),
  archived: z.boolean().optional(),
  pinned_pack_version: z.string().nullable().optional(),
  default_model_id: z.string().nullable().optional(),
  pii_disclosure_acknowledged: z.boolean().optional(),
  use_reference_library: z.boolean().optional(),
  // TP-2 — set/clear the soft client link.
  client_id: z.string().uuid().nullable().optional(),
});

chatsRouter.patch('/:id', async (req, res) => {
  if (!uuidSchema.safeParse(req.params.id).success) {
    res.status(400).json({ error: 'bad_request', detail: 'invalid id' });
    return;
  }
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
  if (parsed.data.use_reference_library !== undefined)
    update.use_reference_library = parsed.data.use_reference_library;
  if (parsed.data.client_id !== undefined) {
    if (parsed.data.client_id !== null) {
      const client = await findAttachableClient(parsed.data.client_id);
      if (!client) {
        res.status(400).json({ error: 'unknown_or_merged_client' });
        return;
      }
    }
    update.client_id = parsed.data.client_id;
  }

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
  if (!uuidSchema.safeParse(req.params.id).success) {
    res.status(400).json({ error: 'bad_request', detail: 'invalid id' });
    return;
  }
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
chatsRouter.use('/:id/archive', chatArchiveRouter);
