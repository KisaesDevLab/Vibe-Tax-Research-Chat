// Phase 12 + 16 — streaming chat against the Messages API.
//
// Always sets:
//   betas: ["code-execution-2025-08-25", "skills-2025-10-02"]
//   tools includes code_execution_20250825 and (per-model) web_fetch + web_search
//   container.skills[]: up to 8 skill_ids resolved by the routing layer
//
// Returns an async iterable of normalized events:
//   - 'text_delta'   : streaming output
//   - 'tool_use'     : Claude is invoking a tool (for audit)
//   - 'tool_result'  : tool result (for audit)
//   - 'usage'        : usage block update
//   - 'message_stop' : final stop_reason

import { getAnthropic } from './client.js';
import type { ParsedSkill } from '@vibe/shared';
import { WEB_ALLOWLIST_DOMAINS, DEFAULT_WEB_BUDGET } from '@vibe/shared';

export type ChatEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_use'; tool_name: string; input: unknown; id: string }
  | { type: 'tool_result'; tool_use_id: string; result: unknown; status?: string }
  | { type: 'usage'; usage: Partial<UsageSnapshot> }
  | { type: 'message_stop'; stop_reason: string; usage: UsageSnapshot };

export interface UsageSnapshot {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  web_fetch_calls: number;
  web_search_calls: number;
}

export interface StreamChatOpts {
  chat_id: string;
  user_message: string;
  system_prompt: string;
  model_id: string;
  attached_skill_ids: string[];
  enable_web_tools: boolean;
  fetches_per_turn?: number;
  searches_per_turn?: number;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
}

const BETAS = ['code-execution-2025-08-25', 'skills-2025-10-02'];

export async function* streamChat(opts: StreamChatOpts): AsyncIterable<ChatEvent> {
  const { client } = await getAnthropic();
  const usage: UsageSnapshot = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    web_fetch_calls: 0,
    web_search_calls: 0,
  };

  const tools: Array<Record<string, unknown>> = [
    { type: 'code_execution_20250825', name: 'code_execution' },
  ];
  if (opts.enable_web_tools) {
    tools.push({
      type: 'web_fetch_20250828',
      name: 'web_fetch',
      max_uses: opts.fetches_per_turn ?? DEFAULT_WEB_BUDGET.fetches_per_turn,
      allowed_domains: WEB_ALLOWLIST_DOMAINS,
    });
    tools.push({
      type: 'web_search_20250828',
      name: 'web_search',
      max_uses: opts.searches_per_turn ?? DEFAULT_WEB_BUDGET.searches_per_turn,
      allowed_domains: WEB_ALLOWLIST_DOMAINS,
    });
  }

  // Cast to unknown — the SDK shape for skills + container is still on the
  // beta-only path; the cast is the seam to update once the SDK ships stable.
  const stream = (client as unknown as {
    beta: {
      messages: {
        stream: (args: unknown) => AsyncIterable<{ type: string; [k: string]: unknown }>;
      };
    };
  }).beta.messages.stream({
    model: opts.model_id,
    max_tokens: 8192,
    system: [
      {
        type: 'text',
        text: opts.system_prompt,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      ...opts.history.map((h) => ({ role: h.role, content: h.content })),
      { role: 'user', content: opts.user_message },
    ],
    tools,
    container: {
      skills: opts.attached_skill_ids.map((id) => ({ id })),
    },
    betas: BETAS,
  });

  for await (const ev of stream) {
    switch (ev.type) {
      case 'content_block_start': {
        const block = (ev as { content_block?: { type?: string; name?: string; id?: string; input?: unknown } }).content_block;
        if (block?.type === 'tool_use' && block.name && block.id) {
          if (block.name === 'web_fetch') usage.web_fetch_calls++;
          if (block.name === 'web_search') usage.web_search_calls++;
          yield { type: 'tool_use', tool_name: block.name, input: block.input ?? null, id: block.id };
        }
        break;
      }
      case 'content_block_delta': {
        const delta = (ev as { delta?: { type?: string; text?: string } }).delta;
        if (delta?.type === 'text_delta' && delta.text) {
          yield { type: 'text_delta', delta: delta.text };
        }
        break;
      }
      case 'tool_result': {
        const r = ev as { tool_use_id?: string; content?: unknown; is_error?: boolean };
        if (r.tool_use_id) {
          yield {
            type: 'tool_result',
            tool_use_id: r.tool_use_id,
            result: r.content ?? null,
            status: r.is_error ? 'error' : 'ok',
          };
        }
        break;
      }
      case 'message_delta': {
        const u = (ev as { usage?: Partial<UsageSnapshot> }).usage;
        if (u) {
          usage.input_tokens = u.input_tokens ?? usage.input_tokens;
          usage.output_tokens = u.output_tokens ?? usage.output_tokens;
          usage.cache_creation_input_tokens =
            u.cache_creation_input_tokens ?? usage.cache_creation_input_tokens;
          usage.cache_read_input_tokens =
            u.cache_read_input_tokens ?? usage.cache_read_input_tokens;
          yield { type: 'usage', usage: u };
        }
        break;
      }
      case 'message_stop': {
        const stop_reason =
          (ev as { stop_reason?: string }).stop_reason ?? 'unknown';
        yield { type: 'message_stop', stop_reason, usage };
        return;
      }
      default:
        break;
    }
  }
}

export function buildSystemPrompt(opts: { firm_name?: string }): string {
  const date = new Date().toISOString().slice(0, 10);
  const firm = opts.firm_name ?? 'this firm';
  return `You are the AI research assistant for ${firm}, a U.S. CPA firm. Today's date is ${date}.

You have the Vibe Tax Research Skills pack attached. The dispatcher (cpa-pack-index) has
selected up to 8 skills for this turn. Always honor the compliance-ssts-circular230 skill's
checklist for every assistant message.

Citation discipline:
  - When a skill instructs you to verify a citation, use web_fetch against the canonical
    source named by the skill rather than relying on memory.
  - Cite only authorities you have fetched in this turn, except where the skill explicitly
    permits secondary recall.
  - If a fetch fails, emit "[CITATION NEEDED — search: <query>]" rather than paraphrasing
    from memory.

PII handling:
  - Treat client identifiers (SSN, EIN, DOB, account numbers) as confidential.
  - Mask leading digits of SSN/EIN in any verbatim quote unless the user has asked you not to.

Format:
  - Lead with the answer, then the analysis, then the authorities.
  - Numeric examples: show the formula, the substitution, then the result.
  - Compliance disclosures appear under a dedicated "Compliance" heading.
`;
}

export const ANTHROPIC_BETAS = BETAS;
