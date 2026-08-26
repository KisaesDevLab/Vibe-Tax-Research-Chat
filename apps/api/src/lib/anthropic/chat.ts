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
import { WEB_ALLOWLIST_DOMAINS, DEFAULT_WEB_BUDGET, describeReachableSources } from '@vibe/shared';

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

// Beta surfaces enabled on every request:
//   - code-execution-2025-08-25 → enables container.skills + code_execution
//   - skills-2025-10-02         → enables custom-skill upload + attachment
//   - extended-cache-ttl-2025-04-11 → ttl: '1h' on cache_control blocks
//     (default ephemeral TTL is 5 min, which goes cold any time a researcher
//     steps away from a chat for more than a few minutes; 1h covers a
//     normal session including coffee breaks)
//   - token-efficient-tools-2025-02-19 → compact JSON-schema serialization
//     of tool definitions. The web_fetch allowlist alone is non-trivial in
//     wire form; this trims input tokens at zero behavior cost.
const BETAS = [
  'code-execution-2025-08-25',
  'skills-2025-10-02',
  'extended-cache-ttl-2025-04-11',
  'token-efficient-tools-2025-02-19',
] as const;

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

  // The skills beta auto-injects code_execution when container.skills is
  // present. Adding it manually then triggers a 400 "Auto-injecting tools
  // would conflict with existing tool names: ['code_execution']". Only
  // attach code_execution ourselves when no skills are attached.
  const tools: Array<Record<string, unknown>> = [];
  if (opts.attached_skill_ids.length === 0) {
    tools.push({ type: 'code_execution_20250825', name: 'code_execution' });
  }
  if (opts.enable_web_tools) {
    // Pin to the current tool revisions Anthropic accepts. Per the
    // platform docs, the valid web_fetch versions are 20260209 (latest,
    // with dynamic filtering) and 20250910 (previous); valid web_search
    // versions are 20260209 (latest) and 20250305 (previous). Neither
    // tool requires an anthropic-beta header. Dynamic filtering on the
    // 20260209 versions needs code_execution in the tools array — which
    // we already have either explicitly (no skills attached) or via the
    // skills beta's auto-injection (skills attached). Bump these when
    // Anthropic ships newer revisions.
    tools.push({
      type: 'web_fetch_20260209',
      name: 'web_fetch',
      max_uses: opts.fetches_per_turn ?? DEFAULT_WEB_BUDGET.fetches_per_turn,
      allowed_domains: WEB_ALLOWLIST_DOMAINS,
    });
    tools.push({
      type: 'web_search_20260209',
      name: 'web_search',
      max_uses: opts.searches_per_turn ?? DEFAULT_WEB_BUDGET.searches_per_turn,
      allowed_domains: WEB_ALLOWLIST_DOMAINS,
    });
  }

  // Defensive role-alternation. The Messages API requires strict user/
  // assistant alternation; consecutive same-role messages may 400, or
  // 500 in tool-heavy configurations. This can happen when a prior turn
  // was severed mid-stream (orphan user message with no assistant
  // reply), or if a caller passes history that already includes the
  // current user message. Collapse consecutive same-role entries by
  // joining their content so no information is lost and the API gets a
  // strictly alternating sequence.
  const rawMessages = [
    ...opts.history.map((h) => ({ role: h.role, content: h.content })),
    { role: 'user' as const, content: opts.user_message },
  ];
  const normalizedMessages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const m of rawMessages) {
    const last = normalizedMessages[normalizedMessages.length - 1];
    if (last && last.role === m.role) {
      last.content = `${last.content}\n\n${m.content}`;
    } else {
      normalizedMessages.push({ ...m });
    }
  }

  // Cache breakpoint on the last assistant message in history. With the
  // hierarchy tools → system → messages, the single existing breakpoint
  // on `system` only caches tools+system; the messages array gets
  // re-tokenized on every turn. Adding a breakpoint here caches the
  // entire prior conversation (everything up to and including the last
  // assistant turn). The fresh user message at the end is not cached,
  // by design — it's new each request. 1h TTL via the extended-cache-ttl
  // beta breaks even at 2 cache hits within the hour, easily met for any
  // active research session.
  const lastAssistantIdx = (() => {
    for (let i = normalizedMessages.length - 1; i >= 0; i--) {
      if (normalizedMessages[i]!.role === 'assistant') return i;
    }
    return -1;
  })();
  const apiMessages = normalizedMessages.map((m, i) => {
    if (i !== lastAssistantIdx) return m;
    // cache_control requires the content-block array form (string content
    // doesn't carry cache_control). Other messages stay as strings to
    // keep the wire payload small.
    return {
      role: m.role,
      content: [
        {
          type: 'text' as const,
          text: m.content,
          cache_control: { type: 'ephemeral' as const, ttl: '1h' as const },
        },
      ],
    };
  });

  // Body uses the typed SDK shape, then casts to add untyped fields
  // (`container`, untyped tool shapes, ttl on cache_control). When the
  // SDK ships these in a stable release, drop the cast.
  const body = {
    model: opts.model_id,
    max_tokens: 8192,
    system: [
      {
        type: 'text' as const,
        text: opts.system_prompt,
        cache_control: { type: 'ephemeral' as const, ttl: '1h' as const },
      },
    ],
    messages: apiMessages,
    tools: tools as unknown as Anthropic.Beta.Messages.BetaToolUnion[],
    betas: [...BETAS],
    ...(opts.attached_skill_ids.length
      ? {
          // container.skills[] entries require {type, id}. The skills we
          // uploaded come back from POST /v1/skills with source="custom",
          // so type="custom" is correct here. (anthropic-issued bundled
          // skills would use type="anthropic_skill" once those exist.)
          container: {
            skills: opts.attached_skill_ids.map((id) => ({
              type: 'custom' as const,
              skill_id: id,
            })),
          },
        }
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

${describeReachableSources()}

When a search or fetch comes back empty:
  - An empty result means the source is outside the list above, or the material genuinely
    is not there. It does NOT mean the tool is broken, rate-limited, throttled, or
    degraded. Never tell the user a tool is rate-limited or unavailable — you cannot
    observe that, and asserting it misrepresents why the answer is thin.
  - Say plainly which authority you could not reach and why you believe that, then either
    ask the user for the source or answer only the part you did verify.
  - Do NOT fall back to reciting statutes, section numbers, regulation cites, or dollar
    figures from memory and marking them for the user to verify. A confident-looking cite
    the reader has to check is worse than an explicit gap: it reads exactly like a
    verified one. An unverified citation is not a citation.

Citation discipline:
  - When a skill instructs you to verify a citation, use web_fetch against the canonical
    source named by the skill rather than relying on memory.
  - Cite only authorities you have fetched in this turn, except where the skill explicitly
    permits secondary recall.
  - If a fetch fails, emit "[CITATION NEEDED — search: <query>]" rather than paraphrasing
    from memory. Use the same marker when a search returns nothing.
  - You have a per-turn budget for both tools. Spend it on the authorities that carry the
    answer. If you exhaust it, say which questions remain unverified — do not close the
    gap from memory.

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

Output medium:
  - Answer inline as Markdown — tables, fenced code, and the sidecar JSON blocks.
    Never produce a downloadable file or a Word / Excel / PDF attachment: this chat
    streams text, so a generated file would not reach the user.
  - Do not use code execution to write documents. If the user needs a formatted,
    firm-branded deliverable, tell them to build it in the Planning module's
    deliverables, which renders the PDF and issues a signed download link.
`;
}

export const ANTHROPIC_BETAS = [...BETAS];
