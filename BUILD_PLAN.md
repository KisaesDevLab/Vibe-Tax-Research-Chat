# Vibe Tax Research Chat — Build Plan

**Project:** `vibe-tax-research`
**Org:** `KisaesDevLab`
**Author:** Kurt Kohrumel, CPA — Kisaes LLC
**Version:** v1.0 (merged) — supersedes v0.1, v0.2, v0.3
**Last updated:** April 27, 2026
**License:** PolyForm Internal Use 1.0.0 (source-available; internal business use, no distribution)
**Status:** ready for autonomous build — see `KICKOFF_PROMPT.md`

---

## How to use this document

This is the **single source of truth** for the Vibe Tax Research Chat build. It is written for autonomous execution by Claude Code. Each phase has an explicit scope, a checklist, acceptance criteria, and a dependency list. A separate `KICKOFF_PROMPT.md` boots the autonomous run.

**Execution rules:**

- Phases run **sequentially**. Within a phase, items can run in parallel.
- Each phase ends with: green tests, commit, milestone tag if applicable.
- Ambiguities go to `QUESTIONS.md` with a default chosen and applied — never stop.
- All architecture decisions in §3 are non-negotiable defaults.

---

## 1 · Product summary

A self-hosted, single-tenant AI chat appliance that turns the [`KisaesDevLab/Vibe-Claude-Tax-Research-Skills`](https://github.com/KisaesDevLab/Vibe-Claude-Tax-Research-Skills) pack (33+ CPA skills) into a usable web app for a CPA firm. The admin owns one Anthropic API key, picks a default model, and manages users. Every chat shows running and final cost based on actual `usage` token counts from the Messages API. Claude consults primary sources at runtime via the Anthropic web tools (v1) and a custom MCP authority server (v1.5), so citations are verified rather than asserted.

**Why this exists:** Firm-wide deployment behind one API key, centralized cost visibility per chat / user / model, citations and SSTS / Circular 230 disclosures rendered as first-class UI, PII boundary kept inside the firm's hardware, and a per-fetch audit trail no SaaS competitor can match.

## 2 · Core requirements

1. Admin enters an Anthropic API key (encrypted at rest)
2. Admin selects an active model (Opus 4.7, Opus 4.6, Sonnet 4.6, Haiku 4.5, plus future)
3. Admin can retrieve / view / edit per-token cost
4. Each chat shows estimated cost based on actual token usage × model rate
5. Admin can create, edit, disable, and delete users
6. The chat uses the Vibe-Claude-Tax-Research-Skills pack to do tax research
7. The skills pack updates from upstream are admin-controlled, versioned, and reversible
8. The firm can add custom skills, reference documents, and per-chat attachments
9. Claude consults primary sources at runtime (USLM, eCFR, Federal Register, DAWSON, IRS Bulletin, GovInfo, top-10 state DORs)

## 3 · Architecture decisions (locked)

### 3.1 Stack

| Layer           | Choice                                                                               |
| --------------- | ------------------------------------------------------------------------------------ |
| Frontend        | React 18 + TypeScript + Vite + Tailwind + TanStack Query + Zustand                   |
| Backend         | Node.js 20 + Express + TypeScript                                                    |
| ORM / DB        | Drizzle ORM + PostgreSQL 16                                                          |
| Cache / queue   | Redis 7 + BullMQ                                                                     |
| Auth            | JWT (access + refresh) + bcrypt (cost 12)                                            |
| AI client       | `@anthropic-ai/sdk` with `betas: ["code-execution-2025-08-25", "skills-2025-10-02"]` |
| Streaming       | Server-Sent Events from Express → React                                              |
| Editor          | Monaco (skill authoring + diff viewing)                                              |
| Distribution    | Docker Compose appliance, BSL 1.1                                                    |
| Package manager | pnpm with workspaces                                                                 |

### 3.2 Skills delivery — `cpa-pack-index` dispatcher with heuristic prefilter

The pack ships 33+ skills; the API caps `container.skills[]` at 8 per request. The router:

1. Always attaches `cpa-pack-index` (the pack's own dispatcher).
2. Always attaches `compliance-ssts-circular230`.
3. Selects up to 6 more from a routing table based on user-message tokens (state codes, IRC §, form numbers, predict / qualify / classify keywords, notice / CP / LT prefixes, etc.).
4. Falls back to a Haiku 4.5 classifier only when the heuristic confidence is low (off by default).

### 3.3 Skills hosting — uploaded as custom skills

All 33+ skills are uploaded to the customer's Anthropic workspace via `POST /v1/skills` (beta `skills-2025-10-02`). A versioned sync engine (Phase 8) tracks upstream changes; admin reviews and applies updates explicitly.

### 3.4 Model registry — pricing is data

The `models` table holds rate cards per model. Admin can edit any rate field. A bundled JSON manifest seeds the table; "Refresh from upstream" pulls a Kisaes-hosted manifest (`https://vibemb.com/manifests/anthropic-models.json`).

### 3.5 API key storage

- AES-256-GCM at rest with HKDF-derived key from `MASTER_KEY` env var
- Decrypted in-process only at the moment of a Claude API call
- Never logged, never returned (only a fingerprint like `sk-ant-...XYZ4`)
- Validated on save with a 1-token Haiku call

### 3.6 Cost calculation — actual, from the `usage` block

Every Anthropic streaming response ends with a `message_delta` event containing `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`. Multiply against the model's rate card and persist:

```
cost_usd =
  (input_tokens                 × input_per_mtok      / 1_000_000) +
  (output_tokens                × output_per_mtok     / 1_000_000) +
  (cache_creation_input_tokens  × cache_write_per_mtok / 1_000_000) +
  (cache_read_input_tokens      × cache_read_per_mtok  / 1_000_000) +
  web_fetch_calls × web_fetch_unit_cost +
  web_search_calls × web_search_unit_cost
```

Provisional cost shown during streaming converges to actual on the final `message_delta`.

### 3.7 Web-resource consultation — hybrid, phased

- **v1:** Anthropic's `web_fetch` + `web_search` server tools, locked to a domain allowlist (USLM, eCFR, federalregister.gov, dawson.ustaxcourt.gov, irs.gov, govinfo.gov, uscode.house.gov, top-10 state DORs). Fetch budget per turn (default 8 fetches, 4 searches). Fetch audit shim observes `tool_use` blocks and persists them.
- **v1.5:** Custom appliance-hosted MCP authority server with Postgres caching. Per-source migration from Anthropic web tools to local MCP behind a feature flag. End state: 80%+ cache hit rate, sub-100ms cached lookups, full appliance-side bytes.

### 3.8 Three-tier resource architecture

A single research turn can use all three resource tiers:

| Tier                         | What                                             | Lifetime   | Mechanism                        |
| ---------------------------- | ------------------------------------------------ | ---------- | -------------------------------- |
| **Skills**                   | Pack skills + firm-authored custom skills        | Permanent  | `container.skills[]`             |
| **Reference library** (v1.5) | Long-form firm documents, treatises, prior memos | Permanent  | RAG retrieval into system prompt |
| **Chat attachments**         | Per-engagement documents                         | Per-thread | Inline in `messages[]`           |

### 3.9 PII / SOC posture

- Per-chat `pii_disclosure_acknowledged` set on first message
- Per-firm setting `pii_strip_enabled` (regex SSN/EIN pre-filter, default off)
- Chat history retained on local Postgres only — never duplicated to logs or third-party tools
- All admin actions written to `audit_log`
- `web_fetch` bytes pass through Anthropic in v1; appliance-side in v1.5

## 4 · Data model

```text
-- IDENTITY -------------------------------------------------------------------
users
  id (uuid pk)  email (unique)  password_hash  role (admin|user|viewer)
  display_name  is_active (bool)  monthly_spend_cap_usd (numeric, nullable)
  created_at  updated_at  last_login_at  deleted_at (soft delete)

auth_refresh_tokens
  id  user_id  token_hash  expires_at  rotated_at  revoked_at  user_agent  ip

audit_log
  id  actor_user_id  action  target_type  target_id
  metadata (jsonb)  occurred_at  ip

-- CONFIGURATION --------------------------------------------------------------
settings
  key (pk)  value (jsonb)  is_encrypted (bool)  updated_by  updated_at
  -- "anthropic_api_key" → { ciphertext, iv, tag, fingerprint }
  -- "default_model_id"  → "claude-sonnet-4-6"
  -- "skills_repo_ref"   → { repo, pin_type, pin_value, last_synced_sha, last_synced_at }
  -- "web_resource_strategy" → { usc, cfr, irb, fr, dawson, govinfo, state_dor }
  -- "compliance_banner_enabled" → true
  -- "pii_strip_enabled" → false

models
  model_id (pk)  display_name  input_per_mtok  output_per_mtok
  cache_write_per_mtok  cache_read_per_mtok  tokenizer_factor (numeric default 1.0)
  web_fetch_unit_cost (numeric default 0.01)  web_search_unit_cost (numeric default 0.01)
  is_active (bool)  retired_at  notes  created_at  updated_at  updated_by

-- SKILLS --------------------------------------------------------------------
skills
  skill_id (pk, anthropic-issued)  source ("custom"|"anthropic"|"pack")
  local_slug  display_name  description  category
  current_version  github_path  github_sha
  status_field (stub|draft|reviewed|verified)  is_active  is_always_attached (bool)
  routing_keywords (text[])  uploaded_at  retired_at

skill_versions
  id (pk)  skill_id (fk)  upstream_sha  anthropic_skill_version
  status (current|superseded|withdrawn)  status_field
  changelog_excerpt  uploaded_at  uploaded_by

skills_sync_runs
  id (pk)  triggered_by ("admin:<id>"|"cron"|"webhook")
  pin_type  pin_value  resolved_sha
  started_at  finished_at  result (success|partial|failed|preview)
  changes_summary (jsonb) -- { added: [...], updated: [...], removed: [...], unchanged_count }
  applied_at  applied_by  error_message

custom_skills
  id (pk)  name (slug, unique)  display_name  description  category
  body_md  references (jsonb)  routing_keywords (text[])
  anthropic_skill_id  anthropic_skill_version
  is_always_attached (bool)  is_active  visibility ("firm"|"role:user"|"role:admin")
  created_by  created_at  updated_at

-- CHATS --------------------------------------------------------------------
chats
  id (pk)  user_id (fk)  title  default_model_id (override, nullable)
  pinned_pack_version (nullable)  -- engagement freeze
  pii_disclosure_acknowledged (bool)
  archived_at  created_at  updated_at

messages
  id (pk)  chat_id (fk)  role ("user"|"assistant"|"system_note")
  content (text)  created_at
  -- assistant rows only:
  model_id  stop_reason  attached_skill_ids (text[])  attached_skill_versions (text[])
  input_tokens  output_tokens
  cache_creation_input_tokens  cache_read_input_tokens
  web_fetch_calls (int default 0)  web_search_calls (int default 0)
  cost_usd (numeric(10,6))
  authorities (jsonb)            -- the pack's citation sidecar
  compliance_check (jsonb)       -- SSTS/Circular 230 checklist output

primary_source_consultations
  id (pk)  message_id (fk)  tool_name ("web_fetch"|"web_search"|"mcp:<n>")
  url  query  domain
  fetched_at  response_status  response_excerpt (text, first 2KB)
  cited_in_authorities (bool)

chat_attachments
  id (pk)  chat_id (fk)  uploaded_by
  filename  mime_type  size_bytes
  storage_path  full_text  ocr_applied (bool)
  summary  created_at

-- ANALYTICS ----------------------------------------------------------------
usage_events
  id (pk)  user_id  chat_id  message_id  model_id
  input_tokens  output_tokens
  cache_creation_input_tokens  cache_read_input_tokens
  web_fetch_calls  web_search_calls  cost_usd  occurred_at

usage_daily   -- materialized rollup
  day  user_id  model_id  message_count  total_tokens  total_cost_usd

-- v1.5 -------------------------------------------------------------------
reference_documents
  id (pk)  title  source ("upload"|"url")  original_filename  mime_type  size_bytes
  storage_path  full_text  metadata (jsonb)  visibility  created_by  created_at

reference_chunks
  id (pk)  document_id (fk)  chunk_index
  text  embedding (vector(1024))  char_start  char_end

authority_cache
  id (pk)  source ("usc"|"cfr"|"irb"|"fr"|"dawson"|"govinfo"|"state_dor")
  cache_key  canonical_url  raw_text  parsed_text  metadata (jsonb)
  fetched_at  ttl_until  upstream_status  upstream_etag  upstream_last_modified
```

All tables get `created_at` / `updated_at` defaults. Foreign keys cascade on delete except `users` which soft-deletes to preserve audit history.

## 5 · Phase plan

The plan has **37 phases**: 29 in v1 (8-week build) and 8 in v1.5 (post-launch +4 weeks). Each phase ends green-tested and committed.

### M1 — Skeleton (week 1)

#### Phase 1 — Project foundation (blocking)

**Depends on:** none.
**Scope:** monorepo skeleton, Docker Compose, healthchecks, lint/format, base CI hooks.

- [ ] Init pnpm monorepo with workspaces: `apps/web`, `apps/api`, `packages/db`, `packages/shared`
- [ ] TypeScript strict mode in every package; `tsconfig.base.json` shared
- [ ] ESLint + Prettier + Husky pre-commit hooks
- [ ] Vite + React 18 + Tailwind in `apps/web`
- [ ] Express + helmet + cors + Pino logger in `apps/api`
- [ ] `docker-compose.yml` with `postgres:16`, `redis:7`, `api`, `web`
- [ ] `.env.example` with `DATABASE_URL`, `REDIS_URL`, `MASTER_KEY`, `JWT_SECRET`, `JWT_REFRESH_SECRET`, `PORT`, `LOG_LEVEL`
- [ ] Health endpoints: `/api/health`, `/api/health/deep` (db + redis ping)
- [ ] CLAUDE.md, QUESTIONS.md, README.md scaffolding
- [ ] Vitest configured in api and web
- [ ] Conventional commits enforced via commitlint
      **Done when:** `docker compose up` produces a green `/api/health/deep`. Lint and tests pass.

#### Phase 2 — Database & migrations (blocking)

**Depends on:** 1.
**Scope:** full Drizzle schema for v1 tables, initial migration, seed scripts.

- [ ] Drizzle Kit configured against Postgres 16
- [ ] Schema files for every v1 table from §4
- [ ] Initial migration committed
- [ ] Seed scripts: 1 admin user (env-driven email/password), full model registry seed JSON (Opus 4.7, Opus 4.6, Sonnet 4.6, Haiku 4.5 with April 2026 rates from §6)
- [ ] Migration runner integrated into `pnpm db:migrate`
- [ ] Indexes on hot paths: `messages.chat_id`, `usage_events.occurred_at`, `audit_log.actor_user_id+occurred_at`
      **Done when:** `pnpm db:migrate && pnpm db:seed` produces a working DB; integration test inserts and selects from each table.

#### Phase 3 — Auth & RBAC (blocking)

**Depends on:** 2.
**Scope:** JWT auth, refresh-token rotation, role middleware, brute-force protection.

- [ ] `POST /api/auth/login` — accepts email + password, returns access + refresh
- [ ] `POST /api/auth/refresh` — rotates refresh token, hashes stored value
- [ ] `POST /api/auth/logout` — revokes refresh
- [ ] Brute-force rate limit on `/login` via Redis sliding window (5 attempts / 15 min / IP)
- [ ] `requireAuth` and `requireRole(role)` Express middleware
- [ ] `<AuthProvider>` and `<RequireRole>` React components, login page
- [ ] All auth events written to `audit_log`
- [ ] Tests: login success, login failure, refresh rotation, role gate
      **Done when:** an admin can log in via the web UI; a non-admin gets 403 on `/api/admin/*`.
      **Tag:** `v0.M1`

### M2 — Admin can configure (week 2)

#### Phase 4 — Admin: user management

**Depends on:** 3.

- [ ] `GET /api/admin/users` (list, filter, search by email/name)
- [ ] `POST /api/admin/users` (create with one-time password set link)
- [ ] `PATCH /api/admin/users/:id` (role, display_name, is_active, monthly_spend_cap_usd)
- [ ] `POST /api/admin/users/:id/reset-password` (one-time link)
- [ ] `DELETE /api/admin/users/:id` (soft delete; audit row written)
- [ ] React Admin → Users page: table, drawer editor, invite modal
- [ ] Spend-cap enforcement hook reads `monthly_spend_cap_usd` and blocks new turns when exceeded (returns 402 with structured body)
      **Done when:** admin can create, edit, disable, and delete users; spend cap correctly blocks a 402 from chat.

#### Phase 5 — Settings & encrypted secrets

**Depends on:** 3.

- [ ] `lib/crypto.ts` — AES-256-GCM with HKDF-derived per-key from `MASTER_KEY`; tests cover encrypt/decrypt round-trip and tampering detection
- [ ] `settings` getter/setter with per-key encrypt-on-write for `is_encrypted=true` rows
- [ ] `POST /api/admin/settings/anthropic-key` — accepts key, validates with 1-token Haiku 4.5 call, stores ciphertext, returns fingerprint
- [ ] `DELETE /api/admin/settings/anthropic-key` — rotation
- [ ] `GET /api/admin/settings/anthropic-key` — returns only the fingerprint, never the key
- [ ] React Admin → Settings → "Anthropic API Key" with masked display, "Test connection" button, "Rotate" flow
- [ ] Audit log on every key write/delete
      **Done when:** admin can save a key, see only the fingerprint, rotate it, and delete it; ciphertext is unintelligible at rest.

#### Phase 6 — Model registry & pricing

**Depends on:** 2.

- [ ] `GET /api/admin/models` — full list with rates
- [ ] `PATCH /api/admin/models/:id` — admin can edit any rate field
- [ ] `POST /api/admin/models/refresh` — fetches `https://vibemb.com/manifests/anthropic-models.json`, computes a diff, returns it for confirmation
- [ ] `POST /api/admin/models/refresh/apply` — applies a previously-fetched diff
- [ ] `POST /api/admin/settings/default-model` — picks active default (must be `is_active=true`)
- [ ] React Admin → Models page: editable table, "Refresh from upstream" with diff preview, "Set as default" toggle, "Test prompt" button per model
- [ ] All edits write to `audit_log`
      **Done when:** admin can edit a rate, the new rate flows into the next chat's cost calc; "Refresh from upstream" produces a visible diff before applying.
      **Tag:** `v0.M2`

### M3 — Skills usable (weeks 3–4)

#### Phase 7 — Skills repo ingestion (basic)

**Depends on:** 5.

- [ ] BullMQ queue `skills:ingest` with worker
- [ ] Clone / pull `KisaesDevLab/Vibe-Claude-Tax-Research-Skills` at the configured ref into a workspace dir
- [ ] Walk `skills/*/SKILL.md`, parse YAML frontmatter (`name`, `description`, optional `status`)
- [ ] Capture supporting files (`references/`, `scripts/`, `shared/`) per skill
- [ ] Compute SHA-256 per skill (concatenated content of SKILL.md + all referenced files)
- [ ] Persist to `skills` table with `current_version` placeholder
- [ ] Tests: parse a fixture skill, detect frontmatter changes
      **Done when:** a manual `pnpm tsx scripts/skills-ingest.ts` populates `skills` rows for all 33+ pack skills.

#### Phase 8 — Versioned sync engine

**Depends on:** 7.

- [ ] Pin model: tag (default), branch, commit SHA — stored in `settings.skills_repo_ref`
- [ ] `POST /api/admin/skills/sync` — triggers a **dry-run** sync, returns the diff
- [ ] `POST /api/admin/skills/sync/apply` — applies a previously-computed diff (uploads to Anthropic, records `skill_versions`)
- [ ] `POST /api/admin/skills/sync/rollback` — restores prior `skill_versions` row to `current`
- [ ] Nightly cron at 03:00 local: dry-run only, banner appears on dashboard if changes pending
- [ ] Webhook receiver at `/api/webhooks/github` (HMAC-verified) for push-triggered detection
- [ ] `skills_sync_runs` row written for every run (preview or applied)
      **Done when:** an admin can pin to `v1.0.0-beta`, see "no changes," change the pin to `main`, see a diff, apply it, and roll back — all with audit trail.

#### Phase 9 — Skills upload to Anthropic

**Depends on:** 5, 8.

- [ ] Wrapper around `POST /v1/skills` with beta header `skills-2025-10-02`
- [ ] For each changed skill: zip the directory, upload, capture returned `skill_id`, persist to `skills` and `skill_versions`
- [ ] On skill removal upstream: `is_active=false` locally; keep `skill_id` for historical lookup
- [ ] Retry logic: exponential backoff for 5xx; abort on 4xx with structured error
      **Done when:** apply step in Phase 8 actually pushes new versions to the customer's Anthropic workspace; old chat references resolve to historical versions.

#### Phase 10 — Skills update admin UI

**Depends on:** 8, 9.

- [ ] Admin → Skills page: source-repo panel with pin display, "Change pin" button, last-synced timestamp
- [ ] "Updates available" badge on dashboard when a pending dry-run has changes
- [ ] Diff viewer per skill (Monaco, side-by-side)
- [ ] Bulk apply / per-skill apply
- [ ] Rollback button (single click, audit-logged)
- [ ] Activity log: every sync run with who triggered it, what changed
      **Done when:** admin can manage the entire sync lifecycle from the UI without using the CLI.

#### Phase 11 — Skills selection / routing

**Depends on:** 7.

- [ ] Routing table in `packages/shared/skills-routing.ts` (state-code regex, predict keywords, form numbers, IRC/Treas. Reg. patterns, due-date triggers, penalty/interest words)
- [ ] `cpa-pack-index` and `compliance-ssts-circular230` always attached
- [ ] Hard cap of 8 attached skills
- [ ] Optional Haiku 4.5 fallback classifier behind a setting (default off)
- [ ] Routing also matches against `custom_skills.routing_keywords` when present (Phase 21)
- [ ] Tests: unit tests for the routing table against the pack's `examples/` directory (must produce expected skill set per example)
      **Done when:** routing function returns the correct skill set for every example in the pack's `examples/` directory.
      **Tag:** `v0.M3`

### M4 — Core chat (week 5)

#### Phase 12 — Claude API client abstraction (blocking for chat)

**Depends on:** 5, 6, 9, 11.

- [ ] `lib/claude/client.ts` — singleton `Anthropic` client constructed per-request with the decrypted key
- [ ] `lib/claude/chat.ts` — `streamChat({ chatId, userMessage, model, attachedSkillIds, attachments })`
- [ ] Always sets `betas: ["code-execution-2025-08-25", "skills-2025-10-02"]`
- [ ] Always includes the code execution tool: `tools: [{ type: "code_execution_20250825", name: "code_execution" }]`
- [ ] System prompt includes: firm name, current date, "you are using the Vibe CPA Skills pack", PII handling reminder, citation discipline reminder
- [ ] Prompt caching breakpoint after the system prompt (≥1024-token threshold)
- [ ] Returns an async iterable of typed events (text deltas, tool use, tool results, usage updates, final stop reason)
- [ ] Centralized error handling: 429 → exponential backoff; 401 → flag key invalid + notify admin; 529 → user-facing message
      **Done when:** a manual test call against a real key produces a streamed response with usage block.

#### Phase 13 — Chat sessions (CRUD)

**Depends on:** 3.

- [ ] `POST /api/chats` — creates new chat, returns id
- [ ] `GET /api/chats` (paginated; admins can filter by user)
- [ ] `GET /api/chats/:id` — chat + messages
- [ ] `PATCH /api/chats/:id` — rename, archive, pin pack version
- [ ] `DELETE /api/chats/:id` — hard delete + cascade messages
- [ ] `POST /api/chats/:id/title` — auto-titles after first turn via cheap Haiku call
- [ ] React: Chat sidebar with grouped (Today / Yesterday / Earlier) chat list, search, archive toggle
      **Done when:** sidebar from the mockup is functional with real data.

#### Phase 14 — Streaming chat (SSE)

**Depends on:** 12, 13.

- [ ] `POST /api/chats/:id/messages` — streams via SSE
- [ ] Server flow: persist user message → resolve attached skills (Phase 11) → call `streamChat` → forward deltas as SSE events → on completion, persist assistant message with usage and cost
- [ ] React `useChatStream` hook with reconnect, abort, partial-message rendering
- [ ] Markdown rendering with `react-markdown` + `remark-gfm`
- [ ] Code blocks, tables, "Copy", "Regenerate", "Edit & resend" actions per message
      **Done when:** a user can send a message and see streamed assistant output that matches the mockup layout.

#### Phase 15 — Token tracking & cost engine

**Depends on:** 6, 12.

- [ ] `lib/cost/calc.ts` — pure function `(usage, model, web_calls) → cost_usd`
- [ ] Persist all four token fields plus `web_fetch_calls`, `web_search_calls`, and `cost_usd` on every assistant message
- [ ] `chats.estimated_cost_usd` computed via SQL view summing messages
- [ ] Real-time provisional cost during streaming (char-count / 4 estimate, snaps to actual on `message_delta`)
- [ ] React: per-chat header running total; per-message inline cost; ledger panel matches mockup
- [ ] Currency formatting: 4 decimals under $1, 2 decimals above
- [ ] Tests: cost calc against fixture usage blocks
      **Done when:** the cost ledger panel from the mockup renders accurate numbers from real API responses.

#### Phase 16 — Web tools enablement

**Depends on:** 12.

- [ ] Add `web_fetch` and `web_search` to `tools` in `streamChat()` alongside `code_execution`
- [ ] Pass `web_fetch` an explicit domain allowlist (USLM, eCFR, federalregister.gov, dawson.ustaxcourt.gov, irs.gov, govinfo.gov, uscode.house.gov, top-10 state DORs — full list in `packages/shared/web-allowlist.ts`)
- [ ] Default per-turn budget: 8 fetches, 4 searches; configurable per model in `models` table
- [ ] System prompt addition: "When a skill instructs you to verify a citation, use `web_fetch` against the canonical source named by the skill rather than relying on memory. Cite only authorities you have fetched in this turn. If a fetch fails, emit `[CITATION NEEDED]` rather than paraphrase from memory."
- [ ] Per-model setting: web tools on for Sonnet 4.6 / Opus 4.x; off for Haiku 4.5 (used only for routing/dispatch)
      **Done when:** a chat asking about IRC § 199A produces tool-use blocks fetching from `uscode.house.gov`.

#### Phase 17 — Fetch audit shim

**Depends on:** 14, 16.

- [ ] Stream-level interceptor in Phase 14's SSE handler: parse every `tool_use` and `tool_result` block, persist to `primary_source_consultations`
- [ ] Capture: tool name, URL or query, domain, fetched_at, response_status, first 2KB of response
- [ ] Audit log entry per fetch (queryable by user × date range)
- [ ] Tests: fixture stream produces correct `primary_source_consultations` rows
      **Done when:** every web fetch in a turn shows up in the consultations table with full metadata.
      **Tag:** `v0.M4`

### M5 — Output polish (weeks 6–7)

#### Phase 18 — Citation & authority rendering with verification chips

**Depends on:** 14, 17.

- [ ] Detect and parse the pack's JSON sidecar with `authorities[]` from assistant output
- [ ] Render an "Authorities" panel under each assistant message matching the mockup (citation, type tag, weight indicator, source, retrieved date, verification chip)
- [ ] Three verification states: `✓ verified this turn`, `⚠ verified within cache TTL` (v1.5), `✗ unverified (training-data recall)`
- [ ] Cross-reference `authorities[]` entries against `primary_source_consultations` rows for this message to compute the verification state
- [ ] Highlight `[CITATION NEEDED — search: ...]` sentinels as warning chips
- [ ] Persist parsed authorities in `messages.authorities` (jsonb)
- [ ] Per-firm setting: "Hide unverified citations" — strict mode that suppresses anything Claude couldn't fetch
      **Done when:** the mockup's Authorities panel renders correctly from real assistant output, with accurate verification chips.

#### Phase 19 — Compliance disclosure rendering

**Depends on:** 14.

- [ ] Detect compliance checklist output from `compliance-ssts-circular230` skill
- [ ] Render the panel matching the mockup: SSTS § 1.1, § 2.3, Circ 230 § 10.22 / § 10.35 / § 10.37
- [ ] Surface Form 8275 / 8275-R / 8886 disclosure flags as inline alerts
- [ ] Surface post-Loper Bright Skidmore caveat for any cited Treasury Regulation
- [ ] Per-firm toggle: require user to acknowledge before copying or exporting
- [ ] Persist parsed compliance check in `messages.compliance_check`
      **Done when:** the mockup's Compliance Check panel renders correctly.

#### Phase 20 — Skills attribution panel

**Depends on:** 11, 14.

- [ ] Render the "Skills invoked this turn" panel from the mockup
- [ ] `cpa-pack-index` shown as dispatcher (oxblood styling)
- [ ] `compliance-ssts-circular230` shown as compliance (moss styling)
- [ ] Other skills shown with version chip (`v1.0.0-b`)
- [ ] Counter: "5 of 8 slots used"
      **Done when:** matches mockup visually.

#### Phase 21 — Custom skills authoring

**Depends on:** 9.

- [ ] Admin → Custom Skills → list page with status column (draft / published / retired)
- [ ] Author UI: Monaco Markdown editor with live preview, YAML frontmatter form, "Add reference file" multi-file support
- [ ] Validation: name regex `^[a-z][a-z0-9-]{2,63}$`, description ≤1024 chars, no XML tags, reserved-word blocklist (`anthropic`, `claude`, `cpa-pack-index`)
- [ ] **Publish** action: zip the skill, upload via `POST /v1/skills`, persist `anthropic_skill_id`, mark `is_active=true`
- [ ] **Unpublish** flow: `is_active=false` locally; existing chats keep their version reference
- [ ] Test harness: "Try this skill" mini-chat sends a fixed prompt with only this skill + dispatcher attached
- [ ] `is_always_attached` toggle (warns if too many always-on skills)
- [ ] Routing integration: Phase 11 routing also reads `custom_skills.routing_keywords`
      **Done when:** an admin can author, validate, publish, test, and route a custom skill end-to-end.

#### Phase 22 — SKILL.md import

**Depends on:** 21.

- [ ] "Upload SKILL.md" path that accepts a zip or a directory drop
- [ ] Bulk import from a Git repo URL
- [ ] Same validation as Phase 21
      **Done when:** admin can import a folder of `SKILL.md` files in a single operation.

#### Phase 23 — Chat attachments

**Depends on:** 14.

- [ ] Composer paperclip button + drag-and-drop zone
- [ ] `POST /api/chats/:id/attachments` — accepts PDF, DOCX, TXT, MD, HTML, image
- [ ] Server-side: parse with appropriate library (pdf-parse, mammoth, etc.), persist `chat_attachments`
- [ ] Generate Haiku 4.5 summary at ingestion (cheap, async)
- [ ] OCR fallback for scanned PDFs (Tesseract bridge for v1; GLM-OCR upgrade in v1.5)
- [ ] Inline display in chat: attachment card under user message with filename, type, size, expand-to-preview
- [ ] Inclusion in subsequent turns: full text + summary added to system context until chat is archived
- [ ] Token-budget guard: if attachments exceed 80K tokens, only the summary is injected; full text retrievable via a `read_attachment(id)` tool the appliance exposes
- [ ] PII redaction option (regex pre-filter, default off)
      **Done when:** a user can drop a PDF onto the composer, see it parsed, and the assistant references its content correctly.

#### Phase 24 — Usage analytics

**Depends on:** 15.

- [ ] BullMQ worker writes to `usage_events` async after every assistant turn
- [ ] `GET /api/admin/usage` with filters (date range, user, model, chat)
- [ ] Hourly cron rolls up to `usage_daily`
- [ ] React Admin → Usage page: stacked bar by model, top users, top chats by cost, average cost per turn
- [ ] CSV export
      **Done when:** admin sees real spend data per user/model/day.

#### Phase 25 — Background jobs & queues

**Depends on:** 7, 23, 24.

- [ ] BullMQ queues: `skills:sync`, `skills:ingest`, `chat:title`, `usage:rollup`, `attachment:summarize`, `notifications:email`
- [ ] Bull Board mounted at `/admin/queues` (admin-only)
- [ ] Cron jobs:
  - Nightly skills sync at 03:00 local (preview only)
  - Hourly usage rollup
  - Weekly model registry refresh notification
    **Done when:** Bull Board shows healthy queues; nightly sync runs and produces a preview.

#### Phase 26 — Admin dashboard

**Depends on:** 24.

- [ ] Single-page Admin home: today's spend, MTD spend, active users, last skills sync time, default model
- [ ] Quick actions: refresh skills, refresh model rates, invite user, rotate API key
- [ ] System health: DB ping, Redis ping, last successful Anthropic call, current key fingerprint
- [ ] Threshold alert banner at configurable MTD spend %
- [ ] "Updates available" badge for pending skills sync
      **Done when:** admin gets a one-glance operational view.
      **Tag:** `v0.M5`

### M6 — Appliance ready (week 8)

#### Phase 27 — Backup & restore

**Depends on:** 2.

- [ ] WAL archiving configured in `postgres:16` container
- [ ] Nightly `pg_dump` to a configured local path
- [ ] Optional Duplicati hook to off-box (S3 / B2 / SFTP) — env-driven
- [ ] On-demand "Download backup" button in admin (encrypted tarball)
- [ ] Restore CLI: `pnpm restore <tarball>` — drains queues, restores DB, replays missing skills sync
      **Done when:** a tarball restore on a fresh appliance produces an identical state.

#### Phase 28 — Docker appliance & deployment

**Depends on:** 27.

- [ ] Multi-stage Dockerfile for `api` (Node 24 alpine) and `web` (nginx serving Vite build)
- [ ] `docker-compose.prod.yml` with Postgres + Redis + api + web + nginx reverse proxy
- [ ] Port 80 exposed; no port number in URL (matches Vibe TB pattern)
- [ ] Healthchecks on every service; restart `unless-stopped`
- [ ] First-run wizard (`/setup`): create admin user → enter Anthropic API key → pick default model → trigger initial skills sync
- [ ] Cockpit / Portainer compatibility (no special hostnames; sane defaults)
- [ ] **Tag `v1.0.0-rc1`**
      **Done when:** a fresh GMKtec NucBox M6 with Ubuntu 24.04 can clone the repo, run `docker compose -f docker-compose.prod.yml up -d`, complete the wizard, and produce a working chat appliance.

#### Phase 29 — Documentation, licensing, distribution

**Depends on:** 28.

- [ ] README.md with one-paragraph pitch + screenshots from `mockup.html`
- [ ] `docs/install.md` mirroring the Vibe TB Ubuntu/Docker/Portainer/Tailscale guide
- [ ] `docs/admin-guide.md`: API key rotation, model rate edits, user lifecycle, backup/restore
- [ ] `docs/cost-model.md`: token costs → dollar costs (Opus 4.7 tokenizer caveat included)
- [ ] `docs/skills-routing.md`: dispatcher routing logic
- [ ] `docs/web-resources.md`: domain allowlist, audit trail, v1.5 MCP migration path
- [ ] LICENSE (BSL 1.1, change date 4 years out, change license Apache 2.0)
- [ ] DISCLAIMER.md from the skills repo
- [ ] CHANGELOG.md with v1.0.0 entry
- [ ] Repo published at `KisaesDevLab/Vibe-Tax-Research-Chat`
- [ ] **Tag `v1.0.0`**
      **Done when:** a fresh CPA can read the README and have a working appliance in under an hour.

### v1.5 (post-launch, +4 weeks)

#### Phase 30 — Multi-source skills support

**Depends on:** 8.

- [ ] Allow more than one source repo in `settings.skills_sources[]`
- [ ] Conflict resolution when two repos define the same skill `name` (precedence by source order)
- [ ] Each source has its own pin and its own sync schedule

#### Phase 31 — Skill scoping (custom skills RBAC)

**Depends on:** 21.

- [ ] Per-skill ACL: which user roles can route to it
- [ ] Per-engagement scoping (combine with chat tagging)

#### Phase 32 — RAG reference library

**Depends on:** 14.

- [ ] pgvector extension + `reference_documents` and `reference_chunks` tables
- [ ] PDF / DOCX / TXT / MD / HTML ingestion (reuse Phase 23 parsers)
- [ ] OCR for scanned PDFs (reuse the GLM-OCR setup pattern from Vibe TB)
- [ ] Chunking: semantic + sentence boundary, 800-token target
- [ ] Embeddings via Voyage AI or Anthropic embeddings (multi-provider abstraction matching Vibe TB)
- [ ] Per-turn retrieval: top-k chunks injected into system prompt under `<reference_excerpts>` tag
- [ ] Citation discipline preserved: chunks include source attribution (`[Firm Reference: <title>, p.<page>]`)
- [ ] Admin → Reference Library: upload, tag, delete, search, "test retrieval" tool
- [ ] Per-chat toggle: "Use firm reference library" (default on)

#### Phase 33 — Document segmentation

**Depends on:** 32.

- [ ] Engagement-scoped subsets: documents tagged to a specific engagement only retrieve when that chat is also tagged
- [ ] Date-bounded retrieval: "only consult documents dated after 2024"

#### Phase 34 — Authority MCP server skeleton

**Depends on:** 17.

- [ ] New service `apps/authority-mcp` (Node.js + Express, MCP-compatible)
- [ ] MCP server exposes:
  - `usc_lookup(title, section, subsection?)` → canonical text + USLM cite
  - `cfr_lookup(title, part, section)` → reg text + eCFR cite
  - `fr_search(agency, date_from, date_to, query)` → Federal Register hits
  - `dawson_search(query, date_from?)` → Tax Court opinions
  - `irb_lookup(item)` → IRS Bulletin item
  - `pl_lookup(public_law)` → PL text + Classification Table
  - `state_dor_search(state, query)` → state guidance (top-10 states only initially)
- [ ] Each tool: cache check → upstream fetch on miss → parse → store → return
- [ ] Per-source TTLs:
  - USLM IRC: 30 days
  - eCFR: 30 days
  - IRS Bulletin: 30 days
  - Federal Register IRS: 24 hours
  - DAWSON: 7 days
  - State DOR: 7 days
  - Popular Name / Classification: 90 days
- [ ] `authority_cache` table populated on every fetch
- [ ] MCP server registered in docker-compose.prod.yml

#### Phase 35 — IRC + Title 26 CFR local mirror

**Depends on:** 34.

- [ ] Bulk download from official sources:
  - USLM XML for Title 26 from uscode.house.gov
  - eCFR JSON API for Title 26, Chapter I
  - GovInfo Public Law collections (post-1994)
- [ ] Background ingestion job parses XML/JSON into structured form
- [ ] Per-section addressable via the same `usc_lookup`/`cfr_lookup` tools — transparent to Claude
- [ ] "Last upstream sync" timestamp per source on the admin Skills page
- [ ] Weekly diff job: detect upstream changes, flag affected skills

#### Phase 36 — Per-source web→MCP migration

**Depends on:** 34.

- [ ] `settings.web_resource_strategy` per-source feature flag (`anthropic` | `mcp`)
- [ ] System prompt in Phase 12 conditionally exposes either MCP tools or `web_fetch` allowlist per source
- [ ] Migrate one source at a time behind the flag; rollback by flipping back to `anthropic`
- [ ] End state: all v1 sources → `mcp`

#### Phase 37 — Engagement freeze polish

**Depends on:** 8, 13.

- [ ] "Pin to current pack version" button on each chat
- [ ] Pinned chip on chat header showing pinned ref
- [ ] Pinned chats use `attached_skill_versions` from pin time, not current versions
- [ ] **Tag `v1.5.0`**

## 6 · Pricing manifest (seed)

```json
{
  "updated_at": "2026-04-27",
  "models": [
    {
      "model_id": "claude-opus-4-7",
      "display_name": "Claude Opus 4.7",
      "input_per_mtok": 5.0,
      "output_per_mtok": 25.0,
      "cache_write_per_mtok": 6.25,
      "cache_read_per_mtok": 0.5,
      "tokenizer_factor": 1.18,
      "web_fetch_unit_cost": 0.01,
      "web_search_unit_cost": 0.01,
      "notes": "New tokenizer adds up to 35% more tokens vs 4.6"
    },
    {
      "model_id": "claude-opus-4-6",
      "display_name": "Claude Opus 4.6",
      "input_per_mtok": 5.0,
      "output_per_mtok": 25.0,
      "cache_write_per_mtok": 6.25,
      "cache_read_per_mtok": 0.5,
      "tokenizer_factor": 1.0,
      "web_fetch_unit_cost": 0.01,
      "web_search_unit_cost": 0.01
    },
    {
      "model_id": "claude-sonnet-4-6",
      "display_name": "Claude Sonnet 4.6",
      "input_per_mtok": 3.0,
      "output_per_mtok": 15.0,
      "cache_write_per_mtok": 3.75,
      "cache_read_per_mtok": 0.3,
      "tokenizer_factor": 1.0,
      "web_fetch_unit_cost": 0.01,
      "web_search_unit_cost": 0.01
    },
    {
      "model_id": "claude-haiku-4-5",
      "display_name": "Claude Haiku 4.5",
      "input_per_mtok": 1.0,
      "output_per_mtok": 5.0,
      "cache_write_per_mtok": 1.25,
      "cache_read_per_mtok": 0.1,
      "tokenizer_factor": 1.0,
      "web_fetch_unit_cost": 0.01,
      "web_search_unit_cost": 0.01
    }
  ]
}
```

## 7 · Recommended default configuration

| Setting                   | Default                                                                                                           | Rationale                                                   |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Default model             | `claude-sonnet-4-6`                                                                                               | Best cost/quality for tax research; 1M context at flat rate |
| Web tools                 | On for Sonnet 4.6 / Opus 4.x; off for Haiku 4.5                                                                   | Verify citations on serious turns                           |
| Per-turn fetch budget     | 8 fetches, 4 searches                                                                                             | Cost guardrail                                              |
| Domain allowlist          | USLM, eCFR, federalregister.gov, dawson.ustaxcourt.gov, irs.gov, govinfo.gov, uscode.house.gov, top-10 state DORs | Locked; admin can extend                                    |
| Hide unverified citations | Off (warning treatment instead)                                                                                   | Strict firms can flip on                                    |
| Skills attached per turn  | up to 8, including `cpa-pack-index` and `compliance-ssts-circular230`                                             |                                                             |
| Prompt caching            | On, breakpoint after system prompt                                                                                | ~90% saving on repeat turns                                 |
| US-only inference         | Off                                                                                                               | Adds 1.1×; opt-in for compliance-sensitive firms            |
| Batch mode                | Off (real-time chat)                                                                                              | 50% discount only relevant for offline pipelines            |
| PII strip                 | Off                                                                                                               | Practitioners often need full numbers                       |
| Compliance banner         | On                                                                                                                | SSTS / Circular 230 mandatory in CPA context                |
| Monthly spend cap         | $0 (off) per user                                                                                                 | Admin sets per-user as needed                               |

## 8 · Cost projections per turn

| Strategy                                      | Web cost | Model cost | Total  |
| --------------------------------------------- | -------- | ---------- | ------ |
| No web tools (baseline)                       | $0.000   | $0.052     | $0.052 |
| Anthropic web tools, no cache                 | ~$0.040  | $0.058     | $0.098 |
| Anthropic + 50% appliance cache hit           | ~$0.020  | $0.054     | $0.074 |
| Custom MCP after warmup, 80% cache hit (v1.5) | ~$0.000  | $0.054     | $0.054 |

## 9 · Out of scope (v1)

- QuickBooks Online integration
- Multi-tenant SaaS (single-tenant appliance only)
- Mobile-native apps (responsive web only)
- Voice input / transcription
- Stripe billing (commercial license is per-firm via Kisaes)
- SSO / SAML (passwordless OnzAuth in v1.5; full SSO in v2)

## 10 · Open questions (QUESTIONS.md seeds with applied defaults)

These are the product-shape ambiguities. The autonomous build applies the defaults below and logs the question for later review — it does not block.

1. Single Anthropic key for the whole appliance, or per-user keys for firms wanting individual billing? **Default: single key in v1; per-user setting in v1.5.**
2. Default chat-history retention — forever or 7 years? **Default: forever, admin-configurable.**
3. Surface dispatcher's chosen skills in UI or hide? **Default: show (Phase 20).**
4. Stub-state warnings on per-state files? **Default: yes — banner on assistant message when any cited authority comes from a `stub` skill.**
5. Per-chat model override — admin-only or per-user? **Default: per-user with role flag.**
6. Streaming-cost UX — pure JS estimate vs periodic Haiku tokenizer call? **Default: cheap JS estimate.**

## 11 · Milestones

| Milestone                | Phases | Target        | Tag                        |
| ------------------------ | ------ | ------------- | -------------------------- |
| M1 — Skeleton up         | 1–3    | Week 1        | `v0.M1`                    |
| M2 — Admin can configure | 4–6    | Week 2        | `v0.M2`                    |
| M3 — Skills usable       | 7–11   | Weeks 3–4     | `v0.M3`                    |
| M4 — Core chat           | 12–17  | Week 5        | `v0.M4`                    |
| M5 — Output polish       | 18–26  | Weeks 6–7     | `v0.M5`                    |
| M6 — Appliance ready     | 27–29  | Week 8        | `v1.0.0-rc1` then `v1.0.0` |
| **v1.0.0**               | 1–29   | End of week 8 |                            |
| v1.5                     | 30–37  | Weeks 9–12    | `v1.5.0`                   |

## 12 · Acceptance criteria (v1.0.0)

The build is **shippable** when all of the following are true:

- [ ] All v1 phases (1–29) committed and tagged
- [ ] All tests green
- [ ] Fresh `docker compose -f docker-compose.prod.yml up -d` produces a working appliance on Ubuntu 24.04
- [ ] First-run wizard completes in under 5 minutes
- [ ] A reference research turn (the §199A QBI question from the mockup) produces:
  - A correctly-formatted answer
  - 4+ verified primary-source authorities (✓ chips, not ✗)
  - A passing SSTS / Circular 230 compliance checklist
  - A skills-attribution panel showing the routed pack
  - A cost ledger matching the actual `usage` block
- [ ] Admin can rotate the API key, change the default model, manage users, sync skills, view usage
- [ ] Cost per reference turn is within the §8 projection (~$0.092 ± 20%)
- [ ] README enables a CPA to install the appliance unaided in under an hour

When all of the above are checked: tag `v1.0.0`, push to `KisaesDevLab/Vibe-Tax-Research-Chat`, print "v1.0.0 ready."
