// Phase 15 — cost calc tests against the §6 manifest.
import { describe, expect, it } from 'vitest';
import { computeCost, formatUsd } from './calc.js';
import type { ModelRecord } from '@vibe/shared';

const sonnet46: ModelRecord = {
  model_id: 'claude-sonnet-4-6',
  display_name: 'Claude Sonnet 4.6',
  input_per_mtok: 3,
  output_per_mtok: 15,
  cache_write_per_mtok: 3.75,
  cache_read_per_mtok: 0.3,
  tokenizer_factor: 1,
  web_fetch_unit_cost: 0.01,
  web_search_unit_cost: 0.01,
  is_active: true,
  retired_at: null,
};

const opus47: ModelRecord = {
  ...sonnet46,
  model_id: 'claude-opus-4-7',
  input_per_mtok: 5,
  output_per_mtok: 25,
  cache_write_per_mtok: 6.25,
  cache_read_per_mtok: 0.5,
  tokenizer_factor: 1.18,
};

describe('computeCost', () => {
  it('matches §8 baseline (no web tools, no cache) for Sonnet 4.6', () => {
    const c = computeCost(
      {
        input_tokens: 4000,
        output_tokens: 2666,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        web_fetch_calls: 0,
        web_search_calls: 0,
      },
      sonnet46,
    );
    // 4000 * 3 / 1e6 + 2666 * 15 / 1e6 = 0.012 + 0.03999 = 0.05199
    expect(c.total_usd).toBeCloseTo(0.05199, 5);
  });

  it('adds web fetch + search per-call cost', () => {
    const c = computeCost(
      {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        web_fetch_calls: 3,
        web_search_calls: 2,
      },
      sonnet46,
    );
    expect(c.total_usd).toBeCloseTo(0.05, 6);
  });

  it('Opus 4.7 charges more per token', () => {
    const usage = {
      input_tokens: 1000,
      output_tokens: 1000,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      web_fetch_calls: 0,
      web_search_calls: 0,
    };
    expect(computeCost(usage, opus47).total_usd).toBeGreaterThan(
      computeCost(usage, sonnet46).total_usd,
    );
  });

  it('cache reads cost ~10% of input rate', () => {
    const c = computeCost(
      {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 1_000_000,
        web_fetch_calls: 0,
        web_search_calls: 0,
      },
      sonnet46,
    );
    expect(c.cache_read_usd).toBeCloseTo(0.3, 6);
  });

  it('formatUsd uses 4 decimals under $1, 2 above', () => {
    expect(formatUsd(0.0123)).toBe('$0.0123');
    expect(formatUsd(2.5)).toBe('$2.50');
  });
});
