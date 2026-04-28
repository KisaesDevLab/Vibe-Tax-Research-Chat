# Changelog

## [Unreleased]

### Added

- Wide scaffolding pass across all 29 v1 phases: monorepo skeleton, tests, Docker config,
  schema, route handlers, docs.
- **Functional pass**: appliance now boots end-to-end. Postgres + Redis come up via Docker;
  `pnpm db:migrate` + `pnpm db:seed` populate 18 tables and the model registry; the API
  serves `/api/health/deep`, `/api/auth/login`, `/api/auth/me`, `/api/admin/*`, and
  `/api/chats/:id/messages` (SSE) end-to-end.
- Initial Drizzle migration (`packages/db/drizzle/0000_initial.sql`).
- Real Anthropic SDK calls (no fake shims) for chat streaming and skill upload.
- Workers: `chat-title` (Haiku 4.5 auto-titler), `attachment-summarize` (Haiku 4.5 doc
  summary), `usage-rollup` (UPSERT `usage_daily` from `usage_events`), `skills-sync`
  (nightly dry-run cron).
- Spend cap enforcement: `POST /chats/:id/messages` returns 402 when the chat owner has
  exceeded `monthly_spend_cap_usd`.
- Authorities + compliance sidecar parsers wired into the message-persist path; verified
  authorities cross-referenced against `primary_source_consultations` for ✓/✗ chips.
- 46 tests across 4 packages, all green; full typecheck clean; web bundle builds.
