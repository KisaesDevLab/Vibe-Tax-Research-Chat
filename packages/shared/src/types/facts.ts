// TP-3a — wire types for client fact patterns and source documents.
import type { ClientDocType, FactCandidate, FactPattern } from '../facts/types.js';

export interface ClientFactPatternDTO {
  id: string;
  client_id: string;
  version: number;
  schema_version: string;
  facts: FactPattern;
  created_by: string | null;
  created_at: string;
  superseded_at: string | null;
  change_summary: string;
}

export interface FactPatternVersionSummaryDTO {
  id: string;
  version: number;
  change_summary: string;
  created_by: string | null;
  created_at: string;
  superseded_at: string | null;
}

export type ClientDocumentStatus = 'queued' | 'processing' | 'indexed' | 'failed';

export interface ClientDocumentDTO {
  id: string;
  client_id: string;
  sha256: string;
  filename: string;
  doc_type: ClientDocType;
  doc_type_method: 'heuristic' | 'llm' | 'manual' | null;
  tax_year: number | null;
  page_count: number | null;
  ocr_method: 'text_layer' | 'glm_ocr' | null;
  shield_pass_at: string | null;
  status: ClientDocumentStatus;
  error_message: string | null;
  extraction_error: string | null;
  pending_candidate_count: number;
  uploaded_by: string | null;
  uploaded_at: string;
}

export interface DocumentCandidateDTO {
  document_id: string;
  filename: string;
  doc_type: ClientDocType;
  tax_year: number | null;
  candidate: FactCandidate;
}

/** Same scalar fact path proposed with different values by different documents. */
export interface ConflictGroup {
  path: string;
  candidates: DocumentCandidateDTO[];
}

export interface PlanFactSnapshotDTO {
  id: string;
  plan_id: string;
  fact_pattern_id: string;
  fact_pattern_version: number;
  snapshot_kind: 'created' | 'review_frozen';
  snapshot_at: string;
}

export interface PlanPendingFactDTO {
  id: string;
  plan_id: string;
  message_id: string | null;
  fact_path: string | null;
  text: string;
  value: unknown;
  source: { documentId: string; page: number; span?: [number, number] } | null;
  method: string;
  status: 'pending' | 'promoted' | 'dismissed';
  promoted_fact_pattern_id: string | null;
  created_by: string | null;
  created_at: string;
}
