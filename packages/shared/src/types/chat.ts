// Phase 13-20 — wire types for chat / messages / panels.
export type MessageRole = 'user' | 'assistant' | 'system_note';

export interface Authority {
  cite: string; // e.g. "26 U.S.C. § 199A(c)(1)"
  // `firm_reference` was added in Phase 32 for citations that come from the
  // firm reference library (RAG over uploaded memos), so the AuthoritiesPanel
  // can visually distinguish them from primary authority.
  type:
    | 'statute'
    | 'regulation'
    | 'case'
    | 'irs_guidance'
    | 'public_law'
    | 'state'
    | 'firm_reference'
    | 'other';
  weight: 'primary' | 'secondary' | 'persuasive';
  source: string; // canonical URL or descriptor
  retrieved_at?: string; // ISO
  verified_this_turn: boolean;
  cache_age_seconds?: number;
  warning?: string;
}

// Each rule entry is permissive: the model emits a mix of bools, strings
// ("N/A — ..."), nulls, and structured `{ok, note}` objects. The renderer
// normalizes them at display time.
export type ComplianceRule = boolean | string | null | { ok: boolean; note?: string };

export interface ComplianceCheck {
  // Engagement summary line — usually a one-sentence classification of the
  // turn (e.g. "tax research / factual rate lookup").
  engagement_type?: string;
  // SSTS / Circular 230 rule outcomes. Both `circ_230_*` and `circ230_*`
  // shapes are observed in the wild, so the renderer accepts either.
  ssts_1_1?: ComplianceRule;
  ssts_2_3?: ComplianceRule;
  circ_230_10_22?: ComplianceRule;
  circ_230_10_35?: ComplianceRule;
  circ_230_10_37?: ComplianceRule;
  circ230_10_22?: ComplianceRule;
  circ230_10_35?: ComplianceRule;
  circ230_10_37?: ComplianceRule;
  // Either `form_disclosure_required` (older convention) or
  // `disclosure_forms` (current model output) may carry the form list.
  form_disclosure_required?: string[];
  disclosure_forms?: string[];
  loper_bright_caveat?: boolean;
  confidence_band?: string;
  negative_treatment_review?: string;
  negative_treatment_review_required?: boolean;
  notes?: string;
}

export interface SkillAttribution {
  skill_id: string;
  local_slug: string;
  display_name: string;
  version: string;
  always_attached: boolean;
  is_dispatcher: boolean;
  is_compliance: boolean;
}

export interface UsageBlock {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  web_fetch_calls: number;
  web_search_calls: number;
}

export interface MessageDTO {
  id: string;
  chat_id: string;
  role: MessageRole;
  content: string;
  created_at: string;
  // assistant-only:
  model_id?: string;
  stop_reason?: string;
  attached_skill_ids?: string[];
  attached_skill_versions?: string[];
  usage?: UsageBlock;
  cost_usd?: number;
  authorities?: Authority[];
  compliance_check?: ComplianceCheck;
  // TP-8a — plan-mode document citations ({documentId, page, claim}).
  doc_citations?: DocCitation[];
  // Question mode — the `clarify` sidecar from an interviewing / ready turn.
  clarification?: Clarification | null;
  // Question mode — user-only: set when this message was sent from the
  // interview card, so the transcript can show WHICH question it answers.
  clarify_answer?: ClarifyAnswer | null;
  skills?: SkillAttribution[];
}

// Question mode — how a user message answered the interview card.
//   option   → picked one of the model's suggested choices
//   freeform → typed a reply in the card's answer box
//   proceed  → pressed "Proceed" on a ready card (the go-ahead signal)
export interface ClarifyAnswer {
  /** The assistant message whose card was answered. */
  message_id: string;
  kind: 'option' | 'freeform' | 'proceed';
  /** The question text as shown at answer time (absent for `proceed`). */
  question?: string;
}

// Question mode — one turn of the pre-research interview. `asking` carries
// the single question (optionally a short pick-list); `ready` carries the
// model's confidence summary and the two-line plan it is waiting to run.
export interface Clarification {
  status: 'asking' | 'ready';
  /** 0–1 fraction (the prompt asks for a fraction; "95" / "95%" are normalized). */
  confidence: number;
  question?: string;
  options?: string[];
  summary?: string;
  plan?: string[];
}

// TP-8a — one document-grounded claim from a plan-scoped chat turn.
export interface DocCitation {
  documentId: string;
  filename?: string;
  page: number;
  claim: string;
  /** Set server-side: the pair appeared in this turn's retrieved excerpts. */
  grounded?: boolean;
}

export interface ChatDTO {
  id: string;
  user_id: string;
  title: string;
  default_model_id: string | null;
  pinned_pack_version: string | null;
  pii_disclosure_acknowledged: boolean;
  // Phase 32 — when true (default), per-turn retrieval injects firm
  // reference excerpts into the system prompt. Researchers can flip
  // this off for memo-writing turns where they want primary-authority
  // citations only.
  use_reference_library: boolean;
  // Question mode — when true the model interviews the researcher one
  // question at a time and waits for a "proceed" before researching.
  question_mode: boolean;
  // TP-2 — soft link to a client record (active-client chip / archival).
  client_id: string | null;
  // TP-8a — plan-scoped chat mode: plan linkage + strategy under discussion.
  plan_id: string | null;
  mode: string | null; // null | 'plan'
  strategy_id: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  estimated_cost_usd?: number;
}
