# CLAUDE.md — architecture log for the Vibe Tax Research Chat repo

This file is the running architecture log. Append decisions, gotchas, and conventions
as they are discovered. The single source of truth for **what** to build is `BUILD_PLAN.md`;
this file records **how** the build evolved.

## Repo layout

```
apps/
  api/          # Express + TypeScript + Pino (Phase 1, 3-29 backend)
  web/          # React 18 + Vite + TypeScript + Tailwind (Phase 1, 3-26 UI)
packages/
  db/           # Drizzle ORM schema + migrations + seeds (Phase 2)
  shared/       # Cross-cutting types + skills routing + web allowlist (Phase 11, 16)
docs/           # Install, admin guide, cost model, routing, web resources (Phase 29)
scripts/        # Backup, restore, ops helpers (Phase 27)
```

## Conventions

- **Conventional commits** enforced via commitlint. Format: `feat(phase-N): …`, `fix(phase-N): …`, etc.
- **TypeScript strict mode** in every package via root `tsconfig.base.json`.
- **No plaintext secrets in logs.** Pino redaction is set up in `apps/api/src/lib/logger.ts`.
- **Crypto invariants.** API keys are AES-256-GCM with HKDF-derived per-key from `MASTER_KEY`. Decrypted only at the moment of an Anthropic call. Never persisted plaintext, never logged.
- **JWT split.** Access token (15m) and refresh token (30d) use _separate_ secrets. Refresh tokens are rotated on use and stored hashed in `auth_refresh_tokens`.
- **Audit log writes** are mandatory for every admin action. Use `lib/audit.ts` helper.

## Phase 1 — Foundation

- pnpm workspaces (`apps/*`, `packages/*`).
- ESLint flat config (ESLint 9), Prettier, Husky, commitlint, lint-staged.
- Vite + React + Tailwind in `apps/web`.
- Express + helmet + cors + Pino in `apps/api`.
- Health endpoints: `GET /api/health` (cheap), `GET /api/health/deep` (db + redis ping).
- Vitest in api and web.

## Phase 2 — Data model

- Drizzle ORM against Postgres 16. Schema files under `packages/db/src/schema/`.
- Initial migration via `drizzle-kit generate`, applied via `pnpm db:migrate`.
- Seed: env-driven admin (`SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`), full model registry from §6.
- Indexes: `messages.chat_id`, `usage_events.occurred_at`, `audit_log(actor_user_id, occurred_at)`.

## Phase 3 — Auth

- bcrypt cost 12.
- Login rate limit: 5 attempts / 15 min / IP (Redis sliding window).
- Refresh-token rotation: every refresh issues a new token and revokes the prior row.

## Operational gotchas

### Local dev port collisions

Default Postgres / Redis / Vite ports often clash with other Docker projects on the same
host. The dev stack is pinned to non-default ports to avoid this:

- Postgres → host **5439** (container 5432)
- Redis → host **6389** (container 6379)
- Vite dev server → host **5179** (container 5173)
- API → host **4000**

`docker-compose.prod.yml` keeps the standard 80 for nginx and uses internal-only Postgres
and Redis (no host port published).

### Drizzle-kit and ESM `.js` imports

drizzle-kit's CJS loader cannot resolve TypeScript-style `.js` extensions in source imports.
Workaround: `pnpm db:generate` first runs `tsc -p tsconfig.json`, then drizzle-kit reads from
`dist/schema/index.js`. Don't point drizzle-kit at the `src/` files directly.

### BullMQ queue names

BullMQ ≥5 forbids `:` in queue names and job IDs. Use `-` as the separator
(`skills-sync`, `chat-title`, `cron-skills-sync-nightly`).

### Anthropic SDK 0.40.1 surface

- Use `client.beta.messages.stream(body)` for chat streaming. The SDK doesn't yet type
  `container.skills[]` or the new tool shapes (`code_execution_20250825`,
  `web_fetch_20250828`, `web_search_20250828`); the body is cast through `as unknown as
MessageCreateParams` at the seam in `lib/anthropic/chat.ts`.
- Use `client.post('/v1/skills', { body, headers: { 'anthropic-beta': 'skills-2025-10-02' } })`
  for skill upload — there is no typed `client.beta.skills.create` yet.
- `tool_use` block input streams as `input_json_delta` chunks; assemble per-block-index
  until `content_block_stop`, then emit the complete tool_use event.

### dotenv lookup

Both the api package (`src/config/env.ts`) and the db package (`src/migrate.ts`,
`src/seed.ts`) explicitly load the workspace-root `.env` via
`dotenv.config({ path: path.resolve(__dirname, '../../../.env') })`. Don't rely on the
default cwd-relative lookup — pnpm's per-package cwd would miss it.

### Pino transports

`pino-pretty` is opt-in (`PRETTY_LOGS=1`) so the default startup doesn't crash if the
transport package is missing. JSON logs are the production default.

### Windows psql does not permute argv

`psql <url> -c <sql>` on Windows connects and then silently ignores everything after the
positional dbname (exit 0, no error). Always pass the URL via `-d` with options around it:
`psql -tAqX -d <url> -c <sql>`. This made every one-liner in `lib/backup/postgres.ts`
(extension preflight, session eviction) a no-op on Windows hosts until fixed.

### Destructive integration tests never target the app database

The DR v2 engine is parameterized by `EngineConfig.liveDbName`; its integration tests
create and destroy only `vibe_dr_*` databases. This rule exists because a v1 test restore
once replayed a dump into the LIVE dev database from the parallel suite and stripped
every constraint and index. If the dev DB is ever corrupted again: drop schema `public` +
`drizzle`, then `pnpm db:migrate && pnpm db:seed`.

### DR v2 invariants (lib/backup)

- The live database is NEVER written by a restore — scratch DB + verify + rename swap
  only. Every swap step is journaled before execution; `recoverRestore()` runs at boot
  BEFORE `MIGRATIONS_AUTO` (a mid-swap crash leaves no live DB and migrations would
  fatal-loop).
- The restore journal (`BACKUP_DIR/restore-journal.json`) is the single source of truth
  for restore state; in-memory state is forbidden (v1 lost it on restart).
- Extension DDL is skipped via pg_restore TOC filtering (`-L`), never regex on SQL.
- Manifest row counts come from `pg_export_snapshot()` shared with `pg_dump --snapshot`
  — exact compare after restore is sound.
- New features storing user data must put it under `config/paths.ts` `dataDirs()` or it
  is NOT covered by backups.

### pg_dump is schema-allowlisted (PostGIS tiger broke unscoped dumps)

Servers that carry PostGIS mark the tiger geocoder's config tables
(`tiger.geocode_settings` etc.) with `pg_extension_config_dump`, so an unscoped
`pg_dump` tries to COPY their data and dies with "permission denied for schema tiger"
under the app role. The backup dump is therefore allowlisted to the app's schemas via
`-n public -n drizzle` (`DUMP_SCHEMAS` in `lib/backup/pg.ts`). Two consequences:

- Any future migration that adds a third schema MUST extend `DUMP_SCHEMAS` or its data
  is silently not backed up.
- Naming `public` with `-n` makes pg_dump emit a `CREATE SCHEMA public` TOC entry,
  which is fatal on the scratch database under `--exit-on-error` — `filterToc` now
  drops the public SCHEMA/COMMENT entries alongside EXTENSION entries (non-public
  schemas like `drizzle` are kept; the scratch DB doesn't have them).
- Schema scoping is NOT enough: PostGIS puts `spatial_ref_sys` IN `public` and marks
  it `pg_extension_config_dump`, so `-n public` still emits its DATA (never its DDL).
  Loading that COPY on another server fails — permission denied where the template
  carries PostGIS (table owned by the extension), relation-missing where it doesn't.
  Three-layer fix: `withSnapshot` reports extension-owned tables (pg_depend deptype
  'e') and excludes them from manifest counts; the dump passes them as
  `--exclude-table-data`; `filterToc` drops TABLE DATA entries with no matching TABLE
  definition (covers archives taken ≤ v0.10.1); verify skips extension-owned or
  undefined tables named by older manifests.

### Restores re-key secrets automatically (no MASTER_KEY hand-off)

The archive carries the source server's MASTER_KEY (inside the passphrase-encrypted
stream). When it differs from this server's, the verify phase re-encrypts every
`settings` row with `is_encrypted = true` from the archive key to `config.masterKey`
(`rekeySecrets` in `lib/backup/engine.ts`) — still on the scratch DB, before the swap,
so failure aborts with the live install untouched. `result.masterKeyMatches` is then
true and the archive key is never surfaced. The manual "set MASTER_KEY + restart"
report only remains for archives that carry no key. Rows undecryptable under the
archive key were already dead on the source — they're left as-is and listed in
`verify.rekeyFailures`, never allowed to sink the restore. Crypto primitives live in
`lib/crypto.ts` as `sealWith`/`openWith` (explicit key; `seal`/`open` wrap env).

### nginx upload cap vs backup restores

nginx defaults `client_max_body_size` to 1MB; without an override in
`apps/web/nginx.conf`'s `/api/` location, every backup-archive upload (first-run setup
restore, Admin → Backup & restore) died at nginx with 413 before the api saw it. The
location now sets `client_max_body_size 0` + `proxy_request_buffering off` — the api's
multer limits are authoritative. Keep any future proxy layer (Caddy etc.) at least as
permissive.

### Claude call retry/timeout semantics (shared)

Both call paths use `lib/anthropic/retry.ts` (`withRetry`): 3 attempts, jittered backoff,
optional `retry-after` initial delay. The router path passes `deadlineMs` — the configured
per-job timeout is an OVERALL bound covering attempts and sleeps, not a per-attempt one.
Router `finish_reason: 'error'` is a failed attempt (`RouterProviderFailure`), never a
successful empty completion.

### AI mode is DB-backed with an env default

`aiMode()` returns the `ai_mode` settings row (cached in-process, hydrated at boot via
`loadAiModeOverride()` BEFORE task-class registration) falling back to `VIBE_AI_MODE`.
The admin toggle (`POST /api/admin/settings/ai-mode`) proves router reachability with a
live `registerTaskClasses` round trip before persisting — a data-boundary flip is never
saved on faith, and both directions are audited. `testRouterConnection()` doubles as the
Settings-page "Test router connection" button. There is still no runtime fallback
between modes.

### Task classes are per-CORPUS, and the chat path is never routable

A router task class is the unit an operator sets a data policy on (local_only vs
cloud_deidentified). Two jobs may share one **only if widening the policy for one is
knowingly widening it for the other** — so the axis is the corpus, not the token budget or
the model. The three corpora are chat content, admin authoring over public tax law, and
client-owned documents; they never share a class.

`client-doc-classify` violated this: it ships up to 6 KB of Shield-redacted client document
text, but sat in `CONTENT_META` next to chat titles. Since CONTENT_META starts local_only,
an operator widening it to get titles off-box would have silently carried client document
pages across the same boundary. It now has its own `CLIENT_DOC_META`
(`taxresearch_client_doc_meta`). That also fixed a second latent bug: CONTENT_META declares
`requires: {}`, but `client-doc-classify` forces a tool — and the router picks a provider
from `requires`, so a tool-forcing job under a tool-free class can be handed to a backend
that cannot make the call. Three invariants in `router-mode.test.ts` now hold the line
(every mapped class is declared; tool-forcing jobs sit in `requires.tools` classes; no
class spans two corpora).

Separately: **the streaming chat path is always direct and structurally cannot route.**
`callClaude` is the only router entry point (`client.ts:129`); `streamChat` never touches
it, and `toRequestOptions` throws on any tool without an `input_schema`, which is exactly
what Anthropic's server tools are. So the web-tool caps (`max_uses`) and router mode are
disjoint concerns — the caps only ever apply on the direct path. `tables-draft` and
`strategy-watch` are pinned `null` in `JOB_TASK_CLASS` for the same reason.

### Model registry: unpriced discoveries insert as inactive

The Anthropic Models API returns no pricing, so `refresh/apply` inserts
`pricing_unknown` models with $0 rates and `is_active: false`; the PATCH handler
refuses `is_active: true` while input+output pricing are both zero
(`pricing_required_to_activate`). Admins set rates via the inline "edit pricing" row
on Admin → Models, then enable.

### Tables-draft is web-grounded and pinned direct

`tables-draft` now carries the server-side web_search tool (max 8 uses, allow-listed to
`WEB_ALLOWLIST_DOMAINS`) so next-year figures are verified against official sources at
draft time — which pins it direct in router mode alongside `strategy-watch` (the router
cannot forward server tools). Two crons (Oct 1 + Nov 15 — the Rev. Proc. usually lands
between them) plus a manual `POST /api/admin/table-sets/draft` trigger; the handler's
open-review-item dedupe makes all three idempotent. DRAFT table sets are editable
(`PATCH /api/admin/table-sets/:id`, drafts only — published sets stay immutable); an
edit recomputes the open review item's field diff against its recorded base.

### The web allowlist is compile-time, and silence is its failure mode

`packages/shared/src/web-allowlist.ts` is a plain constant compiled into the tool
definitions (`lib/anthropic/chat.ts`, `jobs/handlers/currency.ts`). Despite what its
header comment used to claim, there is no admin route and no settings row behind it —
extending coverage means editing the file, rebuilding `@vibe/shared`, and redeploying.

The failure mode is what makes this dangerous: `allowed_domains` constrains `web_search`
itself, not just `web_fetch`, and out-of-list results are **silently omitted** rather than
erroring. When the list held only the top-10 states' DORs, a Missouri question searched a
universe containing no Missouri, got nothing back, and the model reported the search tool
as "rate-limited" — a confabulated cause — then answered from parametric memory with the
citations self-flagged for verification. Coverage now spans all 50 states + DC (90
entries).

Rules that shape the list, enforced where mechanical by `web-allowlist.test.ts`:

- A listed domain covers its subdomains, so `mo.gov` reaches `dor.mo.gov` AND
  `revisor.mo.gov` in one entry; a listed subdomain covers only itself. Widen an existing
  entry rather than appending — `web_search` returns `request_too_large` on long domain
  filter lists.
- A cross-domain redirect needs BOTH sides listed (the filter re-applies to the target).
  Live case: `marylandtaxes.gov` → `marylandcomptroller.gov`.
- Entries are plain ASCII hostnames — no scheme, port, path, or wildcard. `web_fetch`
  matches on domain only, so a path entry never matches a fetch URL.
- Request-level `allowed_domains` must be a SUBSET of any org-level allowlist set in the
  Claude Console, or the whole request 400s naming the conflict.

Three follow-ons landed with the expansion:

- **The system prompt states reachability, rendered FROM the list.**
  `describeReachableSources()` (@vibe/shared) emits the federal domains, the jurisdiction
  count, and — the part that actually does the work — the categories that are _never_
  reachable (CCH/Checkpoint/BNA/Westlaw/Lexis, practitioner commentary, municipal, non-US).
  Without it the model cannot tell "no results" from "out of scope", which is exactly how
  it arrived at a confabulated "rate-limited". Do NOT restate this coverage by hand
  anywhere: a prompt claiming coverage the list lacks is worse than no prompt, and the
  guard test asserts the rendered text against the list.
- **Empty results may not degrade into memory.** `buildSystemPrompt` forbids asserting
  that a tool is rate-limited/unavailable (the model cannot observe that) and forbids the
  answer-from-memory-with-flagged-cites pattern. A self-flagged cite reads identically to a
  verified one, so it is treated as worse than an explicit gap, not better.
- **Per-turn web budget raised 8/4 → 12/10** (`DEFAULT_WEB_BUDGET`, the `models` column
  defaults, `seeds/models.json`, and migration 0018). The budget is per-MODEL in the DB, so
  the constant is only a fallback — changing it alone would have left every existing
  install on 4 searches. 0018 matches the old `8 AND 4` pair specifically, so admin-tuned
  rows and the intentional 0/0 Haiku row are untouched.

### Strategy drafts: machine fields are restored in code

Claude sometimes "keeps" machine fields from the keep-unchanged list by emitting them
as null — an advisory record gains an all-null `model` block (the
"model.applyOrder: Expected number, received null" validator failure). Because the
contract is UNCHANGED, `restoreMachineFields()` enforces it deterministically after
every parse: null/missing machine fields are restored from the current version, and a
fabricated model block on an advisory record is dropped. Don't relax this back to
prompt-only.

### One markdown/PDF renderer stack (archive export readability)

The archive → PDF export used to print the frozen transcript as raw text, so
every `##`, `**bold**`, and pipe table landed on the page as syntax. It now
renders through the same markdown renderer the plan memo uses, and the layout
mirrors the on-screen archive viewer (serif body, role-labelled turns hanging
off a left rail, provenance header, footer + page numbers). The PDFKit stack
is now:

- `export/pdf-text.ts` — WinAnsi guards. `sanitizeForHelvetica` trims (block
  text); `sanitizeRun` deliberately does NOT — a paragraph is a chain of runs
  joined with `continued: true`, so the space separating a plain run from a
  bold/linked one lives at the run boundary and trimming it welds words
  together ("challenge under**Reg. §1.162-1**" → "underReg."). `sanitizeForCode`
  preserves interior whitespace for ASCII-art alignment.
- `export/pdf-blocks.ts` — GFM pipe tables (column water-fill, header repeat on
  continuation pages) and tinted Courier code blocks, parameterized by font
  family. Shared by `response-pdf.ts` (Helvetica) and `render/markdown-pdf.ts`
  (Times). NOTE: `splitTableRow`'s escaped-pipe placeholder is a literal NUL —
  a printable stand-in would be re-expanded into spurious pipes.
- `render/markdown-pdf.ts` — marked-driven; owns inline runs (bold/italic/code/
  links), headings, lists, blockquotes, and delegates tables + code to
  pdf-blocks. `headingScale` opens the scale up for documents that own their
  page (archive) vs. sit under a section heading (memo).
- `export/archive-pdf.ts` — per-turn left rails are recorded as page/y spans
  during the flow and stroked in the `bufferPages` stamping pass, so a rail
  never paints over the footer when a turn crosses a page. Turn bodies are
  indented by moving the margin (`withIndent`), not by an offset, because table
  and code widths derive from the page margins; PDFKit hands new pages the
  document's own margins object, so continuation pages keep the indent.

Both the PDF and the viewer run `stripSidecars` over snapshot content
(`web/src/lib/sidecars.ts` mirrors `api/src/lib/parsing/sidecars-strip.ts`) —
the viewer was previously showing the raw authorities/compliance JSON that the
live chat has always stripped.

### Fact patterns (TP-3a/6a/5a/8a): canonical schema, Shield gate, one Voyage stack

The client-owned fact-pattern feature set (addendum sub-phases) landed with
these invariants:

- **Canonical fact schema is in-repo**: `packages/shared/src/facts/fact-schema.json`
  (semver-tagged), mirrored by TS types (same dir), the zod gate
  (`packages/schema/src/fact-pattern.ts`), and the evaluator path whitelist
  (`packages/schema/src/fact-paths.ts`). Four drift guards fail `pnpm -r test`
  if any of them diverge — bump them TOGETHER with `FACT_SCHEMA_VERSION`.
- **Shield-before-inference is a pipeline ORDER invariant** in
  `lib/client-documents/ingest.ts`: tokens → pages → `shieldPages` (lib/pii
  redaction) → classify/extract/chunk/embed. No document text reaches storage
  or any LLM un-redacted; the fact schema structurally excludes PII. Don't
  reorder these steps.
- **One embeddings stack.** `document_chunks` and its retrieval
  (`lib/documents/retrieve.ts`) use the SAME `getEmbeddingsClient()` as
  ingest — a query embedded under a different model returns garbage
  similarities silently.
- **Fact-pattern versioning has ONE write path**:
  `createFactPatternVersion` (`lib/facts/versions.ts`) — supersede-current +
  MAX+1 inside the caller's transaction; the partial unique index
  (one current row per client) backstops races as 409 `version_conflict`.
  Client merge repoints fact patterns/documents (superseding the source
  current first); client delete hard-deletes them, files included.
- **Suggest is tri-state** (`evaluateSuggestRuleTri` in @vibe/shared):
  `facts.*` leaves resolve against the plan's snapshot, missing → `unknown`
  (never false), Kleene composition, present-but-empty array = known false.
  Legacy `evaluateSuggestRule` is byte-compatible and profile-only. Any
  suggest-rule change requires a semver bump to reach existing installs; the
  seed advances `current_version_id` ONLY over seed-owned pointers
  (`change_note='seed'`) to a strictly higher semver.
- **`doc_citations` is the third sidecar** — extractor in
  `lib/parsing/doc-citations.ts`, persisted on messages, and BOTH strippers
  (`api/src/lib/parsing/sidecars-strip.ts` ↔ `web/src/lib/sidecars.ts`)
  carry it; any future sidecar must be added to both in one commit.
- Plan-mode chat (`chats.mode='plan'`) assembles its preamble + client-doc
  retrieval inside `routes/chats/messages.ts` at the `assembleSystemPrompt`
  seam; `streamChat` itself is untouched and stays always-direct.
- `fact-extract` runs under router class `taxresearch_fact_extract`
  (starts local_only); ingest degrades to `extraction_error` (chunks still
  index) when extraction fails for any reason.

### Question mode: a prompt block plus a fourth sidecar, not an uploaded skill

`chats.question_mode` (default false; header chip, PATCH field, same shape as the
reference-library toggle) makes the model interview the researcher before it spends any
research budget. The operator's instruction ("ask me questions one at a time … until you
reach 95% confidence … wait for my signal") is quoted VERBATIM in
`lib/anthropic/question-mode.ts` and appended as the LAST block of `buildSystemPrompt`
(the rules say "before you do any work", so they must be the final thing the model reads).

- It is a **prompt block, not a pack skill**: the skills pack is synced from the separate
  skills repo, and a per-chat toggle has to switch the behaviour without a pack release.
- The framing turns the instruction into three explicit states (Interviewing / Ready /
  Proceeding) because the pipeline is stateless per turn — the model re-derives which
  state it is in from the transcript on every call. Follow-ups on the same matter stay in
  Proceeding; a materially new question restarts the interview. Web tools stay enabled
  on interviewing turns (the state is not known before the call); the prompt forbids
  using them.
- **`clarify` is the fourth sidecar** (`{status:'asking'|'ready', confidence, question,
options?, summary?, plan?}`): extractor `lib/parsing/clarify.ts`, persisted on
  `messages.clarification`, rendered by `components/panels/ClarifyPanel.tsx`, and carried
  by BOTH strippers. Only the latest assistant turn's card is interactive; answers and
  the "Proceed" button post ordinary user messages, so the transcript stays a plain chat.
- Confidence is normalized to a 0–1 fraction ("95" / "95%" accepted); a generic JSON
  fence only counts as a card when its `status` is `asking`/`ready`, so a quoted API
  response with a `status` key is not mistaken for one. The strippers key on that same
  status value too — live, the model opened the fence as plain ```json and the card
  rendered as a JSON wall when only the tag word was matched.
- **Answers are linked back to the card.** A message sent from the card carries
  `clarify_answer: {message_id, kind: option|freeform|proceed, question?}` (POST body →
  `messages.clarify_answer`, user rows only; the route drops links that don't name an
  assistant turn in the same chat). The "You" label renders it as "picked / answered for
  ‹question›" or "gave the go-ahead". The model sees only the plain answer text — the
  question is the previous turn, so the link is display metadata, not prompt input.
- **A lost SSE `done` must not pin the page.** `useChatStream` ignores events after
  `reset()` (no phantom in-flight turn), and `Chat.tsx` treats a refetch that shows
  user + assistant rows persisted since the send as the turn being over. Both exist
  because the card's controls only render on the latest turn with no stream in flight.

### Chat history search is ILIKE, per-user, and uncached server-side

`GET /api/chats/search?q=` (registered BEFORE `/:id` so "search" is never parsed as a
chat id) matches titles and user/assistant message content with ILIKE substring
patterns — deliberately not FTS, because researchers search for cites like `199A` or
`1.263(a)-3` that stemming mangles. One row per chat via two LATERAL subqueries (newest
matching turn for the excerpt, match count; `system_note` rows excluded);
`lib/search/snippet.ts` builds the excerpt AFTER `stripSidecars` so JSON never surfaces,
and `likePattern` escapes the percent sign, the underscore, and the backslash.

Scope is `chats.user_id = caller` (admins may pass `user_id`, as on the list route), so
two users typing the same query never see each other's chats. There is no server-side
result cache; the only cache is React Query's per-browser-tab memory (30 s stale time,
keyed by query text), which never leaves the tab. Trigger: sidebar magnifier or ⌘/Ctrl+K,
`components/ChatSearchDialog.tsx`. No index backs the ILIKE scan — fine at appliance
scale; add pg_trgm GIN indexes on `messages.content` / `chats.title` if a firm outgrows it.

## Open architectural decisions

See `QUESTIONS.md` for ambiguities resolved with applied defaults during the autonomous build.
