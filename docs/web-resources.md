# Web resources

How the appliance lets Claude consult primary sources during a turn. Source: BUILD_PLAN
§3.7, §5 Phases 16–17.

## v1 strategy: Anthropic web tools, locked allowlist

The appliance enables `web_fetch` and `web_search` (Anthropic server tools) on Sonnet 4.6
and Opus 4.x by default. Both tools are configured with a **fixed `allowed_domains` list**
defined in `packages/shared/src/web-allowlist.ts`:

The list is **90 entries**: six federal primary sources, plus every state and DC.

| Domain                  | What                                                         |
| ----------------------- | ------------------------------------------------------------ |
| `uscode.house.gov`      | USLM, IRC sections, Popular Name Tool, Classification Tables |
| `ecfr.gov`              | Treasury Regulations (Title 26 CFR)                          |
| `federalregister.gov`   | TDs, proposed regs, IRS notices                              |
| `dawson.ustaxcourt.gov` | Tax Court opinions                                           |
| `irs.gov`               | IRS Bulletin, Rev. Procs, Rev. Ruls, Notices                 |
| `govinfo.gov`           | Public Law text                                              |
| 84 state entries        | Revenue agency + statutory code for all 50 states and DC     |

State coverage was previously the ten most populous states' revenue departments only,
which meant a question about any other state — Missouri, say — searched a universe with
no Missouri in it, returned nothing, and let the model fall back to its own memory. Read
the file for the per-state entries; the rules that shape it:

- **A listed domain covers all of its subdomains.** `mo.gov` reaches both `dor.mo.gov`
  and `revisor.mo.gov`, so most states are a single bare state domain. A listed
  _subdomain_ covers only itself — `dor.mo.gov` would not reach the Revisor.
- **A second entry is added only where the agency sits off the state domain** — Arizona
  (`azdor.gov`), Illinois statutes (`ilga.gov`), Pennsylvania statutes (`palegis.us`), and
  so on.
- **A cross-domain redirect needs both sides listed**, because the filter re-applies to
  the target. Maryland is the live case: `marylandtaxes.gov` → `marylandcomptroller.gov`.
- **Entries must be plain ASCII hostnames** — no scheme, port, path, or wildcard. Web
  fetch matches the domain only, so a path entry never matches a fetch URL.
- An entry need not serve a homepage itself. `ky.gov`, `newmexico.gov`, `wyo.gov`, and
  `legislature.state.al.us` are all dead at the apex but are the right covers for the
  agencies beneath them.

`packages/shared/src/web-allowlist.test.ts` enforces the mechanical half of that
(duplicates, malformed entries, entries already covered by a broader one).

Two operational limits worth knowing before extending the list:

- Request-level `allowed_domains` must be a **subset of any organization-level allowlist**
  configured in the Claude Console. An entry outside it fails the entire request with a
  400 naming the conflict — it does not silently degrade.
- `web_search` can return `request_too_large` when the domain filter list is long. That is
  why the list is compacted onto bare state domains; prefer widening an existing entry
  over appending a new one.

Per-turn budget defaults (overridable per-model in the `models` table):

- 12 fetches / turn
- 10 searches / turn

Raised from 8 / 4 when state coverage went from ten states to all 51 jurisdictions. A
multi-state question has to search and then verify per jurisdiction, and the old ceiling
was reached mid-answer — at which point the model had no verified source left to cite and
was liable to close the gap from memory. Anthropic's guidance is that comparative or
multi-entity research "can use 10 or more" searches. Search bills $10 / 1,000 (about
$0.10 per turn at the cap); fetch adds no charge beyond the tokens it pulls in.

`claude-haiku-4-5` stays at 0 / 0 — web tools are deliberately off for it, and migration
0018 matches the old 8 / 4 pair specifically so that row (and any admin-tuned row) is left
alone.

## Audit trail

Every `tool_use` and `tool_result` block in the stream is observed by the chat handler and
persisted to `primary_source_consultations`:

| Column                 | Captured                                                  |
| ---------------------- | --------------------------------------------------------- |
| `tool_name`            | `web_fetch` / `web_search` / `mcp:<name>` (v1.5)          |
| `url` / `query`        | Whichever the tool input contained                        |
| `domain`               | Hostname of the URL (for grouping in admin UI)            |
| `fetched_at`           | Timestamp of the `tool_use` event                         |
| `response_status`      | 200 / 5xx based on `is_error` flag in `tool_result`       |
| `response_excerpt`     | First 2 KB of the response (for citation cross-reference) |
| `cited_in_authorities` | Set true after Phase 18 cross-references the sidecar      |

Admin sees consultations per chat at `/admin/usage` (filterable). Per-firm SQL example:

```sql
SELECT domain, COUNT(*) AS hits, MAX(fetched_at) AS last_seen
FROM primary_source_consultations
WHERE fetched_at >= NOW() - INTERVAL '30 days'
GROUP BY domain ORDER BY hits DESC;
```

## v1.5 migration: appliance-side MCP authority server

Per-source feature flag in `settings.web_resource_strategy`:

```json
{
  "usc": "mcp",
  "cfr": "mcp",
  "irb": "anthropic",
  "fr": "anthropic",
  "dawson": "anthropic",
  "govinfo": "mcp",
  "state_dor": "anthropic"
}
```

End state (after Phase 36): all sources → `mcp`, with `authority_cache` taking the load.
Target: 80% cache hit rate, sub-100ms cached lookups, full appliance-side bytes (no PII or
client identifiers ever transit Anthropic's edge for primary-source fetches).

## Strict mode

Per-firm setting `hide_unverified_citations` (default off):

- **Off**: Claude's unverified citations render with a red ✗ chip; user can decide.
- **On**: unverified citations are stripped from the rendered prose; the user only sees
  authorities backed by an in-turn fetch.

This is the SOX / strict-firm mode. The default off is per BUILD_PLAN §7.
