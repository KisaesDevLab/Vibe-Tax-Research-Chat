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
- **JWT split.** Access token (15m) and refresh token (30d) use *separate* secrets. Refresh tokens are rotated on use and stored hashed in `auth_refresh_tokens`.
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

## Open architectural decisions

See `QUESTIONS.md` for ambiguities resolved with applied defaults during the autonomous build.
