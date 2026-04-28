// Phase 13-20 — wire types for chat / messages / panels.
export type MessageRole = 'user' | 'assistant' | 'system_note';

export interface Authority {
  cite: string; // e.g. "26 U.S.C. § 199A(c)(1)"
  type: 'statute' | 'regulation' | 'case' | 'irs_guidance' | 'public_law' | 'state' | 'other';
  weight: 'primary' | 'secondary' | 'persuasive';
  source: string; // canonical URL or descriptor
  retrieved_at?: string; // ISO
  verified_this_turn: boolean;
  cache_age_seconds?: number;
  warning?: string;
}

export interface ComplianceCheck {
  ssts_1_1?: { ok: boolean; note?: string };
  ssts_2_3?: { ok: boolean; note?: string };
  circ_230_10_22?: { ok: boolean; note?: string };
  circ_230_10_35?: { ok: boolean; note?: string };
  circ_230_10_37?: { ok: boolean; note?: string };
  form_disclosure_required?: Array<'8275' | '8275-R' | '8886'>;
  loper_bright_caveat?: boolean;
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
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  estimated_cost_usd?: number;
}
