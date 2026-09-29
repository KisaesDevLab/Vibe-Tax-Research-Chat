import { describe, it, expect } from 'vitest';
import { modelIdFromDisplayName, parsePricingMarkdown } from './pricing-page.js';

// Rows copied from the live page (2026-09-29), including the shapes that make
// it awkward: footnote markers, a linked parenthetical after the name, and a
// second table further down that must not be read as prices.
const PAGE = `
# Pricing

## Model pricing

| Model | Base input tokens | 5m cache writes | 1h cache writes | Cache hits and refreshes | Output tokens |
| :---- | :---------------- | :-------------- | :-------------- | :----------------------- | :------------ |
| Claude Fable 5.1 | $10 / MTok | $12.50 / MTok | $20 / MTok | $0.25 / MTok<sup>1</sup> | $50 / MTok |
| Claude Mythos 5.1 ([limited availability](https://anthropic.com/glasswing)) | $10 / MTok | $12.50 / MTok | $20 / MTok | $0.25 / MTok<sup>1</sup> | $50 / MTok |
| Claude Opus 5.5 | $4 / MTok | $5 / MTok | $8 / MTok | $0.20 / MTok<sup>2</sup> | $20 / MTok |
| Claude Opus 4.7 | $5 / MTok | $6.25 / MTok | $10 / MTok | $0.50 / MTok | $25 / MTok |
| Claude Opus 4.1 ([retired, except on Bedrock and Google Cloud](https://platform.claude.com/docs/en/about-claude/model-deprecations)) | $15 / MTok | $18.75 / MTok | $30 / MTok | $1.50 / MTok | $75 / MTok |
| Claude Sonnet 5 | $2 / MTok<sup>3</sup> | $2.50 / MTok | $4 / MTok | $0.20 / MTok | $10 / MTok<sup>3</sup> |
| Claude Haiku 4.5 | $1 / MTok | $1.25 / MTok | $2 / MTok | $0.10 / MTok | $5 / MTok |

*<sup>All other models use the standard 0.1x multiplier.</sup>*

### Batch processing

| Model | Batch input | Batch output |
| :---- | :---------- | :----------- |
| Claude Opus 5.5 | $2 / MTok | $10 / MTok |
`;

describe('modelIdFromDisplayName', () => {
  it('maps a display name onto the dateless alias the registry keys by', () => {
    expect(modelIdFromDisplayName('Claude Opus 5.5')).toBe('claude-opus-5-5');
    expect(modelIdFromDisplayName('Claude Fable 5.1')).toBe('claude-fable-5-1');
    expect(modelIdFromDisplayName('Claude Sonnet 5')).toBe('claude-sonnet-5');
  });

  it('refuses anything that is not a plain model name', () => {
    expect(modelIdFromDisplayName('Claude Opus 5 / Claude Opus 4.8')).toBeNull();
    expect(modelIdFromDisplayName('Session runtime')).toBeNull();
    expect(modelIdFromDisplayName('')).toBeNull();
  });
});

describe('parsePricingMarkdown', () => {
  const result = parsePricingMarkdown(PAGE);
  const byId = new Map(result.ok ? result.prices.map((p) => [p.model_id, p]) : []);

  it('reads every model row of the pricing table and nothing after it', () => {
    expect(result.ok).toBe(true);
    expect([...byId.keys()]).toEqual([
      'claude-fable-5-1',
      'claude-mythos-5-1',
      'claude-opus-5-5',
      'claude-opus-4-7',
      'claude-opus-4-1',
      'claude-sonnet-5',
      'claude-haiku-4-5',
    ]);
  });

  it('takes the 1-hour cache write rate, not the 5-minute one', () => {
    // Chat sets ttl '1h' on every breakpoint, so this is the rate it pays.
    expect(byId.get('claude-opus-4-7')).toMatchObject({
      input_per_mtok: 5,
      output_per_mtok: 25,
      cache_write_per_mtok: 10,
      cache_read_per_mtok: 0.5,
    });
  });

  it('keeps per-model cache-read discounts that break the 0.1x rule', () => {
    expect(byId.get('claude-fable-5-1')?.cache_read_per_mtok).toBe(0.25);
    expect(byId.get('claude-opus-5-5')?.cache_read_per_mtok).toBe(0.2);
  });

  it('strips footnote markers and linked parentheticals', () => {
    expect(byId.get('claude-sonnet-5')).toMatchObject({ input_per_mtok: 2, output_per_mtok: 10 });
    expect(byId.get('claude-opus-4-1')?.display_name).toBe('Claude Opus 4.1');
  });

  it('rejects a page with no pricing table', () => {
    expect(parsePricingMarkdown('<html>Not found</html>')).toEqual({
      ok: false,
      error: 'pricing_table_not_found',
    });
  });

  it('rejects a table whose columns were renamed rather than guessing by position', () => {
    const renamed = PAGE.replace('1h cache writes', 'Extended cache writes');
    expect(parsePricingMarkdown(renamed)).toEqual({
      ok: false,
      error: 'pricing_table_columns_changed',
    });
  });

  it('drops implausible rows, and the whole page when too few survive', () => {
    // Output cheaper than input can only be a misparse.
    const broken = PAGE.replace(/\$(\d+) \/ MTok \|$/gm, '$0.01 / MTok |');
    expect(parsePricingMarkdown(broken)).toEqual({
      ok: false,
      error: 'pricing_table_unparseable',
    });
  });
});
