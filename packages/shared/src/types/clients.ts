// TP-2/TP-3 — wire types for client records (local-only slice; T&B
// provenance fields arrive with the sync integration).
export interface ClientContactDTO {
  name?: string;
  email?: string;
  phone?: string;
  role?: string;
}

export interface ClientDTO {
  id: string;
  name: string;
  entity_type: string;
  contacts: ClientContactDTO[];
  merged_into_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}
