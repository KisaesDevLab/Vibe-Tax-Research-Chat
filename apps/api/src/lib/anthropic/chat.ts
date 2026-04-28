// Phase 12 + 16 — streaming chat against the Messages API.
//
// Always sets:
//   betas: ["code-execution-2025-08-25", "skills-2025-10-02"]
//   tools: code_execution_20250825 + (per-model) web_fetch_20250828 + web_search_20250828
//   container.skills[]: up to 8 skill_ids resolved by the routing layer
//
// Returns a normalized async iterable. The Anthropic SDK 0.40.1 doesn't yet
// type the `container` field nor the new tool shapes — those land in a later
// SDK release. We extend the typed body with `as unknown` only for those
// still-untyped fields. Everything else uses the typed surface.

import type Anthropic from '@anthropic-ai/sdk';
import { getAnthropic } from './client.js';
import { WEB_ALLOWLIST_DOMAINS, DEFAULT_WEB_BUDGET } from '@vibe/shared';

export type ChatEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_use'; tool_name: string; input: unknown; id: string }
  | { type: 'tool_result'; tool_use_id: string; result: unknown; status?: 'ok' | 'error' }
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

const BETAS = ['code-execution-2025-08-25', 'skills-2025-10-02'] as const;

interface AssemblingToolUse {
  id: string;
  name: string;
  input_json: string;
}

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

  // Body uses the typed SDK shape, then casts to add untyped fields
  // (`container`, untyped tool shapes). When SDK ships these in a stable
  // release, drop the cast.
  const body = {
    model: opts.model_id,
    max_tokens: 8192,
    system: [
      {
        type: 'text' as const,
        text: opts.system_prompt,
        cache_control: { type: 'ephemeral' as const },
      },
    ],
    messages: [
      ...opts.history.map((h) => ({ role: h.role, content: h.content })),
      { role: 'user' as const, content: opts.user_message },
    ],
    tools: tools as unknown as Anthropic.Beta.Messages.BetaToolUnion[],
    betas: [...BETAS],
    ...(opts.attached_skill_ids.length
      ? { container: { skills: opts.attached_skill_ids.map((id) => ({ id })) } }
      : {}),
  } as unknown as Anthropic.Beta.Messages.MessageCreateParams;

  const stream = client.beta.messages.stream(body);

  // tool_use blocks stream their JSON input as input_json_delta chunks; we
  // assemble per-block-index until content_block_stop, then emit the complete
  // tool_use event so the audit shim has a fully-formed input.
  const assembling = new Map<number, AssemblingToolUse>();

  for await (const ev of stream) {
    switch (ev.type) {
      case 'content_block_start': {
        const block = ev.content_block;
        if (block.type === 'tool_use') {
          assembling.set(ev.index, { id: block.id, name: block.name, input_json: '' });
          if (block.name === 'web_fetch') usage.web_fetch_calls++;
          else if (block.name === 'web_search') usage.web_search_calls++;
        }
        break;
      }
      case 'content_block_delta': {
        const delta = ev.delta;
        if (delta.type === 'text_delta') {
          yield { type: 'text_delta', delta: delta.text };
        } else if (delta.type === 'input_json_delta') {
          const tu = assembling.get(ev.index);
          if (tu) tu.input_json += delta.partial_json;
        }
        break;
      }
      case 'content_block_stop': {
        const tu = assembling.get(ev.index);
        if (tu) {
          assembling.delete(ev.index);
          let input: unknown = {};
          if (tu.input_json) {
            try {
              input = JSON.parse(tu.input_json);
            } catch {
              input = { _raw: tu.input_json };
            }
          }
          yield { type: 'tool_use', id: tu.id, tool_name: tu.name, input };
        }
        break;
      }
      case 'message_delta': {
        const u = ev.usage;
        if (u) {
          // ev.usage on message_delta only carries output_tokens reliably
          // pre-stop; we accumulate from the final message snapshot below.
          usage.output_tokens = u.output_tokens ?? usage.output_tokens;
          yield { type: 'usage', usage: u as Partial<UsageSnapshot> };
        }
        break;
      }
      case 'message_stop': {
        // Pull the assembled message from the SDK; its `usage` block holds the
        // final input/output/cache counts.
        const finalMsg = await stream.finalMessage();
        const fu = finalMsg.usage;
        usage.input_tokens = fu.input_tokens ?? usage.input_tokens;
        usage.output_tokens = fu.output_tokens ?? usage.output_tokens;
        usage.cache_creation_input_tokens = fu.cache_creation_input_tokens ?? 0;
        usage.cache_read_input_tokens = fu.cache_read_input_tokens ?? 0;
        yield {
          type: 'message_stop',
          stop_reason: finalMsg.stop_reason ?? 'unknown',
          usage,
        };
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

Sidecar JSON:
  - At the end of every research answer, emit a fenced JSON block tagged "authorities"
    listing the authorities you cited. Each entry: { "cite", "type", "weight", "source",
    "verified_this_turn" }. Set verified_this_turn=true only if you actually fetched the
    source URL during this turn.
  - When the compliance-ssts-circular230 skill is attached, also emit a fenced JSON block
    tagged "compliance" with the SSTS / Circular 230 checklist.

PII handling:
  - Treat client identifiers (SSN, EIN, DOB, account numbers) as confidential.
  - Mask leading digits of SSN/EIN in any verbatim quote unless the user has asked you not to.

Format:
  - Lead with the answer, then the analysis, then the authorities.
  - Numeric examples: show the formula, the substitution, then the result.
  - Compliance disclosures appear under a dedicated "Compliance" heading.
`;
}

export const ANTHROPIC_BETAS = [...BETAS];
