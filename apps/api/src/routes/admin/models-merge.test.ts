// Unit tests for the model_id normalization + pricing-manifest merge.
// The merge is the load-bearing join between Anthropic's /v1/models
// response (which surfaces dated IDs for pre-4.6 models) and our
// pricing seed (which uses dateless alias keys for every model). A
// bug here would corrupt the refresh diff — either flagging the
// active default as "removed" or zeroing out live pricing on apply.

import { describe, expect, it } from 'vitest';
import { mergeDiscoveryWithPricing, normalizeModelId } from './models.js';

const PRICING_SEED = {
  models: [
    {
      model_id: 'claude-opus-4-7',
      display_name: 'Claude Opus 4.7',
      input_per_mtok: 5,
      output_per_mtok: 25,
      cache_write_per_mtok: 6.25,
      cache_read_per_mtok: 0.5,
      tokenizer_factor: 1.18,
      web_fetch_unit_cost: 0.01,
      web_search_unit_cost: 0.01,
      is_active: true,
    },
    {
      model_id: 'claude-haiku-4-5',
      display_name: 'Claude Haiku 4.5',
      input_per_mtok: 1,
      output_per_mtok: 5,
      cache_write_per_mtok: 1.25,
      cache_read_per_mtok: 0.1,
      tokenizer_factor: 1,
      web_fetch_unit_cost: 0.01,
      web_search_unit_cost: 0.01,
      is_active: true,
    },
    {
      model_id: 'claude-sonnet-4-5',
      display_name: 'Claude Sonnet 4.5',
      input_per_mtok: 3,
      output_per_mtok: 15,
      cache_write_per_mtok: 3.75,
      cache_read_per_mtok: 0.3,
      tokenizer_factor: 1,
      web_fetch_unit_cost: 0.01,
      web_search_unit_cost: 0.01,
      is_active: false,
    },
  ],
};

describe('normalizeModelId', () => {
  it('strips a trailing -YYYYMMDD date snapshot', () => {
    expect(normalizeModelId('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5');
    expect(normalizeModelId('claude-sonnet-4-5-20250929')).toBe('claude-sonnet-4-5');
    expect(normalizeModelId('claude-opus-4-1-20250805')).toBe('claude-opus-4-1');
  });

  it('leaves dateless IDs alone (4.6 generation forward)', () => {
    expect(normalizeModelId('claude-opus-4-7')).toBe('claude-opus-4-7');
    expect(normalizeModelId('claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
    expect(normalizeModelId('claude-haiku-4-5')).toBe('claude-haiku-4-5');
  });

  it('does not strip suffixes that are not 8 digits', () => {
    expect(normalizeModelId('claude-3-opus')).toBe('claude-3-opus');
    expect(normalizeModelId('claude-2-1')).toBe('claude-2-1');
    expect(normalizeModelId('claude-3-opus-2024')).toBe('claude-3-opus-2024');
  });
});

describe('mergeDiscoveryWithPricing', () => {
  it('joins a dated API ID to its dateless alias-keyed pricing row', () => {
    const out = mergeDiscoveryWithPricing(
      [
        {
          id: 'claude-haiku-4-5-20251001',
          display_name: 'Claude Haiku 4.5',
          created_at: '2025-10-01T00:00:00Z',
        },
      ],
      PRICING_SEED,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.model_id).toBe('claude-haiku-4-5');
    expect(out[0]!.input_per_mtok).toBe(1);
    expect(out[0]!.output_per_mtok).toBe(5);
    expect(out[0]!.pricing_unknown).toBeUndefined();
  });

  it('joins a dateless API ID directly without normalization affecting it', () => {
    const out = mergeDiscoveryWithPricing(
      [
        {
          id: 'claude-opus-4-7',
          display_name: 'Claude Opus 4.7',
          created_at: '2026-04-01T00:00:00Z',
        },
      ],
      PRICING_SEED,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.model_id).toBe('claude-opus-4-7');
    expect(out[0]!.input_per_mtok).toBe(5);
    expect(out[0]!.tokenizer_factor).toBe(1.18);
  });

  it('emits pricing_unknown:true with zeroed prices for an unknown model', () => {
    const out = mergeDiscoveryWithPricing(
      [
        {
          id: 'claude-sonnet-5-future',
          display_name: 'Claude Sonnet 5 (Future)',
          created_at: '2027-01-01T00:00:00Z',
        },
      ],
      PRICING_SEED,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.pricing_unknown).toBe(true);
    expect(out[0]!.model_id).toBe('claude-sonnet-5-future');
    expect(out[0]!.input_per_mtok).toBe(0);
    expect(out[0]!.is_active).toBe(false);
  });

  it('dedups when Anthropic returns both dated and dateless forms of the same model', () => {
    // Defensive — Anthropic generally returns one canonical ID per
    // model, but if the API ever surfaces both, the merge must collapse
    // them to a single row.
    const out = mergeDiscoveryWithPricing(
      [
        {
          id: 'claude-haiku-4-5',
          display_name: 'Claude Haiku 4.5',
          created_at: '2025-10-01T00:00:00Z',
        },
        {
          id: 'claude-haiku-4-5-20251001',
          display_name: 'Claude Haiku 4.5 (snapshot)',
          created_at: '2025-10-02T00:00:00Z',
        },
      ],
      PRICING_SEED,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.model_id).toBe('claude-haiku-4-5');
  });

  it('joins all three legacy generations against the alias-keyed seed', () => {
    const out = mergeDiscoveryWithPricing(
      [
        {
          id: 'claude-sonnet-4-5-20250929',
          display_name: 'Claude Sonnet 4.5',
          created_at: '2025-09-29T00:00:00Z',
        },
        {
          id: 'claude-haiku-4-5-20251001',
          display_name: 'Claude Haiku 4.5',
          created_at: '2025-10-01T00:00:00Z',
        },
      ],
      PRICING_SEED,
    );
    expect(out.map((m) => m.model_id).sort()).toEqual(['claude-haiku-4-5', 'claude-sonnet-4-5']);
    expect(out.every((m) => !m.pricing_unknown)).toBe(true);
  });

  it('returns an empty array when no models were discovered', () => {
    expect(mergeDiscoveryWithPricing([], PRICING_SEED)).toEqual([]);
  });

  it('handles a missing pricing manifest by emitting pricing_unknown for every model', () => {
    const out = mergeDiscoveryWithPricing(
      [
        {
          id: 'claude-opus-4-7',
          display_name: 'Claude Opus 4.7',
          created_at: '2026-04-01T00:00:00Z',
        },
      ],
      null,
    );
    expect(out[0]!.pricing_unknown).toBe(true);
  });
});
