// MIG-4 (router-option addendum, Q-063/Q-064) — Vibe AI Router driver for the
// BACKGROUND JOB seam only. The streaming chat path (betas, server tools, skills
// containers, cache breakpoints) and the strategy-watch job (Anthropic-hosted
// web_search) stay direct until router backlog item R1 ships; that split is a
// static, per-job decision — never a runtime fallback.
//
// NO silent cross-mode fallback: when VIBE_AI_MODE=router and a routable job
// fails at the router, the error surfaces to the caller's existing degrade
// logic. Quietly retrying against api.anthropic.com would ship the prompt
// around the router's scrubber and ledger.

import type Anthropic from '@anthropic-ai/sdk';
import {
  VibeAiClient,
  type ChatMessage,
  type RequestOptions,
  type ToolDef,
} from '@kisaes/vibe-ai-client';
import crypto from 'node:crypto';
import { audit } from '../audit.js';
import { logger } from '../logger.js';
import { CLAUDE_JOBS, type ClaudeJobName } from './jobs-config.js';
import type { ClaudeJobRequest, ClaudeJobResult } from './client.js';

// ── mode flag ────────────────────────────────────────────────────────────

export type AiMode = 'direct' | 'router';

export function aiMode(): AiMode {
  return process.env.VIBE_AI_MODE === 'router' ? 'router' : 'direct';
}

/** Boot-time validation; returns an error string or null. */
export function validateAiModeEnv(): string | null {
  const mode = process.env.VIBE_AI_MODE;
  if (mode && mode !== 'direct' && mode !== 'router') {
    return `VIBE_AI_MODE must be "direct" or "router" (got "${mode}")`;
  }
  if (mode === 'router' && (!process.env.VIBE_AI_ROUTER_URL || !process.env.VIBE_AI_TOKEN)) {
    return (
      'VIBE_AI_MODE=router requires both VIBE_AI_ROUTER_URL and VIBE_AI_TOKEN. ' +
      'Set them (the appliance mints the token during "vibe enable"), or set VIBE_AI_MODE=direct.'
    );
  }
  return null;
}

// ── task classes ─────────────────────────────────────────────────────────

export const TRC_TASK_CLASSES = {
  /** Titles/tags/summaries derived from user chat content and uploads (NEW — starts local_only) */
  CONTENT_META: 'taxresearch_content_meta',
  /** Client memo drafting (default pack, cloud_deidentified) */
  MEMO_DRAFT: 'taxresearch_memo_draft',
  /** Admin authoring over public tax law: strategies, tables, skills (NEW — starts local_only) */
  AUTHORING: 'taxresearch_authoring',
} as const;

/**
 * Job → task class. `null` = NOT routable: strategy-watch depends on Anthropic's
 * server-side web_search tool, which the router does not expose pre-R1, so it
 * stays on the direct path even in router mode.
 */
export const JOB_TASK_CLASS: Record<ClaudeJobName, string | null> = {
  'chat-title': TRC_TASK_CLASSES.CONTENT_META,
  'attachment-summarize': TRC_TASK_CLASSES.CONTENT_META,
  'archive-title-tags': TRC_TASK_CLASSES.CONTENT_META,
  'skill-author': TRC_TASK_CLASSES.AUTHORING,
  'skill-refine': TRC_TASK_CLASSES.AUTHORING,
  'strategy-author': TRC_TASK_CLASSES.AUTHORING,
  'tables-draft': TRC_TASK_CLASSES.AUTHORING,
  'strategy-refresh': TRC_TASK_CLASSES.AUTHORING,
  'strategy-watch': null,
  'plan-memo': TRC_TASK_CLASSES.MEMO_DRAFT,
};

export function jobRoutable(job: ClaudeJobName): boolean {
  return JOB_TASK_CLASS[job] !== null;
}

// ── client singleton ─────────────────────────────────────────────────────

let cached: VibeAiClient | null = null;

export function routerClient(): VibeAiClient {
  if (!cached) {
    cached = new VibeAiClient({
      baseUrl: process.env.VIBE_AI_ROUTER_URL ?? '',
      token: process.env.VIBE_AI_TOKEN ?? '',
    });
  }
  return cached;
}

/** Test seam. */
export function _setRouterClientForTests(c: VibeAiClient | null): void {
  cached = c;
}

// ── request translation (Anthropic Messages shape → router wire) ─────────

function systemText(system: ClaudeJobRequest['system']): string | undefined {
  if (system === undefined) return undefined;
  if (typeof system === 'string') return system;
  return system
    .filter((b): b is Anthropic.TextBlockParam => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

function toChatMessages(job: ClaudeJobName, request: ClaudeJobRequest): ChatMessage[] {
  const out: ChatMessage[] = [];
  const sys = systemText(request.system);
  if (sys) out.push({ role: 'system', content: sys });
  for (const m of request.messages) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    const texts: string[] = [];
    for (const block of m.content) {
      if (block.type === 'text') {
        texts.push(block.text);
      } else {
        // Fail closed: an untranslatable block (image, tool_result, document…)
        // must not be silently dropped from a prompt.
        throw new Error(
          `router mode cannot translate content block type "${block.type}" for job "${job}" — ` +
            'this job shape needs the direct path (or router backlog R1).',
        );
      }
    }
    out.push({ role: m.role, content: texts.join('\n') });
  }
  return out;
}

function toRequestOptions(
  request: ClaudeJobRequest,
  maxTokens: number,
  actorUserId: string | null | undefined,
): RequestOptions {
  const opts: RequestOptions = { maxTokens };
  if (request.temperature !== undefined) opts.temperature = request.temperature;
  if (request.stop_sequences?.length) opts.stop = request.stop_sequences;
  if (actorUserId) opts.userId = actorUserId;
  if (request.tools?.length) {
    opts.tools = request.tools.map((t): ToolDef => {
      if (!('input_schema' in t)) {
        // Server tools (web_search etc.) have no input_schema — unroutable.
        const label = t as { name?: string; type?: string };
        throw new Error(
          `router mode cannot forward server tool "${label.name ?? label.type ?? 'unknown'}"`,
        );
      }
      const tool = t as Anthropic.Tool;
      return {
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        parameters: tool.input_schema,
      };
    });
  }
  const tc = request.tool_choice;
  if (tc) {
    if (tc.type === 'tool') opts.toolChoice = { name: tc.name };
    else if (tc.type === 'any') opts.toolChoice = 'required';
    else if (tc.type === 'auto') opts.toolChoice = 'auto';
    else if (tc.type === 'none') opts.toolChoice = 'none';
  }
  return opts;
}

// ── response synthesis (router wire → Anthropic Message shape) ───────────
// Call sites read result.response.content / .usage / .stop_reason, so the
// router result is reshaped into a structurally-compatible Message. This is
// what keeps all nine job call sites byte-for-byte untouched.

function toStopReason(finishReason: string): Anthropic.Message['stop_reason'] {
  if (finishReason === 'tool_calls') return 'tool_use';
  if (finishReason === 'length') return 'max_tokens';
  return 'end_turn';
}

function sha256(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/**
 * Route one background job through the Vibe AI Router. Same contract as the
 * direct path: returns ClaudeJobResult, writes a `claude.call` audit row with
 * hashes only (never payloads), throws on failure.
 */
export async function callClaudeViaRouter(
  job: ClaudeJobName,
  request: ClaudeJobRequest,
  opts: { actorUserId?: string | null; timeoutMs?: number } = {},
): Promise<ClaudeJobResult> {
  const taskClass = JOB_TASK_CLASS[job];
  if (!taskClass) {
    throw new Error(`job "${job}" is not routable through the Vibe AI Router (stays direct)`);
  }
  const config = CLAUDE_JOBS[job];
  const maxTokens = Math.min(Math.max(request.max_tokens ?? config.maxTokens, 1), config.maxTokens);
  const messages = toChatMessages(job, request);
  const requestOptions = toRequestOptions(request, maxTokens, opts.actorUserId);
  const requestHash = sha256({ taskClass, messages, requestOptions });

  try {
    const result = await routerClient().complete(taskClass, messages, requestOptions);

    const content: Anthropic.ContentBlock[] = [];
    if (result.content) {
      content.push({ type: 'text', text: result.content, citations: null } as Anthropic.TextBlock);
    }
    for (const tc of result.toolCalls) {
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(tc.arguments || '{}') as Record<string, unknown>;
      } catch {
        /* tolerate junk arguments; callers validate input shape themselves */
      }
      content.push({ type: 'tool_use', id: tc.id, name: tc.name, input } as Anthropic.ToolUseBlock);
    }
    const response = {
      id: result.requestId || `router_${job}`,
      type: 'message',
      role: 'assistant',
      model: result.model,
      content,
      stop_reason: toStopReason(result.finishReason),
      stop_sequence: null,
      usage: {
        input_tokens: result.usage.promptTokens,
        output_tokens: result.usage.completionTokens,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: result.usage.cachedTokens || null,
      },
    } as unknown as Anthropic.Message;

    const text = result.content;
    const responseHash = sha256(content);
    await audit({
      actor_user_id: opts.actorUserId ?? null,
      action: 'claude.call',
      target_type: 'claude_job',
      target_id: job,
      metadata: {
        job,
        backend: 'vibe_router',
        task_class: taskClass,
        model: result.model,
        max_tokens: maxTokens,
        request_hash: requestHash,
        response_hash: responseHash,
        input_tokens: result.usage.promptTokens,
        output_tokens: result.usage.completionTokens,
        stop_reason: response.stop_reason,
      },
    });
    return { response, text, request_hash: requestHash, response_hash: responseHash };
  } catch (err) {
    await audit({
      actor_user_id: opts.actorUserId ?? null,
      action: 'claude.call',
      target_type: 'claude_job',
      target_id: job,
      metadata: {
        job,
        backend: 'vibe_router',
        task_class: taskClass,
        request_hash: requestHash,
        failed: true,
        error: (err as Error)?.message?.slice(0, 500) ?? 'unknown',
      },
    });
    throw err;
  }
}

// ── boot registration ────────────────────────────────────────────────────

/**
 * Declare this app's task classes on the router (idempotent). Router mode
 * only; non-blocking with backoff — requests made before registration
 * completes fail closed at the router, which is correct.
 */
export function registerTrcTaskClasses(o?: { client?: VibeAiClient; maxAttempts?: number }): void {
  if (aiMode() !== 'router') return;
  const client = o?.client ?? routerClient();
  const maxAttempts = o?.maxAttempts ?? 10;
  let attempt = 0;

  const tryRegister = async (): Promise<void> => {
    attempt++;
    try {
      await client.registerTaskClasses({
        app: 'vibe-tax-research',
        version: process.env.npm_package_version ?? 'unknown',
        classes: [
          // Pack class — declaration matches the reviewed pack entry.
          {
            key: TRC_TASK_CLASSES.MEMO_DRAFT,
            description: 'Client memo drafting from research threads',
            requires: {},
            defaultMaxTokens: 8192,
          },
          // New classes — start local_only until the operator widens them.
          {
            key: TRC_TASK_CLASSES.CONTENT_META,
            description: 'Titles, tags, and summaries over user chat content and uploads',
            requires: {},
            defaultMaxTokens: 600,
          },
          {
            key: TRC_TASK_CLASSES.AUTHORING,
            description:
              'Admin authoring: strategy drafts, tax tables, custom skills (forced tool output)',
            requires: { tools: true },
            defaultMaxTokens: 16000,
          },
        ],
      });
      logger.info({ mode: 'router' }, 'vibe-ai-router task classes registered');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (attempt >= maxAttempts) {
        logger.error(
          { attempts: attempt, err: message },
          'task-class registration failed; routable jobs fail closed until the router is reachable',
        );
        return;
      }
      const delayMs = Math.min(60_000, 2_000 * 2 ** (attempt - 1));
      logger.warn({ attempt, delayMs, err: message }, 'task-class registration retrying');
      const timer = setTimeout(() => void tryRegister(), delayMs);
      timer.unref?.();
    }
  };

  void tryRegister();
}
