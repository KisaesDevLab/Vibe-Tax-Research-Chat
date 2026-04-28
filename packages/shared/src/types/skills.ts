// Phase 7 + 11 — skill types.
export type SkillStatus = 'stub' | 'draft' | 'reviewed' | 'verified';
export type SkillSource = 'custom' | 'anthropic' | 'pack';

export interface SkillFrontmatter {
  name: string;
  description: string;
  status?: SkillStatus;
  category?: string;
  routing_keywords?: string[];
}

export interface ParsedSkill {
  local_slug: string;
  display_name: string;
  description: string;
  category: string | null;
  status_field: SkillStatus;
  routing_keywords: string[];
  github_path: string;
  sha256: string;
  files: Array<{ rel_path: string; size_bytes: number }>;
}

export interface SkillRecord {
  skill_id: string;
  source: SkillSource;
  local_slug: string;
  display_name: string;
  description: string;
  category: string | null;
  current_version: string;
  github_path: string | null;
  github_sha: string | null;
  status_field: SkillStatus;
  is_active: boolean;
  is_always_attached: boolean;
  routing_keywords: string[];
  uploaded_at: string | null;
  retired_at: string | null;
}

export interface SyncDiff {
  added: Array<{ slug: string; new_sha: string }>;
  updated: Array<{ slug: string; old_sha: string; new_sha: string; changelog?: string }>;
  removed: Array<{ slug: string; old_sha: string }>;
  unchanged_count: number;
  resolved_sha: string;
  generated_at: string;
}
