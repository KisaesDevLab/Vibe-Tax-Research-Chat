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

### Model registry: unpriced discoveries insert as inactive

The Anthropic Models API returns no pricing, so `refresh/apply` inserts
`pricing_unknown` models with $0 rates and `is_active: false`; the PATCH handler
refuses `is_active: true` while input+output pricing are both zero
(`pricing_required_to_activate`). Admins set rates via the inline "edit pricing" row
on Admin → Models, then enable.

## Open architectural decisions

See `QUESTIONS.md` for ambiguities resolved with applied defaults during the autonomous build.
