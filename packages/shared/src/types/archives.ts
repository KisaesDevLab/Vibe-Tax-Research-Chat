// TP-11 — wire types for research-session archival.
export interface PiiHitDTO {
  id: string;
  kind: 'ssn' | 'ein' | 'account';
  match: string;
  context: string;
  location: { message_index: number; start: number; end: number };
}

export interface ArchiveDraftResponse {
  suggested_title: string;
  suggested_tags: string[];
  pii_hits: PiiHitDTO[];
}

// List shape — snapshot body deliberately excluded.
export interface ArchiveListItemDTO {
  id: string;
  client_id: string | null;
  firm_archive: boolean;
  source_session_id: string | null;
  title: string;
  topic_tags: string[];
  note: string | null;
  sha256: string;
  archived_by: string | null;
  archived_at: string;
  status: 'active' | 'superseded';
  tombstone: {
    original_client: { id: string; name: string };
    event: string;
    actor_user_id: string | null;
    at: string;
  } | null;
  plan_id: string | null;
  strategy_id: string | null;
  message_count: number;
}

export interface ArchiveSnapshotDTO {
  chat: { id: string; title: string; created_at: string; updated_at: string };
  messages: Array<{
    role: string;
    content: string;
    created_at: string;
    authorities?: unknown;
    compliance_check?: unknown;
  }>;
  consultations: Array<{
    tool_name?: string;
    url?: string | null;
    query?: string | null;
    domain?: string | null;
    fetched_at?: string;
    cited_in_authorities?: boolean;
  }>;
  archived_from_version: number;
}

export interface ArchiveDetailDTO extends Omit<ArchiveListItemDTO, 'message_count'> {
  snapshot: ArchiveSnapshotDTO;
  snapshot_text: string;
}

export interface ArchiveNudgeDTO {
  id: string;
  title: string;
  updated_at: string;
}
