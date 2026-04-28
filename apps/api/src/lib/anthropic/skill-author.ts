// Phase 21 follow-up — Claude-assisted skill authoring.
//
// Two modes:
//   1. draftSkillFromDocument(parsed_text, filename) — given parsed PDF /
//      DOCX / XLSX text, return a full proposed draft (slug, display_name,
//      description, body_md, routing_keywords).
//   2. refineSkill({ draft, history, user_message }) — given the current
//      draft state and a conversation, return Claude's reply plus a list
//      of structured field updates the SPA can render as accept-or-reject
//      diff cards.
//
// Both use the Messages API tool-use channel so updates are typed JSON
// rather than free-form Markdown the SPA would have to regex out of the
// reply. Tool-use also lets Claude propose multiple field changes in a
// single turn ('shorten the description AND add a routing keyword').
import type Anthropic from '@anthropic-ai/sdk';
import { getAnthropic } from './client.js';

export interface SkillDraft {
  name: string;
  display_name: string;
  description: string;
  body_md: string;
  routing_keywords: string[];
}

// Strict slug validator — must match the regex enforced by the create
// endpoint. We re-state it here so this module is self-contained.
const SLUG_RE = /^[a-z][a-z0-9-]{2,63}$/;

const DRAFTING_MODEL = 'claude-haiku-4-5';
const REFINING_MODEL = 'claude-haiku-4-5';

const PROPOSE_DRAFT_TOOL: Anthropic.Tool = {
  name: 'propose_skill_draft',
  description: 'Propose the initial draft of a custom skill based on the supplied document.',
  input_schema: {
    type: 'object',
    required: ['name', 'display_name', 'description', 'body_md', 'routing_keywords'],
    properties: {
      name: {
        type: 'string',
        description:
          'URL-safe slug. Lowercase letters, digits, hyphens. 3-64 chars, must start with a letter. Examples: firm-billing-rates, intake-1040-checklist.',
      },
      display_name: {
        type: 'string',
        description: 'Title-case human-readable name shown in admin tables and chat panels.',
      },
      description: {
        type: 'string',
        description:
          'One-paragraph description of WHEN to apply this skill. Plain text only — NO HTML or XML tags. Maximum 1024 chars.',
      },
      body_md: {
        type: 'string',
        description:
          'Full SKILL.md body (the model-facing instructions). Markdown. Should explain when the skill applies, what tone/format to use, and what facts to consult. Cite the attached source document by filename.',
      },
      routing_keywords: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Five to fifteen short, lowercase phrases a CPA would type when this skill should fire. Be generous — under-specific routing is the #1 reason custom skills go unused.',
      },
    },
  },
};

const PROPOSE_UPDATE_TOOL: Anthropic.Tool = {
  name: 'propose_skill_update',
  description:
    "Propose one or more field-level updates to the current draft. Call this tool zero, one, or many times during your reply, depending on what the user asked for. Use append_to_body for additive edits — replacing body_md will stomp the user's manual edits.",
  input_schema: {
    type: 'object',
    properties: {
      display_name: { type: 'string', description: 'Replace display_name with this value.' },
      description: {
        type: 'string',
        description: 'Replace description with this value. Plain text, ≤1024 chars, no tags.',
      },
      body_md: {
        type: 'string',
        description: 'Replace the entire body_md. Use sparingly — prefer append_to_body.',
      },
      append_to_body: {
        type: 'string',
        description:
          'Markdown to append to the existing body_md (with a leading blank line). The preferred way to add a section without disturbing earlier content.',
      },
      routing_keywords: {
        type: 'array',
        items: { type: 'string' },
        description:
          'REPLACE the routing keyword list with this array. Use this when broadening or narrowing routing scope holistically.',
      },
      append_routing_keywords: {
        type: 'array',
        items: { type: 'string' },
        description: 'Append these keywords to the existing list (deduplicated client-side).',
      },
    },
  },
};

const SYSTEM_PROMPT_DRAFT = `You are helping a U.S. CPA author a reusable, firm-wide "skill" for their tax research assistant.

A skill is a unit of firm knowledge that the assistant should automatically consult when relevant questions come up. Examples: a firm-internal billing-rates table, an engagement letter checklist, a memo on the firm's interpretation of a regulation, a summary of a state's nexus rules.

The user has uploaded a source document. Your job: read it carefully and propose a complete first draft via the propose_skill_draft tool.

Authoring rules:
- The slug should be short, descriptive, lowercase, hyphenated. Don't include "skill" in the slug.
- The display_name is the human label.
- The description tells future-you when to APPLY the skill. Lead with the trigger condition.
- The body_md is the actual instructions to the assistant. It should:
  • Open with the scenario where this skill applies
  • Reference the attached source document by filename when stating facts
  • Spell out what tone, level of caveat, or compliance rules to use
  • Be terse — Claude reads this every time the skill routes
- routing_keywords drive automatic routing. Five to fifteen lowercase phrases the user would type. Be generous; under-specific routing is the #1 reason custom skills go unused.

Always call propose_skill_draft. Don't reply with prose — the tool call is the entire response.`;

const SYSTEM_PROMPT_REFINE = `You are helping a U.S. CPA refine a custom skill they've already drafted. Be direct, terse, and concrete.

The user will ask questions or request changes. You can:
- Just answer in prose (no tool call) — for clarifying questions about the draft
- Call propose_skill_update one or more times — to suggest concrete field changes
- Both — explain the proposed change in prose AND call the tool

Editing rules:
- Prefer append_to_body over body_md replacement. Replacing body_md stomps the user's manual edits.
- Prefer append_routing_keywords for additive routing tweaks; only use routing_keywords (full replace) when re-architecting the routing strategy.
- Don't propose changes the user didn't ask for. If asked a question, answer first; only propose updates when explicitly invited.
- Skill body is Markdown. Don't fabricate facts — if you don't know, say so.`;

const MAX_DOC_CHARS = 90_000; // budget per draft request — keeps Haiku cheap

interface AnthropicTextBlock {
  type: 'text';
  text: string;
}
interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}
type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock | { type: string };

function isToolUse(b: AnthropicContentBlock): b is AnthropicToolUseBlock {
  return b.type === 'tool_use';
}
function isText(b: AnthropicContentBlock): b is AnthropicTextBlock {
  return b.type === 'text';
}

export async function draftSkillFromDocument(opts: {
  parsed_text: string;
  filename: string;
}): Promise<SkillDraft> {
  const { client } = await getAnthropic();
  const truncated =
    opts.parsed_text.length > MAX_DOC_CHARS
      ? `${opts.parsed_text.slice(0, MAX_DOC_CHARS)}\n\n[…truncated]`
      : opts.parsed_text;

  const userMessage = `Source document: ${opts.filename}\n\n<document>\n${truncated}\n</document>\n\nPropose the skill draft.`;

  const resp = await client.messages.create({
    model: DRAFTING_MODEL,
    max_tokens: 4096,
    system: SYSTEM_PROMPT_DRAFT,
    tools: [PROPOSE_DRAFT_TOOL],
    tool_choice: { type: 'tool', name: 'propose_skill_draft' },
    messages: [{ role: 'user', content: userMessage }],
  });

  const toolUse = (resp.content as AnthropicContentBlock[]).find(isToolUse);
  if (!toolUse) {
    throw new Error('Model did not propose a draft (no tool_use in response)');
  }
  const input = toolUse.input as Partial<SkillDraft> & { name?: string };
  const draft = sanitizeDraft(input);
  return draft;
}

function sanitizeDraft(d: Partial<SkillDraft>): SkillDraft {
  // Always normalize and clamp before returning so a creative model output
  // still passes the create-skill validator on the SPA save path.
  let name = (d.name ?? '').toLowerCase().replace(/[^a-z0-9-]/g, '-');
  name = name.replace(/^-+/, '').replace(/-+$/, '').replace(/-{2,}/g, '-');
  if (!SLUG_RE.test(name)) {
    // Fall back to a deterministic placeholder; the user will edit it anyway.
    name = `draft-${Date.now().toString(36)}`;
  }
  const description = (d.description ?? '')
    .replace(/<\/?[a-z][^>]*>/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1024);
  const display_name = (d.display_name ?? '').trim().slice(0, 120) || titleize(name);
  const body_md =
    (d.body_md ?? '').trim() ||
    `# ${display_name}\n\nDescribe when this skill applies and what the assistant should do.`;
  const kws = Array.isArray(d.routing_keywords) ? d.routing_keywords : [];
  const routing_keywords = Array.from(
    new Set(
      kws
        .filter((k): k is string => typeof k === 'string')
        .map((k) => k.toLowerCase().trim())
        .filter((k) => k.length > 0 && k.length <= 64),
    ),
  ).slice(0, 50);
  return { name, display_name, description, body_md, routing_keywords };
}

function titleize(slug: string): string {
  return slug
    .split('-')
    .map((p) => (p.length > 0 ? p[0]!.toUpperCase() + p.slice(1) : p))
    .join(' ');
}

// ── Refinement chat ────────────────────────────────────────────────────────

export type ProposedFieldUpdate =
  | { kind: 'replace'; field: 'display_name' | 'description' | 'body_md'; value: string }
  | { kind: 'replace'; field: 'routing_keywords'; value: string[] }
  | { kind: 'append'; field: 'body_md'; value: string }
  | { kind: 'append'; field: 'routing_keywords'; value: string[] };

export interface RefineChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface RefineResult {
  reply_text: string;
  updates: ProposedFieldUpdate[];
}

export async function refineSkill(opts: {
  draft: SkillDraft;
  history: RefineChatTurn[];
  user_message: string;
}): Promise<RefineResult> {
  const { client } = await getAnthropic();

  const draftSnapshot = `Current draft:
- name: ${opts.draft.name}
- display_name: ${opts.draft.display_name}
- description: ${opts.draft.description}
- routing_keywords: ${opts.draft.routing_keywords.join(', ') || '(none)'}

body_md:
"""
${opts.draft.body_md}
"""`;

  const messages: Anthropic.MessageParam[] = [
    ...opts.history.map<Anthropic.MessageParam>((h) => ({ role: h.role, content: h.content })),
    {
      role: 'user',
      content: `${draftSnapshot}\n\n---\nUser: ${opts.user_message}`,
    },
  ];

  const resp = await client.messages.create({
    model: REFINING_MODEL,
    max_tokens: 4096,
    system: SYSTEM_PROMPT_REFINE,
    tools: [PROPOSE_UPDATE_TOOL],
    messages,
  });

  const blocks = resp.content as AnthropicContentBlock[];
  const reply_text = blocks
    .filter(isText)
    .map((b) => b.text)
    .join('\n')
    .trim();
  const updates: ProposedFieldUpdate[] = [];
  for (const b of blocks.filter(isToolUse)) {
    const input = b.input as Record<string, unknown>;
    if (typeof input.display_name === 'string')
      updates.push({ kind: 'replace', field: 'display_name', value: input.display_name });
    if (typeof input.description === 'string') {
      const cleaned = input.description
        .replace(/<\/?[a-z][^>]*>/gi, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 1024);
      updates.push({ kind: 'replace', field: 'description', value: cleaned });
    }
    if (typeof input.body_md === 'string')
      updates.push({ kind: 'replace', field: 'body_md', value: input.body_md });
    if (typeof input.append_to_body === 'string')
      updates.push({ kind: 'append', field: 'body_md', value: input.append_to_body });
    if (Array.isArray(input.routing_keywords)) {
      const cleaned = (input.routing_keywords as unknown[])
        .filter((k): k is string => typeof k === 'string')
        .map((k) => k.toLowerCase().trim())
        .filter((k) => k.length > 0 && k.length <= 64)
        .slice(0, 50);
      updates.push({ kind: 'replace', field: 'routing_keywords', value: cleaned });
    }
    if (Array.isArray(input.append_routing_keywords)) {
      const cleaned = (input.append_routing_keywords as unknown[])
        .filter((k): k is string => typeof k === 'string')
        .map((k) => k.toLowerCase().trim())
        .filter((k) => k.length > 0 && k.length <= 64);
      updates.push({ kind: 'append', field: 'routing_keywords', value: cleaned });
    }
  }
  return { reply_text, updates };
}
