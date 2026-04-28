# Web resources

How the appliance lets Claude consult primary sources during a turn. Source: BUILD_PLAN
§3.7, §5 Phases 16–17.

## v1 strategy: Anthropic web tools, locked allowlist

The appliance enables `web_fetch` and `web_search` (Anthropic server tools) on Sonnet 4.6
and Opus 4.x by default. Both tools are configured with a **fixed `allowed_domains` list**
defined in `packages/shared/src/web-allowlist.ts`:

| Domain                       | What                                                              |
| ---------------------------- | ----------------------------------------------------------------- |
| `uscode.house.gov`           | USLM, IRC sections, Popular Name Tool, Classification Tables      |
| `ecfr.gov`                   | Treasury Regulations (Title 26 CFR)                               |
| `federalregister.gov`        | TDs, proposed regs, IRS notices                                   |
| `dawson.ustaxcourt.gov`      | Tax Court opinions                                                |
| `irs.gov`                    | IRS Bulletin, Rev. Procs, Rev. Ruls, Notices                      |
| `govinfo.gov`                | Public Law text                                                   |
| `ftb.ca.gov`                 | California FTB                                                    |
| `tax.ny.gov`                 | NY DTF                                                            |
| `comptroller.texas.gov`      | Texas Comptroller                                                 |
| `floridarevenue.com`         | Florida DOR                                                       |
| `tax.illinois.gov`           | Illinois DOR                                                      |
| `revenue.pa.gov`             | Pennsylvania DOR                                                  |
| `tax.ohio.gov`               | Ohio Department of Taxation                                       |
| `nj.gov`                     | NJ Division of Taxation (path: `/treasury/taxation`)              |
| `dor.georgia.gov`            | Georgia DOR                                                       |
| `ncdor.gov`                  | NC DOR                                                            |

Per-turn budget defaults (overridable per-model in the `models` table):

- 8 fetches / turn
- 4 searches / turn

## Audit trail

Every `tool_use` and `tool_result` block in the stream is observed by the chat handler and
persisted to `primary_source_consultations`:

| Column                | Captured                                                  |
| --------------------- | --------------------------------------------------------- |
| `tool_name`           | `web_fetch` / `web_search` / `mcp:<name>` (v1.5)          |
| `url` / `query`       | Whichever the tool input contained                        |
| `domain`              | Hostname of the URL (for grouping in admin UI)            |
| `fetched_at`          | Timestamp of the `tool_use` event                         |
| `response_status`     | 200 / 5xx based on `is_error` flag in `tool_result`       |
| `response_excerpt`    | First 2 KB of the response (for citation cross-reference) |
| `cited_in_authorities`| Set true after Phase 18 cross-references the sidecar       |

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
