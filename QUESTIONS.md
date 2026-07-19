# QUESTIONS.md

Ambiguities encountered during the autonomous build, with the default applied and where to flip
the switch later. Per the kickoff protocol: pick a reasonable default consistent with §3 of
`BUILD_PLAN.md`, log here, never block.

---

## Scaffolding scope (kickoff)

**Question:** The kickoff prompt asked for a full v1.0.0 build in one autonomous session.
**Default applied:** Wide-scaffolding pass (kickoff option 2), then promoted in a follow-up
turn to a _fully functional_ build. The appliance now boots end-to-end: Postgres + Redis come
up via Docker, `pnpm db:migrate` + `pnpm db:seed` populate the schema, the API starts, the
auth flow works (login, refresh, /auth/me, role gates), and chat creation + streaming SSE
gracefully report a missing key when one isn't configured. The Anthropic SDK calls are real
(no `as unknown as` shims for invented APIs); the only casts remaining are for the still-
untyped `container.skills[]` and the new `code_execution_20250825` / `web_fetch_20250828` /
`web_search_20250828` tool shapes — those will go away when the SDK ships them in a stable
release.
**What is NOT verified:** the actual §199A QBI reference turn cannot be tested without a
real Anthropic API key. The chat plumbing has been smoke-tested end-to-end (request →
auth → routing → SSE open → graceful error when key is absent).
**Rationale:** Real working appliance > fake "v1.0.0" claim. A CPA can install this and use
it; the only step missing on first run is "paste your own Anthropic key into Settings."
**Reversible:** Yes — TODOs in code mark every spot where more work is required (e.g.,
custom-skill packaging step in `routes/admin/custom-skills.ts`, OCR fallback in
`lib/parsers/index.ts`, MCP authority server in v1.5).

## Missing reference assets

**Question:** `mockup.html` is referenced by Phases 14, 15, 18, 19, 20 as the visual target but
is not present in the repo. Same for `KICKOFF_PROMPT.md`.
**Default applied:** Chat view is built to the editorial-aesthetic description in the kickoff
prompt (warm paper #f7f3ec, deep ink #1a1714, oxblood #7a2a1a, moss #2f4a30, gold #b48a3a,
Fraunces / Source Serif 4 / JetBrains Mono). Authorities/Compliance/Skills/Cost panels are
first-class as described.
**Rationale:** The aesthetic description is enough to scaffold the panels; a real mockup would
sharpen spacing, hierarchy, and microcopy.
**Reversible:** Yes — drop `mockup.html` into the repo root and re-evaluate `apps/web/src/styles/theme.ts` and the chat panels under `apps/web/src/components/panels/`.

## Skills repo content

**Question:** The Vibe-Claude-Tax-Research-Skills upstream repo is referenced for ingestion
(Phase 7) and routing (Phase 11), but the actual skill content cannot be assumed in this build
session.
**Default applied:** Ingestion + parser + routing logic written against the documented SKILL.md
shape (YAML frontmatter with `name`, `description`, optional `status`). Fixture skills under
`packages/db/seeds/fixture-skills/` exercise the parser. The 8-skill cap and always-attached
`cpa-pack-index` + `compliance-ssts-circular230` are honored.
**Rationale:** Parser and routing must be deterministic and testable before the actual repo is
synced.
**Reversible:** Drop the real repo, re-run `pnpm tsx scripts/skills-ingest.ts`.

## Manifest URL availability

**Question:** `https://vibemb.com/manifests/anthropic-models.json` is the documented refresh
target for the model registry (Phase 6). Network state in the build env is unknown.
**Default applied:** Refresh endpoint fetches the URL with 5-second timeout and returns a
structured diff (`{ added, updated, removed, unchanged }`). On fetch failure: returns an error
the UI surfaces, no DB mutation. Bundled `packages/db/seeds/models.json` always seeds the table
on first run.
**Rationale:** Operability is more important than blocking on network at install time.
**Reversible:** Set `MODELS_MANIFEST_URL` to a different host.

## Cost-streaming UX

**Question:** Pure JS estimate vs periodic Haiku tokenizer call (kickoff §10 item 6).
**Default applied:** JS estimate (`chars / 4`) during streaming, snaps to actual on
`message_delta`.
**Rationale:** Cheap, no extra API spend per turn.
**Reversible:** Swap `apps/web/src/components/CostLedger.tsx` provisional logic.

## Chat history retention

**Question:** Forever vs 7 years (kickoff §10 item 2).
**Default applied:** Forever; admin-configurable via `settings.chat_retention_days` (null =
forever).
**Reversible:** Change setting; nightly job in `apps/api/src/jobs/retention.ts` (stub).

## Per-chat model override

**Question:** Admin-only or per-user (kickoff §10 item 5).
**Default applied:** Per-user, gated by `users.can_override_model` flag (default true).
**Reversible:** Flip the flag, or remove the model picker from `apps/web/src/components/ChatHeader.tsx`.

## Single API key vs per-user

**Question:** Per-user keys for individual billing (kickoff §10 item 1).
**Default applied:** Single appliance key in v1; the schema does **not** include a per-user
override column to keep migration cleanly reversible.
**Reversible:** v1.5 phase will add `users.anthropic_key_ciphertext` and a fallback chain.

## Stub-state warnings

**Question:** Banner on assistant messages citing `stub`-status skills (kickoff §10 item 4).
**Default applied:** Yes — the Authorities panel renders a warning chip when any cited authority
comes from a skill whose `skill_versions.status_field == 'stub'`.
**Reversible:** Suppress in `apps/web/src/components/panels/AuthoritiesPanel.tsx`.

## Dispatcher visibility

**Question:** Show or hide the dispatcher's chosen skills in UI (kickoff §10 item 3).
**Default applied:** Show. Phase 20's Skills panel renders `cpa-pack-index` (oxblood),
`compliance-ssts-circular230` (moss), and routed skills.
**Reversible:** Hide via `settings.show_skills_panel = false`.

---

# Planning module (MASTER-BUILD-PLAN.md, slice TP-0…TP-3 + TP-11)

## Planning feature flag mechanism

**Question:** MASTER-BUILD-PLAN TP-0 says "scaffold the `planning` feature flag" without
specifying env vs DB.
**Default applied:** DB-backed setting `planning_enabled` (settings KV, seeded false) so
admins flip it without redeploying; admin write path `POST
/api/admin/settings/planning-enabled`, effective value exposed via new authenticated
`GET /api/config` (no public config endpoint existed before). All planning/clients API
surfaces respond 404 via `requirePlanning` middleware when off.
**Reversible:** Move to env or licensing entitlement later; the middleware is the single
read point.

## T&B client sync

**Question:** TP-3 specifies T&B-synced clients (nightly + on-demand), but the repo has
no T&B integration, API spec, or credentials.
**Decision (user, 2026-07-19):** Local-only clients in this slice — no provenance/
tb_client_id columns and no sync scaffolding. T&B fields + sync adapter land later as an
additive migration. `merged_into_id` is kept now because TP-11 retention rules depend on
merge.

## PII detect pass for archival

**Question:** TP-11 routes archive snapshots through Vibe Shield (Presidio) in detect
mode; no Shield exists in this repo (`pii_strip_enabled` is a seeded key with no
implementation).
**Decision (user, 2026-07-19):** Local in-process detector (regex + context rules for
SSN/EIN/account numbers) with the same hits + one-click-redaction UX before the snapshot
freezes. Swappable for Shield/Presidio later behind the same detect interface.

## Archive search reconciliation (TP-3 vs TP-11)

**Question:** TP-3 requires cross-client search with "no PII in the index"; TP-11 requires
per-client full-text search over archives. How do both hold at once?
**Default applied:** Per-client FTS (`GET /api/archives?client_id&q`) runs over the
POST-redaction `snapshot_text` behind the client scope. Cross-client search
(`GET /api/clients/search`) matches only client names and archive titles/topic tags —
snapshot bodies are never in the cross-client index.

## Bulk archive and PII

**Question:** How does bulk multi-select archive interact with the PII detect pass?
**Default applied:** Bulk uses chat titles (no Claude call) and refuses to silently
archive any chat with detector hits — those return as `pii_review_required` for
individual handling in the single-session dialog.

## Claude-drafted title/tags at archive time

**Default applied:** Synchronous Haiku call with a 10 s timeout mirroring the chat-title
job; on no key / timeout / parse failure the dialog falls back to the chat's existing
title and empty tags. Archival never blocks on the API.

---

# Planning module — remaining build (TP-4…TP-16), applied defaults 2026-07-19

## Build-environment adaptations (user directed "complete the entire build without interruption")

**No Anthropic API key at build time:** all runtime Claude jobs ship with tested
graceful no-key degradation; the 100 strategy content records are authored at build
time as original prose (schema-valid JSON seeds); the runtime author:draft pipeline
still ships fully built.
**No external systems** (T&B, Connect portal, Shield/Presidio, vibellm/GLM-OCR,
OpenSign, Stripe, licensing.kisaes.com, Vault/B2): adapter seams + config-driven
no-ops; webhook handlers tested with signed fixtures; manual-override endpoints;
delivery = staff-manual + HMAC signed links; entitlement client fail-open for
internal/advisor renders, fail-closed for client-facing.
**Workers stay in the API process** (existing createWorker pattern) — no apps/worker.
Playwright Chromium for pdf-render runs in-process; docker-image implications
documented, not solved here.

## Engine numeric precision

Integer cents internally (half-up rate multiplication); IRS-line checkpoints and wire
types carry whole dollars; golden tolerance default $1.

## Engine v1 simplifications (documented in module headers)

MAGI = AGI (no foreign-income addbacks). §469 allowance phase-out uses AGI before
passive losses as the MAGI proxy. PTET modeled as entity-level deduction +
dollar-for-dollar state credit against the flat-state liability. OBBBA's 2/37
itemized-benefit haircut for 37%-bracket taxpayers deferred with AMT et al.
Deferred per master plan: AMT, refundable ACTC, UBIA prong, §461(l), non-flat states.

## Migration map (additive-only)

0007 table_sets · 0008 strategies/strategy_versions/golden_tests/review_queue ·
0009 plans/plan_scenarios/plan_results/plan_research_links + research_archives.plan_id
FK (plans tables land at TP-6, not TP-8 — the walking skeleton needs them) ·
0010 deliverables/deliverable_links · 0011 engagements/webhook_events ·
0012 hand-written triggers.

## Strategy content home

JSON records in packages/strategies/content/<id>.json (goldens inline); db seed loads
idempotently — onConflictDoNothing on (strategy_id, semver), current_version_id set
only when NULL so admin publishes are never clobbered by re-seeds.

## TP-12 — applied defaults (authoring at scale)

- **entityTypes vocabulary** — the schema validator canonicalizes the vocabulary the
  TP-6 content already used: `sole-prop`, `single-member-llc`, `s-corp`, `partnership`,
  `c-corp`, `rental`, `individual`.
- **Banned-word gate scope** — "loophole/trick/secret/guarantee" is enforced on CLIENT
  sections only. Advisor prose is exempt because legitimate terms of art ("guaranteed
  payments" under §707(c)) would false-positive. The reading-level gate (FK ≤ 9) is
  measured over `client.plainEnglish + client.analogy`; fragment lists are excluded.
- **Mechanics↔authority mapping** — enforced as: any §-token named in a mechanics bullet
  must appear in some authority cite. Cites are tokenized leniently so `IRC §§702, 1366`
  covers both sections.
- **Structural spec** — everything machine-critical for the 90 new records (classification,
  applyOrder, inputs schema, suggest rule, interactions, golden cases) lives in
  `packages/strategies/spec/tp12-spec.mjs`; scaffold + embed scripts stamp it into content.
  Prose was authored to the schema and validated by `scripts/validate-content.mjs`.
- **Golden deltas** — computed exclusively through the engine by
  `scripts/embed-goldens.mjs` (94 new cases). The one intentionally positive delta
  (bracket-management income acceleration) is declared via `model.mayIncreaseBurden`.
- **Author-pipeline model pin** — `strategy-author` uses `claude-sonnet-4-5` pinned in the
  handler; TP-13 centralizes per-job pins/budgets in `jobs-config.ts`. No key → the job
  logs a skip and succeeds (pipeline idles until credentials arrive).
- **spouse-payroll modeling** — modeled honestly as near-neutral on payroll tax (employer
  FICA deducted, employee FICA added to otherTaxes); the record's value story is the
  benefit doors (§105 MERP, retirement capacity). `mayIncreaseBurden: true`.
- **c-corp-conversion modeling** — flow-through removed, 21% corp tax surfaced via
  `corpTaxPaid`, salary + optional qualified dividends on the 1040; QBI forfeiture and
  second-layer tax called out in notes. `mayIncreaseBurden: true`.
- **Content items flagged for partner spot-check** (from the authoring pass; all records
  pass the automated gates, these are substance checks): WOTC 2026 hires are written as
  reauthorization-contingent (credit lapsed 12/31/2025; extension bills pending) — revisit
  published status if reauthorization stalls; RSMo §143.022 20% business-income deduction
  described as having no SSTB/wage limits; Missouri MOST 529 figures and RSMo §§143.113/
  143.114 cites drawn from memory; a handful of older case cites (Lone Manor Farms, Denman,
  Pohoski, Nielsen, FedEx W.D. Tenn., Dixie Dairies, Durden, Sanford) pass format lint but
  merit a cite-check before client-facing use; OZ 2.0 (rolling deferral, rural step-ups)
  follows post-OBBBA secondary sources pending implementing guidance.

## TP-13 — applied defaults (Claude seam)

- **Seam surface** — streaming keeps `getAnthropic()` (kill switch + Shield routing apply
  there too); every background job goes through `callClaude(job, request)` with per-job
  model pins and HARD token budgets in `lib/anthropic/jobs-config.ts` (TP-14 job budgets
  pre-declared). Retry: 3 attempts, exponential backoff + jitter, on 429/5xx/network only.
- **Audit** — every `callClaude` writes a `claude.call` audit row with SHA-256 request/
  response hashes, token usage, and attempt count; payloads are never persisted (tested).
  Terminal failures also leave an audit row with `failed: true`.
- **ZDR** — org-level Anthropic account setting, not a request header; carried on the
  TP-15 deployment checklist instead of code.
- **Kill switch semantics** — `ANTHROPIC_KILL_SWITCH=1|true|on` blocks before the key is
  even read; the chat stream surfaces the typed message via its existing error event +
  system_note path; job handlers treat it like no-key (logged skip).

## TP-14 — applied defaults (currency jobs)

- **Queues/crons** — tables-draft (Oct 1 annual), strategy-watch (Mon 05:00),
  archive-scan (Mon 05:30), golden-regression (on table publish), strategy-refresh
  (on demand; full sweep when no strategy_id, aborting after the first no-key skip).
- **golden-regression is pure-local** — replays every golden_tests row for currently
  published strategy versions through the engine against the target table set; drift
  beyond tolerance opens one review item per affected strategy. Verified live: publish
  of a payload-identical set ran 112 goldens, 0 failures.
- **archive-scan is pure-local** — case-insensitive keyword match (keywords ≥ 4 chars)
  of current-version monitoring.keywords vs active research_archives archived after the
  record's lastReviewed; open-item dedup per (strategy, archive). Verified live: 6 hits
  opened once, 0 on re-run.
- **strategy-watch seen-store** — Redis SETNX with 180-day TTL on
  sha256(strategy:headline:source); heartbeat audit row (strategy_watch.run) written
  even when quiet so silence is distinguishable from breakage. Uses the server-side
  web_search tool (cast through the seam — SDK doesn't type it yet).
- **Plan memos** — PLAN_MEMOS_ENABLED setting (seeded false); POST
  /api/planning/plans/:id/memo returns 403 memos_disabled when off, 409 no_results
  before compute, 503 claude_unavailable without a key, and always prepends a DRAFT
  banner. Claude narrates engine-computed figures only.
- **needs-module-change** — pipeline strategy drafts whose model block (module ref,
  applyOrder, or inputs schema) differs from the published version are flagged in the
  review payload; the queue decision alone cannot ship a math change.
