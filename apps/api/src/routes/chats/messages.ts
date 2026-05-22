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
import { eq, asc, and } from 'drizzle-orm';
import { getDb } from '@vibe/db';
import {
  chats,
  messages,
  primary_source_consultations,
  models,
  skills as skillsTable,
  custom_skills,
  chat_attachments,
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
import {
  retrieveReferenceExcerpts,
  formatExcerptsForPrompt,
} from '../../lib/references/retrieve.js';
import { checkSpendCap } from '../../lib/spend-cap.js';
import { buildResponsePdf } from '../../lib/export/response-pdf.js';
import { buildResponseDocx } from '../../lib/export/response-docx.js';
import { buildResponseXlsx } from '../../lib/export/response-xlsx.js';

export const messagesRouter = Router({ mergeParams: true });
messagesRouter.use(requireAuth);

// Concatenate the canonical system prompt with optional add-ons, dropping
// empties so a chat with no attachments and no firm references still
// produces clean output (no dangling separator lines).
function assembleSystemPrompt(base: string, attachments: string, references: string): string {
  return [base, attachments, references].filter((s) => s && s.trim().length > 0).join('\n\n');
}

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

  // 1. Resolve model
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
  // A chat may have pinned a model (chat.default_model_id) or an admin may
  // have disabled the global default after it was saved — refuse here with
  // a clear error rather than letting a 401-from-Anthropic surface as a
  // generic stream failure.
  if (!model.is_active) {
    res.status(400).json({ error: 'inactive_model', model_id: modelId });
    return;
  }

  // 2. Resolve attached skills (heuristic routing)
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

  // 3. History — fetched BEFORE persisting the new user message so the
  // streamChat call can append the new turn cleanly. If we queried after
  // the insert, `history` would already contain the new user message and
  // chat.ts would duplicate it — Anthropic's Messages API rejects two
  // consecutive identical user messages (silently 400 in simple cases,
  // 500 api_error when combined with container.skills + web tools).
  const history = await db
    .select({ role: messages.role, content: messages.content })
    .from(messages)
    .where(eq(messages.chat_id, chatId))
    .orderBy(asc(messages.created_at));

  // 4. Persist the new user message. ID is captured so the lifecycle
  // log + final 'done' SSE event can reference it.
  const [userMsg] = await db
    .insert(messages)
    .values({ chat_id: chatId, role: 'user', content: parsed.data.content })
    .returning({ id: messages.id });

  // 4b. Attachment context. Pull the chat's attachments and build a
  // preamble that sits at the top of the system prompt. Prefer the
  // Haiku-generated summary when ready (compact, costs few tokens);
  // fall back to a per-document text excerpt while the summarize
  // worker is still catching up. The preamble is bounded so a chat
  // with many large documents can't blow past the model's input
  // budget.
  const attachmentRows = await db
    .select({
      id: chat_attachments.id,
      filename: chat_attachments.filename,
      mime_type: chat_attachments.mime_type,
      summary: chat_attachments.summary,
      full_text: chat_attachments.full_text,
    })
    .from(chat_attachments)
    .where(eq(chat_attachments.chat_id, chatId))
    .orderBy(asc(chat_attachments.created_at));
  const ATTACHMENT_PER_DOC_CHARS = 60_000;
  const ATTACHMENT_TOTAL_CHARS = 180_000;
  const attachmentPreamble = (() => {
    if (attachmentRows.length === 0) return '';
    const parts: string[] = [
      'The user has attached the following document(s) to this chat. Treat them as primary context the user has shared with you. When the user references "the attached document", "the file", "the PDF", etc., it means the documents below. Quote them verbatim when accuracy matters; cite by filename.',
      '',
    ];
    let total = 0;
    for (const a of attachmentRows) {
      const body = (a.summary && a.summary.trim().length > 0 ? a.summary : (a.full_text ?? ''))
        .toString()
        .trim();
      if (!body) {
        parts.push(`<document filename="${a.filename}" type="${a.mime_type}">`);
        parts.push('[Empty or unparseable — likely a scanned image without OCR.]');
        parts.push('</document>');
        parts.push('');
        continue;
      }
      const remainingBudget = Math.max(0, ATTACHMENT_TOTAL_CHARS - total);
      if (remainingBudget < 200) {
        parts.push(
          `<document filename="${a.filename}">[Skipped — earlier documents filled the context budget.]</document>`,
        );
        parts.push('');
        continue;
      }
      const cap = Math.min(ATTACHMENT_PER_DOC_CHARS, remainingBudget);
      const slice = body.length > cap ? `${body.slice(0, cap)}\n\n[…truncated]` : body;
      total += slice.length;
      parts.push(`<document filename="${a.filename}" type="${a.mime_type}">`);
      parts.push(slice);
      parts.push('</document>');
      parts.push('');
    }
    return parts.join('\n');
  })();

  // Phase 32 — firm reference library retrieval. Best-effort: if Voyage
  // is unreachable or the index is empty, the chat proceeds without
  // excerpts. The per-chat toggle (chat.use_reference_library) lets a
  // researcher disable the library for memo-writing turns where they
  // want primary-authority-only.
  const referenceExcerpts = chat.use_reference_library
    ? await retrieveReferenceExcerpts(parsed.data.content)
    : [];
  const referenceBlock = formatExcerptsForPrompt(referenceExcerpts);

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
  let completed = false;
  const toolUses = new Map<string, { tool_name: string; input: unknown }>();
  const consultations: Array<{
    tool_name: string;
    url?: string;
    query?: string;
    domain?: string;
    response_status?: number;
    response_excerpt?: string;
  }> = [];

  // If the client connection drops before message_stop fires, persist
  // whatever text we've already streamed plus a system_note explaining
  // the abort. Without this the chat shows the user message with no
  // reply at all (the SSE error event was sent but the client navigated
  // away before reading it, and the assistant row was never written).
  // The handler runs once and is no-op if the request completed
  // normally.
  req.on('close', async () => {
    if (completed) return;
    completed = true;
    clearInterval(heartbeat);
    try {
      await db.transaction(async (tx) => {
        if (assistantText.length > 0) {
          await tx.insert(messages).values({
            chat_id: chatId,
            role: 'assistant',
            content: assistantText,
            model_id: modelId,
            stop_reason: 'aborted',
            attached_skill_ids,
            attached_skill_versions: [],
          });
        }
        await tx.insert(messages).values({
          chat_id: chatId,
          role: 'system_note',
          content:
            assistantText.length > 0
              ? '⚠ Connection lost mid-response — the partial answer above was saved. Re-send your question to get a complete reply.'
              : '⚠ Connection lost before the assistant could reply. Re-send your question to retry.',
        });
      });
      logger.warn(
        { chatId, partial_chars: assistantText.length },
        'stream aborted — partial saved',
      );
    } catch (err) {
      logger.error({ err, chatId }, 'failed to persist aborted-stream partial');
    }
  });

  // Lifecycle log: stream start. Logging at this point captures the
  // chat / user / model + skill set so we can correlate later events
  // when triaging "no reply" reports.
  logger.info(
    {
      chat_id: chatId,
      user_id: req.auth!.user_id,
      user_msg_id: userMsg!.id,
      model_id: modelId,
      attached_skill_count: attached_skill_ids.length,
      attached_doc_count: attachmentRows.length,
      attached_doc_chars: attachmentPreamble.length,
      message_chars: parsed.data.content.length,
    },
    'stream start',
  );

  try {
    const stream = streamChat({
      chat_id: chatId,
      user_message: parsed.data.content,
      system_prompt: assembleSystemPrompt(
        buildSystemPrompt({}),
        attachmentPreamble,
        referenceBlock,
      ),
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
          logger.debug(
            { chat_id: chatId, tool_name: ev.tool_name, tool_use_id: ev.id },
            'stream tool_use',
          );
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
          // Race protection: if req.on('close') already fired (because
          // the client navigated away just as message_stop arrived) the
          // partial-save path may already be running; don't double-INSERT.
          if (completed) {
            logger.warn({ chat_id: chatId }, 'message_stop after completed=true; skipping');
            return;
          }
          completed = true;
          logger.info(
            {
              chat_id: chatId,
              stop_reason: ev.stop_reason,
              chars: assistantText.length,
              tool_uses: toolUses.size,
              consultations: consultations.length,
            },
            'stream message_stop',
          );
          // Persist assistant message + cost. NaN-guard every numeric
          // field so a row with bad rate data doesn't blow up the
          // INSERT (numeric columns reject NaN and the whole turn
          // would vanish, leaving a "no reply" thread).
          const safeNum = (v: unknown, fallback = 0): number => {
            const n = Number(v);
            return Number.isFinite(n) ? n : fallback;
          };
          const cost = computeCost(
            {
              input_tokens: safeNum(ev.usage.input_tokens),
              output_tokens: safeNum(ev.usage.output_tokens),
              cache_creation_input_tokens: safeNum(ev.usage.cache_creation_input_tokens),
              cache_read_input_tokens: safeNum(ev.usage.cache_read_input_tokens),
              web_fetch_calls: safeNum(ev.usage.web_fetch_calls),
              web_search_calls: safeNum(ev.usage.web_search_calls),
            },
            {
              model_id: model.model_id,
              display_name: model.display_name,
              input_per_mtok: safeNum(model.input_per_mtok),
              output_per_mtok: safeNum(model.output_per_mtok),
              cache_write_per_mtok: safeNum(model.cache_write_per_mtok),
              cache_read_per_mtok: safeNum(model.cache_read_per_mtok),
              tokenizer_factor: safeNum(model.tokenizer_factor, 1),
              web_fetch_unit_cost: safeNum(model.web_fetch_unit_cost),
              web_search_unit_cost: safeNum(model.web_search_unit_cost),
              is_active: model.is_active,
              retired_at: model.retired_at?.toISOString() ?? null,
            },
          );
          const finalCost = Number.isFinite(cost.total_usd) ? cost.total_usd : 0;

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
              cost_usd: finalCost.toFixed(6),
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
              cost_usd: finalCost.toFixed(6),
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
            cost: finalCost,
            usage: ev.usage,
            authorities,
            compliance_check: compliance,
          });
          res.end();
          return;
        }
      }
    }
    // Defensive: the for-await loop exited cleanly but message_stop
    // never fired. The Anthropic stream sometimes ends without a
    // terminating message_stop (e.g., upstream connection reset, an
    // SDK iterator quirk on certain tool_use sequences). Without this
    // branch the assistant row never gets persisted, the SSE 'done'
    // event never fires, and the client UI hangs on "Drafting answer".
    if (!completed) {
      completed = true;
      logger.warn(
        { chat_id: chatId, partial_chars: assistantText.length },
        'stream ended without message_stop — persisting partial',
      );
      try {
        await db.transaction(async (tx) => {
          if (assistantText.length > 0) {
            await tx.insert(messages).values({
              chat_id: chatId,
              role: 'assistant',
              content: assistantText,
              model_id: modelId,
              stop_reason: 'incomplete',
              attached_skill_ids,
              attached_skill_versions: [],
            });
          }
          await tx.insert(messages).values({
            chat_id: chatId,
            role: 'system_note',
            content:
              assistantText.length > 0
                ? '⚠ Stream ended without a final stop signal — the partial answer above was saved. Re-send your question to get a complete reply.'
                : '⚠ The assistant stream ended before any text was produced. Re-send your question to retry.',
          });
        });
      } catch (writeErr) {
        logger.error({ err: writeErr, chatId }, 'failed to persist incomplete-stream partial');
      }
      send('done', {
        user_message_id: userMsg!.id,
        assistant_message_id: undefined,
        stop_reason: 'incomplete',
        cost: 0,
        usage: {},
        authorities: [],
        compliance_check: null,
      });
      res.end();
    }
  } catch (err) {
    // Mark completed so the req.on('close') handler doesn't ALSO try to
    // persist a partial — the streamChat error path already wrote (or
    // will write) the user-facing error event, and the user will see
    // the assistant block missing from the chat history. Also write a
    // system_note so the failure surfaces in the chat instead of being
    // silently dropped on next refetch.
    completed = true;
    logger.error({ err, chatId }, 'streamChat failed');
    send('error', { error: (err as Error).message });
    try {
      await db.insert(messages).values({
        chat_id: chatId,
        role: 'system_note',
        content: `⚠ The assistant could not complete this turn: ${(err as Error).message.slice(0, 400)}`,
      });
    } catch (writeErr) {
      logger.error({ err: writeErr, chatId }, 'failed to persist stream-error system_note');
    }
    res.end();
  }
});

// ── PDF export ────────────────────────────────────────────────────────────
// GET /api/chats/:id/messages/:messageId/pdf
// Returns a real, selectable-text PDF built server-side via PDFKit. We
// switched from client-side html2canvas/jsPDF to server rendering after
// repeated formatting failures (Unicode glyphs, mid-line page breaks,
// CSS context loss in offscreen clones). PDFKit's deterministic text
// engine and built-in Helvetica metrics produce a clean, archivable
// document every time.
const pdfParamsSchema = z.object({
  messageId: z.string().uuid(),
});

messagesRouter.get('/:messageId/pdf', async (req, res) => {
  const chatId = (req.params as unknown as MergedParams).id;
  const parsed = pdfParamsSchema.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  const db = getDb();
  // Owner-or-admin scope on the chat (mirrors GET /api/chats/:id).
  const [chat] = await db.select().from(chats).where(eq(chats.id, chatId)).limit(1);
  if (!chat || (chat.user_id !== req.auth!.user_id && req.auth!.role !== 'admin')) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const [m] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.id, parsed.data.messageId), eq(messages.chat_id, chatId)))
    .limit(1);
  if (!m || m.role !== 'assistant') {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  let buf: Buffer;
  try {
    buf = await buildResponsePdf({
      id: m.id,
      created_at: m.created_at,
      content: m.content,
      model_id: m.model_id,
      cost_usd: m.cost_usd,
      authorities: m.authorities,
      compliance_check: m.compliance_check,
    });
  } catch (err) {
    logger.error({ err, message_id: m.id }, 'pdf generation failed');
    res.status(500).json({ error: 'pdf_generation_failed', detail: (err as Error).message });
    return;
  }

  const stamp = m.created_at.toISOString().slice(0, 10);
  const slug = m.id.slice(0, 8);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="vibe-tax-research-${stamp}-${slug}.pdf"`,
  );
  res.setHeader('Content-Length', String(buf.byteLength));
  res.end(buf);
});

// ── DOCX export ───────────────────────────────────────────────────────────
// GET /api/chats/:id/messages/:messageId/docx
// Same auth/scope/error semantics as the PDF route. Builds a Word
// document via the `docx` library — useful for clients who want to
// edit the assistant's draft (engagement letters, memos) before
// sending. DOCX uses native Unicode so the WinAnsi-fallback dance the
// PDF path needs (box-drawing chars, emoji) doesn't apply here.
messagesRouter.get('/:messageId/docx', async (req, res) => {
  const chatId = (req.params as unknown as MergedParams).id;
  const parsed = pdfParamsSchema.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  const db = getDb();
  const [chat] = await db.select().from(chats).where(eq(chats.id, chatId)).limit(1);
  if (!chat || (chat.user_id !== req.auth!.user_id && req.auth!.role !== 'admin')) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const [m] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.id, parsed.data.messageId), eq(messages.chat_id, chatId)))
    .limit(1);
  if (!m || m.role !== 'assistant') {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  let buf: Buffer;
  try {
    buf = await buildResponseDocx({
      id: m.id,
      created_at: m.created_at,
      content: m.content,
      model_id: m.model_id,
      cost_usd: m.cost_usd,
      authorities: m.authorities,
      compliance_check: m.compliance_check,
    });
  } catch (err) {
    logger.error({ err, message_id: m.id }, 'docx generation failed');
    res.status(500).json({ error: 'docx_generation_failed', detail: (err as Error).message });
    return;
  }

  const stamp = m.created_at.toISOString().slice(0, 10);
  const slug = m.id.slice(0, 8);
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  );
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="vibe-tax-research-${stamp}-${slug}.docx"`,
  );
  res.setHeader('Content-Length', String(buf.byteLength));
  res.end(buf);
});

// ── XLSX export ───────────────────────────────────────────────────────────
// GET /api/chats/:id/messages/:messageId/xlsx
// Same auth/scope/error semantics as the PDF / DOCX routes. The
// excel-workpaper-builder skill emits a `workpaper_data` object inside
// its JSON sidecar; the buildResponseXlsx helper extracts that payload
// and renders a styled calculation worksheet (headers, tickmarks,
// formula support, footed totals, legend / sources / notes). When the
// message lacks structured workpaper_data (e.g., the user clicked
// Download XLSX on an ordinary memo), the builder emits a single-sheet
// prose dump so the button is never broken.
messagesRouter.get('/:messageId/xlsx', async (req, res) => {
  const chatId = (req.params as unknown as MergedParams).id;
  const parsed = pdfParamsSchema.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  const db = getDb();
  const [chat] = await db.select().from(chats).where(eq(chats.id, chatId)).limit(1);
  if (!chat || (chat.user_id !== req.auth!.user_id && req.auth!.role !== 'admin')) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const [m] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.id, parsed.data.messageId), eq(messages.chat_id, chatId)))
    .limit(1);
  if (!m || m.role !== 'assistant') {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  let buf: Buffer;
  try {
    buf = await buildResponseXlsx({
      id: m.id,
      created_at: m.created_at,
      content: m.content,
      model_id: m.model_id,
      cost_usd: m.cost_usd,
      authorities: m.authorities,
      compliance_check: m.compliance_check,
    });
  } catch (err) {
    logger.error({ err, message_id: m.id }, 'xlsx generation failed');
    res.status(500).json({ error: 'xlsx_generation_failed', detail: (err as Error).message });
    return;
  }

  const stamp = m.created_at.toISOString().slice(0, 10);
  const slug = m.id.slice(0, 8);
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="vibe-tax-research-${stamp}-${slug}.xlsx"`,
  );
  res.setHeader('Content-Length', String(buf.byteLength));
  res.end(buf);
});
