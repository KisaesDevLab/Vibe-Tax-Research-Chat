# Cost model

How dollar costs are computed from token counts. Source: BUILD_PLAN §3.6, §6, §8.

## The formula

For every assistant turn, the streaming response ends with a `message_delta` event whose
`usage` block contains:

- `input_tokens`
- `output_tokens`
- `cache_creation_input_tokens`
- `cache_read_input_tokens`

The appliance also counts:

- `web_fetch_calls` — number of `web_fetch` `tool_use` blocks observed
- `web_search_calls` — number of `web_search` `tool_use` blocks observed

Cost in USD:

```
cost_usd =
    (input_tokens                * input_per_mtok        / 1_000_000)
  + (output_tokens               * output_per_mtok       / 1_000_000)
  + (cache_creation_input_tokens * cache_write_per_mtok  / 1_000_000)
  + (cache_read_input_tokens     * cache_read_per_mtok   / 1_000_000)
  + (web_fetch_calls   * web_fetch_unit_cost)
  + (web_search_calls  * web_search_unit_cost)
```

Implementation: `apps/api/src/lib/cost/calc.ts` (pure function), tested in `calc.test.ts`.

## Streaming cost UX

During the stream the UI shows a **provisional** cost based on a `chars / 4` estimate of
output tokens. The provisional value snaps to the actual on the final `message_delta`. The
estimate is intentionally cheap; a Haiku tokenizer call would add ~$0.001 per turn for an
imperceptible accuracy gain.

## Opus 4.7 tokenizer caveat

Opus 4.7 uses a **new tokenizer** that produces up to 35% more tokens for the same input
text than Opus 4.6. The model registry stores a `tokenizer_factor` (1.18 for 4.7, 1.0 for
the others) so admin spend forecasts can multiply against the per-Mtok rate accurately.

Practical consequence for the §199A QBI question (BUILD_PLAN §12 reference turn): Opus 4.7
costs approximately the same per-token as 4.6 but **18% more per turn** because it emits
~18% more tokens for the same prose.

## Cache reads

Anthropic's prompt cache reads cost **~10% of the input rate** (`cache_read_per_mtok` ≈
`input_per_mtok / 10`). The appliance places a cache breakpoint immediately after the system
prompt, so the second turn of any chat enjoys a cache hit on the system prompt + tool defs +
attached skill manifest. A typical second turn saves ~$0.045 vs the first turn.

## Per-firm spend caps

Admin → Users → set `monthly_spend_cap_usd`. The cap is checked before each new turn:

- If MTD spend by the user exceeds the cap → return 402 with `{ error: 'spend_cap_exceeded',
cap_usd, mtd_usd }`.
- The check uses the materialized `usage_daily` rollup for speed; admin can increase the cap
  and the next turn is unblocked immediately.

## Per-model web budget

The `models` table's `fetches_per_turn` and `searches_per_turn` cap how many web-tool calls a
single turn can make. Defaults: 12 fetches, 10 searches for Sonnet 4.6 / Opus; 0 / 0 for Haiku (raised from
8 / 4 in migration 0018, alongside the 50-state allowlist expansion).
The cap is enforced by Anthropic's `max_uses` parameter on `web_fetch` / `web_search`.

## Reference turn (§199A QBI)

Per BUILD_PLAN §8, the reference research turn against Sonnet 4.6 with web tools enabled
should land near **$0.092 (~$0.10) end-to-end**:

| Component             | Estimate |
| --------------------- | -------: |
| 4 `web_fetch` calls   |   $0.040 |
| Input tokens          |   $0.012 |
| Output tokens         |   $0.040 |
| Cache reads (turn 2+) |   $0.000 |
| **Total**             |   $0.092 |
