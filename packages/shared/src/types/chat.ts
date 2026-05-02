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
  skills?: SkillAttribution[];
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
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  estimated_cost_usd?: number;
}
