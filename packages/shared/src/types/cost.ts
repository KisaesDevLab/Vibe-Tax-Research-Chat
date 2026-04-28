// Phase 6 + 15 — model + cost types.
export interface ModelRecord {
  model_id: string;
  display_name: string;
  input_per_mtok: number;
  output_per_mtok: number;
  cache_write_per_mtok: number;
  cache_read_per_mtok: number;
  tokenizer_factor: number;
  web_fetch_unit_cost: number;
  web_search_unit_cost: number;
  is_active: boolean;
  retired_at: string | null;
  notes?: string | null;
}

export interface CostInput {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  web_fetch_calls: number;
  web_search_calls: number;
}

export interface CostBreakdown {
  input_usd: number;
  output_usd: number;
  cache_write_usd: number;
  cache_read_usd: number;
  web_fetch_usd: number;
  web_search_usd: number;
  total_usd: number;
}
