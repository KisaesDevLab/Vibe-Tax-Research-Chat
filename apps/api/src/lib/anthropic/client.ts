// Phase 5 + 12, upgraded in TP-13 — the single seam every Claude call
// goes through.
//
// Key flow (unchanged):
//   1. Pull encrypted setting from settings table.
//   2. Decrypt in-memory via lib/crypto.open.
//   3. Construct Anthropic({ apiKey }) and use it for one request.
//   4. Drop the reference. The key is never logged, never persisted as plaintext.
//
// TP-13 additions:
//   - ANTHROPIC_KILL_SWITCH env: typed claude_disabled error from every
//     path (streaming and jobs) without touching the stored key.
//   - SHIELD_URL env: routes ALL traffic through the Shield egress proxy
//     as baseURL. ZDR is an org-level account setting, not a header — the
//     deployment checklist covers it.
//   - callClaude(job, request): the job seam. Per-job model pin + HARD
//     token budget (jobs-config.ts), retry with exponential backoff +
//     jitter on 429/5xx/network, and a mandatory `claude.call` audit row
//     carrying request/response SHA-256 hashes — payloads themselves are
//     never persisted.

import crypto from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { getSetting } from '../settings-store.js';
import { SETTING_KEYS } from '@vibe/db/schema';
import { fingerprint } from '../crypto.js';
import { audit } from '../audit.js';
import { logger } from '../logger.js';
import { CLAUDE_JOBS, type ClaudeJobName } from './jobs-config.js';
import { aiMode, callClaudeViaRouter, jobRoutable } from './router-mode.js';

export class ClaudeDisabledError extends Error {
  code = 'claude_disabled' as const;
  constructor() {
    super('Claude calls are disabled by the ANTHROPIC_KILL_SWITCH environment flag.');
  }
}

export interface AnthropicHandle {
  client: Anthropic;
  key_fingerprint: string;
  // Raw key — included so callers that bypass the SDK (multipart uploads
  // for /v1/skills, etc.) can sign their own request. Never logged.
  api_key: string;
}

function killSwitchOn(): boolean {
  const v = (process.env.ANTHROPIC_KILL_SWITCH ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

function shieldBaseUrl(): string | undefined {
  const v = process.env.SHIELD_URL?.trim();
  return v ? v.replace(/\/+$/, '') : undefined;
}

export async function getAnthropic(): Promise<AnthropicHandle> {
  if (killSwitchOn()) throw new ClaudeDisabledError();
  const key = await getSetting<string>(SETTING_KEYS.ANTHROPIC_API_KEY);
  if (!key) {
    throw new Error('Anthropic API key is not configured. Admin must set it via Admin → Settings.');
  }
  const client = new Anthropic({ apiKey: key, baseURL: shieldBaseUrl() });
  return { client, key_fingerprint: fingerprint(key), api_key: key };
}

// 1-token validation call used at key save time.
export async function validateKey(rawKey: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const client = new Anthropic({ apiKey: rawKey, baseURL: shieldBaseUrl() });
    await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }],
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

// ── TP-13: the job seam ──────────────────────────────────────────────────

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 500;

function isRetryable(err: unknown): boolean {
  const status = (err as { status?: number }).status;
  if (typeof status === 'number') return status === 429 || status >= 500;
  // No HTTP status → connection-level failure (ECONNRESET, timeout…).
  return true;
}

function sha256(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type ClaudeJobRequest = Omit<
  Anthropic.MessageCreateParamsNonStreaming,
  'model' | 'max_tokens' | 'stream'
> & {
  /** Requested output tokens — clamped to the job's budget. */
  max_tokens?: number;
};

export interface ClaudeJobResult {
  response: Anthropic.Message;
  /** Concatenated text blocks (convenience for text-only jobs). */
  text: string;
  request_hash: string;
  response_hash: string;
}

/**
 * Every background Claude job goes through here: pinned model, clamped
 * budget, retry/backoff, audited call. Throws ClaudeDisabledError when
 * the kill switch is on and the underlying "no key" error when
 * unconfigured — callers decide whether that degrades or fails.
 */
export async function callClaude(
  job: ClaudeJobName,
  request: ClaudeJobRequest,
  opts: { actorUserId?: string | null; timeoutMs?: number } = {},
): Promise<ClaudeJobResult> {
  const config = CLAUDE_JOBS[job];
  // MIG-4: routable background jobs go through the Vibe AI Router in router
  // mode. The kill switch still applies first (it is the emergency spend
  // brake regardless of backend). strategy-watch (server-side web_search) and
  // the streaming chat path stay direct until R1 — a static split, never a
  // runtime fallback: router errors surface to the caller's degrade logic.
  if (aiMode() === 'router' && jobRoutable(job)) {
    if (killSwitchOn()) throw new ClaudeDisabledError();
    return callClaudeViaRouter(job, request, opts);
  }
  const { client } = await getAnthropic(); // kill switch + shield routing live here
  const maxTokens = Math.min(Math.max(request.max_tokens ?? config.maxTokens, 1), config.maxTokens);
  const body: Anthropic.MessageCreateParamsNonStreaming = {
    ...request,
    model: config.model,
    max_tokens: maxTokens,
  };
  const requestHash = sha256(body);

  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await client.messages.create(body, {
        timeout: opts.timeoutMs ?? config.timeoutMs,
      });
      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
      const responseHash = sha256(response.content);
      await audit({
        actor_user_id: opts.actorUserId ?? null,
        action: 'claude.call',
        target_type: 'claude_job',
        target_id: job,
        metadata: {
          job,
          model: config.model,
          max_tokens: maxTokens,
          attempts: attempt,
          request_hash: requestHash,
          response_hash: responseHash,
          input_tokens: response.usage.input_tokens,
          output_tokens: response.usage.output_tokens,
          stop_reason: response.stop_reason,
        },
      });
      return { response, text, request_hash: requestHash, response_hash: responseHash };
    } catch (err) {
      lastErr = err;
      if (err instanceof ClaudeDisabledError || !isRetryable(err) || attempt === MAX_ATTEMPTS) {
        break;
      }
      const backoff = BASE_BACKOFF_MS * 2 ** (attempt - 1) * (0.5 + Math.random());
      logger.warn(
        { job, attempt, backoff_ms: Math.round(backoff), err: (err as Error).message },
        'claude.call retrying',
      );
      await sleep(backoff);
    }
  }
  await audit({
    actor_user_id: opts.actorUserId ?? null,
    action: 'claude.call',
    target_type: 'claude_job',
    target_id: job,
    metadata: {
      job,
      model: config.model,
      request_hash: requestHash,
      failed: true,
      error: (lastErr as Error)?.message?.slice(0, 500) ?? 'unknown',
    },
  });
  throw lastErr;
}
