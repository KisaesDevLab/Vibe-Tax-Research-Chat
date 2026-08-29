[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/I3D3227TTP)

# Vibe Tax Research Chat

> Self-hosted, single-tenant AI chat appliance for U.S. CPAs. The firm owns its Anthropic API
> key, the chat history stays on the firm's hardware, and every turn shows actual token cost,
> verified primary-source citations, and SSTS / Circular 230 disclosures.

**Status:** scaffolding pass. See `BUILD_PLAN.md` for the v1.0.0 spec and `QUESTIONS.md` for the
applied defaults during the build.

**License:** PolyForm Internal Use 1.0.0 — source-available, not open source:
internal business use is permitted, distribution is not. See `LICENSE`. The
bundled Vibe CPA Skills pack is licensed separately under BSL 1.1.

## Quick start (dev)

```bash
# 1. Tooling: Node 24, pnpm 9, Docker.
node --version    # >= 24.0.0
pnpm --version    # >= 9.0.0
docker --version

# 2. Clone + install.
pnpm install

# 3. Generate secrets and copy env.
cp .env.example .env
# fill MASTER_KEY (openssl rand -hex 32)
# fill JWT_SECRET, JWT_REFRESH_SECRET (openssl rand -hex 64 each)
# set SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD

# 4. Start Postgres + Redis.
docker compose up -d postgres redis

# 5. Migrate + seed the DB.
pnpm db:migrate
pnpm db:seed

# 6. Start api and web in dev mode.
pnpm dev
# api  → http://localhost:4000
# web  → http://localhost:5173
```

Log in with the seeded admin credentials, then go to **Admin → Settings** to add your Anthropic
API key and pick a default model.

## Production install (single-box appliance)

```bash
git clone https://github.com/KisaesDevLab/Vibe-Tax-Research-Chat
cd Vibe-Tax-Research-Chat
cp .env.example .env  # set secrets
docker compose -f docker-compose.prod.yml up -d
# Open http://<box-ip>/setup for the first-run wizard.
```

Full install guide: `docs/install.md`.

## Architecture (one-page)

| Layer         | Choice                                                                           |
| ------------- | -------------------------------------------------------------------------------- |
| Frontend      | React 18 + TypeScript + Vite + Tailwind + TanStack Query + Zustand               |
| Backend       | Node 24 + Express + TypeScript + Pino                                            |
| ORM / DB      | Drizzle ORM + PostgreSQL 16                                                      |
| Cache / queue | Redis 7 + BullMQ                                                                 |
| AI            | `@anthropic-ai/sdk` with `code-execution-2025-08-25` + `skills-2025-10-02` betas |
| Streaming     | Server-Sent Events from Express → React                                          |
| Editor        | Monaco (skill authoring + diff viewing)                                          |
| Distribution  | Docker Compose appliance                                                         |

See `BUILD_PLAN.md §3` for the full architecture, `BUILD_PLAN.md §4` for the data model,
and `CLAUDE.md` for the running architecture log.

## Documentation

- `docs/install.md` — production install on Ubuntu 24.04 (NUC / mini-PC)
- `docs/admin-guide.md` — API key rotation, user lifecycle, backup/restore
- `docs/cost-model.md` — token costs → dollar costs (Opus 4.7 tokenizer caveat)
- `docs/skills-routing.md` — how the dispatcher chooses skills per turn
- `docs/web-resources.md` — domain allowlist + audit trail

## Repo conventions

- Conventional commits (commitlint enforced).
- TypeScript strict everywhere.
- pnpm workspaces; never run `npm` or `yarn` here.
- `pnpm test` runs Vitest across all packages.
- Append to `CLAUDE.md` whenever you change architecture; append to `QUESTIONS.md` whenever
  you punt on a decision.

## Author

Kurt Kohrumel, CPA — Kisaes LLC.
