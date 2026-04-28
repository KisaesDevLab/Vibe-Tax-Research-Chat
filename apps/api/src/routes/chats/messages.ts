// Phase 14 + 15 + 17 — streaming message endpoint with SSE.
//
// Server flow:
//   1. Persist the user message.
//   2. Resolve attached skills (Phase 11 routing).
//   3. Open Anthropic stream (Phase 12 chat helper).
//   4. Forward deltas as SSE events.
//   5. On 'tool_use' / 'tool_result': persist primary_source_consultations (Phase 17).
//   6. On 'message_stop': persist assistant message + cost (Phase 15) + usage_event (Phase 24).
import { Router } from 'express';
import { z } from 'zod';
import { eq, asc } from 'drizzle-orm';
import { getDb } from '@vibe/db';
import {
  chats,
  messages,
  primary_source_consultations,
  models,
  skills as skillsTable,
  custom_skills,
  usage_events,
  SETTING_KEYS,
} from '@vibe/db/schema';
import { requireAuth } from '../../middleware/auth.js';
import { streamChat, buildSystemPrompt } from '../../lib/anthropic/chat.js';
import { selectSkills } from '@vibe/shared';
import { computeCost } from '../../lib/cost/calc.js';
import { getSetting } from '../../lib/settings-store.js';
import { logger } from '../../lib/logger.js';
import { extractAuthorities, decorateVerification } from '../../lib/parsing/authorities.js';
import { extractCompliance } from '../../lib/parsing/compliance.js';
import { chatTitleQueue } from '../../jobs/queues.js';
import { checkSpendCap } from '../../lib/spend-cap.js';

export const messagesRouter = Router({ mergeParams: true });
messagesRouter.use(requireAuth);

const sendSchema = z.object({
  content: z.string().min(1),
  model_id: z.string().optional(),
});

interface MergedParams {
  id: string;
}

messagesRouter.post('/', async (req, res) => {
  const parsed = sendSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  const chatId = (req.params as unknown as MergedParams).id;
  const db = getDb();

  // Auth: chat must belong to caller (or admin).
  const [chat] = await db.select().from(chats).where(eq(chats.id, chatId)).limit(1);
  if (!chat || (chat.user_id !== req.auth!.user_id && req.auth!.role !== 'admin')) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  // Phase 4 — spend cap enforcement (against the chat OWNER, not the actor).
  const block = await checkSpendCap(chat.user_id);
  if (block) {
    res.status(402).json({
      error: 'spend_cap_exceeded',
      cap_usd: block.cap_usd,
      mtd_usd: block.mtd_usd,
    });
    return;
  }

  // 1. Persist user message
  const [userMsg] = await db
    .insert(messages)
    .values({ chat_id: chatId, role: 'user', content: parsed.data.content })
    .returning({ id: messages.id });

  // 2. Resolve model
  const defaultModelId =
    chat.default_model_id ??
    (await getSetting<string>(SETTING_KEYS.DEFAULT_MODEL_ID)) ??
    'claude-sonnet-4-6';
  const modelId = parsed.data.model_id ?? defaultModelId;
  const [model] = await db.select().from(models).where(eq(models.model_id, modelId)).limit(1);
  if (!model) {
    res.status(400).json({ error: 'unknown_model', model_id: modelId });
    return;
  }

  // 3. Resolve attached skills (heuristic routing)
  const allSkills = await db.select().from(skillsTable).where(eq(skillsTable.is_active, true));
  const allCustom = await db.select().from(custom_skills).where(eq(custom_skills.is_active, true));
  const route = selectSkills({
    message: parsed.data.content,
    available: allSkills.map((s) => ({
      local_slug: s.local_slug,
      routing_keywords: s.routing_keywords,
    })),
    custom: allCustom.map((c) => ({ local_slug: c.name, routing_keywords: c.routing_keywords })),
  });
  const skillSlugToId = new Map<string, string>();
  for (const s of allSkills) skillSlugToId.set(s.local_slug, s.skill_id);
  for (const c of allCustom)
    if (c.anthropic_skill_id) skillSlugToId.set(c.name, c.anthropic_skill_id);
  const attached_skill_ids = route.slugs
    .map((slug) => skillSlugToId.get(slug))
    .filter(Boolean) as string[];

  // 4. History
  const history = await db
    .select({ role: messages.role, content: messages.content })
    .from(messages)
    .where(eq(messages.chat_id, chatId))
    .orderBy(asc(messages.created_at));

  // SSE setup. The X-Accel-Buffering header tells nginx (and any well-
  // behaved reverse proxy / Vite-style dev proxy) to disable response
  // buffering for this response, so each SSE write flushes immediately
  // instead of pooling into 8/16/32KB chunks. We also call res.flush()
  // after every write — `compression` exposes that method when it owns
  // the response, and Express's plain ServerResponse exposes it too on
  // recent Node versions. The combination keeps deltas reaching the
  // browser in real time even if the compression filter for SSE were
  // ever to slip back on.
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  const flush = (res as unknown as { flush?: () => void }).flush;
  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    if (typeof flush === 'function') flush.call(res);
  };

  // Heartbeat: send a comment line every 15 s so the connection stays
  // open through any idle timeouts and the browser's `EventSource`-like
  // reader doesn't think the request stalled. SSE comment lines start
  // with `:` and are ignored by the client.
  const heartbeat = setInterval(() => {
    if (res.writableEnded) return;
    res.write(`: keepalive ${Date.now()}\n\n`);
    if (typeof flush === 'function') flush.call(res);
  }, 15000);
  res.on('close', () => clearInterval(heartbeat));
  res.on('finish', () => clearInterval(heartbeat));

  // Trigger streaming
  let assistantText = '';
  const toolUses = new Map<string, { tool_name: string; input: unknown }>();
  const consultations: Array<{
    tool_name: string;
    url?: string;
    query?: string;
    domain?: string;
    response_status?: number;
    response_excerpt?: string;
  }> = [];

  try {
    const stream = streamChat({
      chat_id: chatId,
      user_message: parsed.data.content,
      system_prompt: buildSystemPrompt({}),
      model_id: modelId,
      attached_skill_ids,
      enable_web_tools: model.web_tools_enabled,
      fetches_per_turn: Number(model.fetches_per_turn),
      searches_per_turn: Number(model.searches_per_turn),
      history: history
        .filter((h) => h.role === 'user' || h.role === 'assistant')
        .map((h) => ({ role: h.role as 'user' | 'assistant', content: h.content })),
    });

    for await (const ev of stream) {
      switch (ev.type) {
        case 'text_delta':
          assistantText += ev.delta;
          send('text', { delta: ev.delta });
          break;
        case 'tool_use':
          toolUses.set(ev.id, { tool_name: ev.tool_name, input: ev.input });
          send('tool_use', { id: ev.id, tool_name: ev.tool_name, input: ev.input });
          // Phase 17 — capture for primary_source_consultations
          if (ev.tool_name === 'web_fetch') {
            const url = (ev.input as { url?: string }).url;
            consultations.push({
              tool_name: 'web_fetch',
              url,
              domain: url ? new URL(url).hostname : undefined,
            });
          } else if (ev.tool_name === 'web_search') {
            const query = (ev.input as { query?: string }).query;
            consultations.push({ tool_name: 'web_search', query });
          }
          break;
        case 'tool_result': {
          const tu = toolUses.get(ev.tool_use_id);
          send('tool_result', { id: ev.tool_use_id, status: ev.status });
          if (tu) {
            const last = consultations[consultations.length - 1];
            if (last) {
              last.response_status = ev.status === 'error' ? 500 : 200;
              last.response_excerpt =
                typeof ev.result === 'string'
                  ? ev.result.slice(0, 2048)
                  : JSON.stringify(ev.result).slice(0, 2048);
            }
          }
          break;
        }
        case 'usage':
          send('usage', ev.usage);
          break;
        case 'message_stop': {
          // Persist assistant message + cost
          const cost = computeCost(
            {
              input_tokens: ev.usage.input_tokens,
              output_tokens: ev.usage.output_tokens,
              cache_creation_input_tokens: ev.usage.cache_creation_input_tokens,
              cache_read_input_tokens: ev.usage.cache_read_input_tokens,
              web_fetch_calls: ev.usage.web_fetch_calls,
              web_search_calls: ev.usage.web_search_calls,
            },
            {
              model_id: model.model_id,
              display_name: model.display_name,
              input_per_mtok: Number(model.input_per_mtok),
              output_per_mtok: Number(model.output_per_mtok),
              cache_write_per_mtok: Number(model.cache_write_per_mtok),
              cache_read_per_mtok: Number(model.cache_read_per_mtok),
              tokenizer_factor: Number(model.tokenizer_factor),
              web_fetch_unit_cost: Number(model.web_fetch_unit_cost),
              web_search_unit_cost: Number(model.web_search_unit_cost),
              is_active: model.is_active,
              retired_at: model.retired_at?.toISOString() ?? null,
            },
          );

          // Phase 18 + 19 — extract sidecar JSON before persisting.
          const rawAuthorities = extractAuthorities(assistantText);
          const authorities = decorateVerification(
            rawAuthorities,
            consultations.map((c) => ({ url: c.url, domain: c.domain })),
          );
          const compliance = extractCompliance(assistantText);

          const [assistantMsg] = await db
            .insert(messages)
            .values({
              chat_id: chatId,
              role: 'assistant',
              content: assistantText,
              model_id: modelId,
              stop_reason: ev.stop_reason,
              attached_skill_ids,
              attached_skill_versions: allSkills
                .filter((s) => attached_skill_ids.includes(s.skill_id))
                .map((s) => s.current_version),
              input_tokens: ev.usage.input_tokens,
              output_tokens: ev.usage.output_tokens,
              cache_creation_input_tokens: ev.usage.cache_creation_input_tokens,
              cache_read_input_tokens: ev.usage.cache_read_input_tokens,
              web_fetch_calls: ev.usage.web_fetch_calls,
              web_search_calls: ev.usage.web_search_calls,
              cost_usd: cost.total_usd.toFixed(6),
              authorities: authorities as unknown as Record<string, unknown>[],
              compliance_check: (compliance ?? null) as Record<string, unknown> | null,
            })
            .returning({ id: messages.id });

          // Phase 17 — flush consultations, marking those whose URL appears
          // in the authorities sidecar.
          if (assistantMsg && consultations.length > 0) {
            const citedUrls = new Set(authorities.map((a) => a.source).filter(Boolean));
            await db.insert(primary_source_consultations).values(
              consultations.map((c) => ({
                message_id: assistantMsg.id,
                tool_name: c.tool_name,
                url: c.url ?? null,
                query: c.query ?? null,
                domain: c.domain ?? null,
                response_status: c.response_status ?? null,
                response_excerpt: c.response_excerpt ?? null,
                cited_in_authorities: c.url ? citedUrls.has(c.url) : false,
              })),
            );
          }

          // Phase 24 — usage_events
          if (assistantMsg) {
            await db.insert(usage_events).values({
              user_id: chat.user_id,
              chat_id: chatId,
              message_id: assistantMsg.id,
              model_id: modelId,
              input_tokens: ev.usage.input_tokens,
              output_tokens: ev.usage.output_tokens,
              cache_creation_input_tokens: ev.usage.cache_creation_input_tokens,
              cache_read_input_tokens: ev.usage.cache_read_input_tokens,
              web_fetch_calls: ev.usage.web_fetch_calls,
              web_search_calls: ev.usage.web_search_calls,
              cost_usd: cost.total_usd.toFixed(6),
            });
          }

          // Phase 13 — auto-title the chat once we've had the first
          // assistant turn (i.e., the chat is still "Untitled chat").
          if (chat.title === 'Untitled chat' && assistantMsg) {
            await chatTitleQueue.add('title', { chat_id: chatId });
          }

          send('done', {
            user_message_id: userMsg!.id,
            assistant_message_id: assistantMsg?.id,
            stop_reason: ev.stop_reason,
            cost: cost.total_usd,
            usage: ev.usage,
            authorities,
            compliance_check: compliance,
          });
          res.end();
          return;
        }
      }
    }
  } catch (err) {
    logger.error({ err, chatId }, 'streamChat failed');
    send('error', { error: (err as Error).message });
    res.end();
  }
});
