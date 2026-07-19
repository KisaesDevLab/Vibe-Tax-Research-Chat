# Vibe Tax Research — Planning Module — MASTER BUILD PLAN v1.0 (CONSOLIDATED)

Single self-contained plan for adding the Planning and Clients modules to the Vibe Tax
Research Chat appliance. Supersedes vibe-taxplan-build-plan.md and
vibe-taxresearch-planning-addendum.md — no cross-document references are required to
execute this plan. Companion documents (required in-repo, listed in TP-0): the strategy
authoring schema and the reference strategy library.

Decisions in this document are FINAL unless marked open. Finalized 2026-07-17.

---

## 0. Ground rules (apply to every phase)

1. **Deterministic math only.** The tax engine computes every number from versioned table
   sets and reviewed strategy transforms. The Claude API NEVER computes tax at runtime.
   Claude drafts content and diffs; humans review and publish.
2. **Everything versioned, everything pinned.** Plans snapshot `{tableSetVersion,
strategyVersions[], engineVersion}` at compute time. Reissuing an old plan reproduces
   it byte-identically. Republishing content never changes an issued plan.
3. **PII never reaches a cloud model unshielded.** All Anthropic API traffic goes through
   Vibe Shield (Presidio) on the DPA + ZDR tier. Return parsing runs locally (text-layer
   → coordinate parser; scans → GLM-OCR on vibellm). Shield is the only egress path to
   api.anthropic.com (enforced in compose network policy).
4. **Reference material.** `/reference/strategy-library/` (100 extracted strategy MD files +
   `_index.md`) is consulted for citation coverage and transform verification ONLY. All
   published prose is original, authored to `docs/strategy-schema.md`. The reference dir
   is gitignored and never ships in images.
5. **Stack:** existing Tax Research app stack — React 18 + TypeScript + Vite, Node 20 +
   Express + Drizzle, PostgreSQL 16, Redis 7 + BullMQ, Docker via GHCR, Caddy +
   Cloudflare Tunnel (public), Tailscale (staff). Licensing via licensing.kisaes.com:
   PolyForm Internal Use free tier; commercial license unlocks the
   `planning.deliverables` entitlement (client-facing rendering/delivery).
6. **Quality gate per phase:** `pnpm typecheck && pnpm lint && pnpm test && pnpm build`
   green before the phase's conventional commit. Update STATE.md after each phase; log
   open decisions in QUESTIONS.md with the chosen default and proceed.
7. **Additive-only DB migrations.** Research module behavior is unchanged with the
   `planning` feature flag off.

## 1. Concept

One appliance, three modules behind a top-level switcher:

```
┌──────────────────────────────────────────────────────────┐
│  [≡] Vibe Tax Research     Research ▾ | Planning | Clients│
├──────────────────────────────────────────────────────────┤
│  Research  — existing chat + authority server (unchanged) │
│  Planning  — strategy plans: intake → scenarios → deliver │
│  Clients   — the spine: every plan and archived session   │
│              hangs off a client record                    │
└──────────────────────────────────────────────────────────┘
```

Research and planning share users, clients, authority data, and Claude/Shield plumbing.
A research session is planning work product; clients are the join.

Runtime architecture additions (worker jobs + data flow):

```
apps/api ──► packages/engine (pure) ◄── packages/strategies (TS modules by id@semver)
   │                                        content/suggest/goldens from Postgres
apps/worker (BullMQ): pdf-render (Chromium) · tables-draft · strategy-watch ·
                      strategy-refresh · golden-regression · ocr-intake (vibellm)
Anthropic egress: apps/* ──► Vibe Shield ──► api.anthropic.com (ZDR)
```

**Strategy math vs content (FINAL).** Transforms are TypeScript modules compiled into the
server image, addressed `id@semver`. Content (prose, citations, inputs schema, suggest
rules, monitoring config) lives in Postgres and is hot-updatable. Suggest rules are a
typed JSON predicate AST evaluated server-side — no eval, no runtime codegen. Content
updates ship without releases; math changes always pass CI + golden tests.

## 2. Data model (Drizzle, principal tables)

- `table_sets` — taxYear, version, status(draft/published), jsonb payload (brackets, std
  deduction, FICA/SS wage base, addl-Medicare thresholds, QBI thresholds/ranges,
  SALT/OBBBA params, CTC, NIIT, retirement limits: 402(g), 415(c), 415(b), SIMPLE, HSA,
  SEP comp cap), sourceNotes, publishedBy/At.
- `strategies` — id (slug), currentVersionId.
- `strategy_versions` — strategyId, semver, status(draft/in-review/published/deprecated),
  content jsonb (advisor/client/engagement per schema), inputsSchema jsonb, suggestRule
  jsonb, applyModuleRef (`id@semver`|null), effectiveFrom/To, reviewedBy, changeNote,
  createdBy(human|pipeline).
- `golden_tests` — strategyVersionId, name, profile jsonb, params jsonb, expected jsonb,
  tolerance, pinnedTableSetId.
- `clients` — provenance(tb-synced|local), tbClientId?, name, entityType, contacts jsonb,
  mergedIntoId?. Local records mergeable into T&B records without breaking links.
- `plans` — clientId **NOT NULL**, status(draft/in-review/presented/engaged/delivered/
  archived), baselineProfile jsonb, growthPct, years, tableSetId, engineVersion, feePlan
  jsonb, assignedTo, reviewerId.
- `plan_scenarios` — planId, label, selections [{strategyId, version, params}].
- `plan_results` — computed per scenario per year; **immutable once plan ≥ presented**.
- `plan_research_links` — planId, strategyId?, researchArchiveId (the TP-8 review gate).
- `deliverables` — planId, kind(advisor-pdf/client-pdf/pitch-deck/slideshow/handout),
  renderedAt, sha256, storageRef, deliveredVia(portal/signed-link/staff-manual),
  revealStrategies bool.
- `research_archives` — clientId (nullable) + firmArchive bool, sourceSessionId, title,
  topicTags[], snapshot jsonb (full transcript, tool/citation records, memo refs),
  sha256, archivedBy/At, status(active/superseded), tombstone jsonb?.
- `review_queue` — kind(table-draft/watch-hit/strategy-refresh/golden-failure), payload
  jsonb (diff + rationale), status(open/approved/rejected), createdBy(job), decidedBy.
- `audit_log` — append-only (no UPDATE grant); every staff- and pipeline-initiated action.

## 3. Phases

### TP-0. Repo intake (prerequisite)

Place in-repo before any build session:

- `docs/strategy-schema.md` — authoring schema v1.0 (record shape, applyOrder bands
  10–89, authoring rules, validation gates). Source: vibe-taxplan-strategy-schema.md.
- `docs/strategy-backlog.md` — 100-strategy inventory by category (56 modeled /
  44 advisory). Source: vibe-taxplan-strategy-backlog.md.
- `docs/exemplars/augusta-rule.md` — authored exemplar demonstrating target depth.
- `/reference/strategy-library/` — unpack strategy-library-reference-md.zip (100 files +
  `_index.md`). Add to .gitignore and .dockerignore. Verify count = 101 files.
- CLAUDE.md, STATE.md, QUESTIONS.md initialized; `planning` feature flag scaffolded.

### TP-1. Module shell

Top-level switcher Research | Planning | Clients. Router namespaces `/research`,
`/planning`, `/clients`; existing chat routes move under `/research` with redirects.
Per-module lazy loading (research bundle unaffected by planning weight). Keyboard `g r` /
`g p` / `g c`.

### TP-2. Shared client context

App-level "active client" chip: set from any module; Research chats started with it are
soft-linked (promoted on archive); Planning defaults new plans to it; clearable; never
required for research. Persistence: per-user-session (FINAL).

### TP-3. Clients module

Two provenance modes: T&B-synced (nightly + on-demand, read-mostly) and local-only
(mergeable later). Client detail tabs: Overview · Plans · Research (archives) ·
Documents (deliverables w/ sha256 + delivery status) · Activity (audit slice).
Cross-client search (no PII in the index).

### TP-4. Tax engine + tables

`packages/engine`: pure functions, zero I/O, all constants injected from a TableSet.
Coverage: SE tax w/ SS wage-base coordination against W-2 wages, owner payroll tax,
additional Medicare, §469 suspension multi-year state, AGI, flat-state + PTET credit,
OBBBA SALT phase-down, itemized/standard, §199A (threshold, wage-limit phase-in, SSTB
phase-out, net-cap-gain cap), bracket + preferential-rate stacking, CTC phase-out, NIIT,
payments/balance due. Deferred (backlog): AMT, refundable ACTC, UBIA prong, §461(l),
state engines beyond flat-rate (MO first when built).
Seed TABLES_2026 (Rev. Proc. 2025-32 / OBBBA figures) via migration; admin read UI.
Tests: ≥40 unit cases incl. hand-computed checkpoints; cross-check outputs against the
reference implementation's engine for identical profiles (verification use per rule 4).

### TP-5. Scenario + strategy runtime

Scenario composition by applyOrder bands, growth projection (year-1 payments zeroed in
projection years), multi-year carryforward state, notes aggregation. Property tests:
composition order-stable; empty scenario == baseline. Strategy registry loads
strategy_versions (content from DB, apply modules by ref). Declarative suggest evaluator
(field/op/value + all/any/not). Golden-test runner as a vitest project reading
golden_tests fixtures pinned to table sets.

### TP-6. First 10 strategies end-to-end (walking skeleton)

s-corp-election, reasonable-comp, solo-401k, sep-ira, hsa-contributions, augusta-rule,
accountable-plan, ptet, hire-children, se-health-insurance. Each: schema-valid ORIGINAL
content, apply module, suggest rule, ≥2 golden tests. Proves schema + pipeline before
scaling. Any schema friction found here updates docs/strategy-schema.md (minor version)
before batch authoring begins.

### TP-7. Intake

Manual profile UI. PDF import (local, no AI): pdf text-layer extraction with
coordinates; anchor-regex matching on standard IRS line labels; value = right-most
number within the label row's y-band after dropping the left line-number column and
echoed line numbers; first match in page order wins. Mapping layer: Schedule E lines
26/32/40 disaggregate Schedule 1 line 5 (warn if pieces don't tie); Schedule D line 15
splits LT/ST from 1040 line 7 (ST → other income w/ one-time-gain warning); filing
status inferred from standard-deduction match; withholding/estimates deliberately not
parsed; dependents manual. Everything lands in a tie-out review screen (parsed fields +
return's own AGI/TI/total tax/SE tax) — nothing applies until staff confirm. Scanned
returns → GLM-OCR job on vibellm → same review screen. T&B profile prefill where synced.
Support UltraTax, Lacerte, GoSystem, Axcess, Drake, ProSeries 1040 prints; per-vendor
anchor overrides in config, not code.

### TP-8. Plans, workflow, review gate

Plan lifecycle draft → in-review → presented → engaged → delivered → archived. Partner
review screen renders each selected strategy's reviewChecklist; all boxes required.
**Elevated-risk gate (FINAL):** strategies with riskRating=elevated require ≥1 linked
archived research session (plan_research_links) to pass review — hard gate, checkbox
disabled until linked, "Research this" launcher inline next to the blocked item (opens a
Research chat pre-seeded with the strategy's authority list + client chip; archiving it
satisfies the gate). Results freeze at `presented`. Planning↔Research bridges: linked
sessions listed on review screen with deep links into the exact archived exchange;
authority-server citations insertable as plan-level annotations (never library edits).

### TP-9. Deliverables + delivery

Worker-side render (headless Chromium) from the same React templates: advisor technical
PDF, client PDF, per-strategy handouts, slideshow (web view), anonymized pitch deck
(strategy names hidden until plan `engaged`; fee + first-year net benefit + 10-year
cumulative framing). Firm branding from appliance config. SHA-256 per artifact;
registered in the client's Documents tab. Advisory strategies render as structural
recommendations with qualitative impact — never $0 rows.

**Delivery matrix (FINAL):**

- T&B/Connect-linked clients → Vibe Connect portal zone (plan packet, handouts, action
  items) or HMAC-signed expiring links (≤14d default, revocable, downloads audited).
- Local-only clients → NO electronic client delivery; staff download and deliver
  manually (deliveredVia=staff-manual). Render pipeline identical; delivery affordances
  hidden. Merging a local record into a linked identity retroactively unlocks delivery
  for existing artifacts.
- All client-facing rendering gated on the `planning.deliverables` license entitlement
  (fail-open for internal/advisor renders, fail-closed for client-facing).

### TP-10. Engagement loop

Pitch accept → OpenSign engagement letter (plan-fee merge fields) → Stripe Connect
invoice/payment → plan auto-advances to `engaged` → names unlock in client deliverables.
Webhooks idempotent; every transition audited.

### TP-11. Chat archival to client

Immutable snapshot model per §2 research_archives. Archive UX: "Archive to client…" on
any session (client picker defaulting to active chip; Claude-drafted title + 3–6 tags,
editable; optional note; optional plan/strategy link). Bulk multi-select archive.
Sessions ≥90 days unfiled get a dismissable "file to a client?" nudge.
**PII pass:** archival runs the snapshot through Shield Presidio in detect mode;
SSN/EIN/account hits shown with one-click redaction before the snapshot freezes.
**Retention (FINAL):** on client delete → reassign to firm-level archive with tombstone
(original client, event, actor, date); on merge → archives follow the surviving record;
never cascade-deleted. Rendering: read-only with citation links intact; full-text search
per client; export archive as PDF memo (deliverables renderer) for the workpaper file.

### TP-12. Content authoring at scale (90 remaining strategies)

Validators in `packages/schema` (zod + JSON Schema): schema validity; citation lint
(format table for IRC/Reg/Case/Admin); prose checks (client sections reading level ≤9;
banned phrases: loophole/trick/secret/guarantee); completeness (every mechanic maps to an
authority; stateNotes non-empty — must address conformity, PTET interaction, MO note;
suggest rule present on all 100).

Authoring pipeline `pnpm author:draft <id>` (worker job): prompt = schema + category
conventions + `/reference/strategy-library/<id>.md` + current TableSet figures → Anthropic API
(claude-sonnet-4-6) via Shield, web-search enabled for authority verification only →
complete draft strategy_versions row (status draft, createdBy pipeline). Instructions
require original prose; reference is a coverage checklist, not a source of wording.
Validators auto-run; one retry loop with error feedback; then review_queue.

Batch waves of 10 by category. Review UI: draft vs coverage checklist vs validator
output, side-by-side. Partner approval publishes. Modeled strategies additionally need
an apply module + ≥2 golden tests (drafted in-repo via normal PR review; module ref
linked at publish). Done: 100/100 published, 100/100 with suggest rules.

### TP-13. Shield client + budgets

Single `packages/shared/anthropic.ts`: routes via Shield, ZDR headers, model pinning,
per-job token budgets, retry/backoff, request/response hashes to audit_log (payloads not
persisted post-Shield), kill-switch env var, vibellm fallback for summarization-class
jobs. Used by research chat AND all maintenance jobs.

### TP-14. Currency jobs (the maintenance moat)

- **tables:draft <year>** (scheduled October + manual): Claude + web search drafts
  TABLES\_<year> as a field-by-field JSON diff vs current — every value with source URL +
  authority reference. Lands in review_queue diff UI; partner approves → published as
  next-year set; plans opt in per-plan.
- **Golden regression on table publish:** all golden tests for strategies effective in
  that year re-run against the new set; failures open review items with deltas.
- **strategy:refresh <id>:** Claude drafts a minimal content patch (dollar amounts, new
  authorities, risk language, effective years) with per-hunk rationale; validators;
  review_queue; approval publishes MINOR/PATCH. Math changes flagged
  needs-module-change → repo issue; code never bypasses CI.
- **strategy:watch** (weekly): Claude + web search sweeps each published strategy's
  monitoring.watchAuthorities + keywords, batched by category (~10 API calls/week): new
  T.C. memos, Rev. Procs/Ruls, notices, legislation. Redis seen-store dedup. Hits open
  review items (source link, 2–3 sentence impact, affected strategies, pre-drafted
  refresh). Weekly partner digest; heartbeat on empty sweeps. Nothing publishes without
  partner action.
- **Local archive scan** (no API cost): flags strategies discussed in the firm's own
  research archives after the strategy's lastReviewed date — "your research may be ahead
  of the published write-up" review items. Pure metadata/keyword match, computed locally.
- **Runtime advisory (feature-flagged):** Claude-drafted plan cover memos and
  suggestion narratives (why a rule-hit fits this client) — text only, Shield-redacted
  input, always labeled draft, always editable; vibellm variant for cloud-disabled firms.

### TP-15. Security hardening + checklist

- [ ] Staff routes Tailscale-only; public surface = portal + signed links only.
- [ ] Shield sole egress to api.anthropic.com (compose network policy verified).
- [ ] ZDR org verified; DPA on file; no post-Shield payload persistence.
- [ ] Signed links: HMAC, ≤14d, revocable, download-audited.
- [ ] plan_results immutable ≥ presented (trigger-enforced); audit_log append-only.
- [ ] License entitlement fail-open internal / fail-closed client-facing verified.
- [ ] Archive PII detect-pass exercised with seeded SSN/EIN fixtures.
- [ ] Nightly pg_dump + artifact volume into Vibe Vault (restic → B2); restore drill
      documented and performed once.

### TP-16. Rollout + definition of done

Sequence: TP-0…TP-3 + TP-11 first (shell, clients, archival — immediate value for the
research app alone, flag can go live early) → TP-4…TP-8 planning core → TP-9/TP-10
deliverables + engagement → TP-12 authoring waves in parallel from TP-6 completion →
TP-13…TP-15. DB migrations additive-only throughout.

**Done, v1.0:** 100 strategies published · real T&B client with an archived research
session hard-linked to a presented plan · client PDF delivered via Connect behind the
license entitlement · pitch → OpenSign → Stripe loop live · an elevated-risk strategy
blocked then passed via the research gate · TABLES_2027 draftable through tables:draft
in dry-run · restore drill complete.

## 4. Finalized decisions (2026-07-17)

1. Active-client chip: per-user-session persistence.
2. Local-only clients: staff PDF only — no electronic client delivery until merged into
   a T&B/Connect-linked identity (retroactive unlock on merge).
3. Archives on client delete/merge: reassign to firm-level archive with tombstone; follow
   surviving record on merge; never cascade-delete.
4. Elevated-risk strategies: linked research session REQUIRED to pass review (hard gate,
   not configurable in v1).

## 5. Deferred backlog (post-v1)

AMT · refundable ACTC · UBIA prong · §461(l) · MO state engine (then multi-state) ·
depreciation-recapture-on-sale modeling · multi-1040 batch opportunity scan across the
client base (v1.1 headline) · per-strategy fee analytics · Spanish deliverables ·
firm-configurable elevated-risk gate.
