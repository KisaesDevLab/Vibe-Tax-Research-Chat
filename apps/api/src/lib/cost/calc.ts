// Phase 15 — pure cost calc. Inputs: usage block + model rates → CostBreakdown.
import type { CostBreakdown, CostInput, ModelRecord } from '@vibe/shared';

export function computeCost(usage: CostInput, model: ModelRecord): CostBreakdown {
  const input_usd = (usage.input_tokens * model.input_per_mtok) / 1_000_000;
  const output_usd = (usage.output_tokens * model.output_per_mtok) / 1_000_000;
  const cache_write_usd = (usage.cache_creation_input_tokens * model.cache_write_per_mtok) / 1_000_000;
  const cache_read_usd = (usage.cache_read_input_tokens * model.cache_read_per_mtok) / 1_000_000;
  const web_fetch_usd = usage.web_fetch_calls * model.web_fetch_unit_cost;
  const web_search_usd = usage.web_search_calls * model.web_search_unit_cost;
  const total_usd =
    input_usd + output_usd + cache_write_usd + cache_read_usd + web_fetch_usd + web_search_usd;
  return { input_usd, output_usd, cache_write_usd, cache_read_usd, web_fetch_usd, web_search_usd, total_usd };
}

export function formatUsd(n: number): string {
  if (n < 1) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}
