# syntax=docker/dockerfile:1.7
# Multi-stage build for the API. Phase 28.

FROM node:24-alpine AS base
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

# ── deps stage ──────────────────────────────────────────────────────────
FROM base AS deps
# bcrypt has no prebuilt binary for Alpine (musl) and falls back to a
# node-gyp source build, which needs python3 + a C++ toolchain. Without
# these, `pnpm install` fails the moment the GHA layer cache misses
# (e.g., after a lockfile change). git is required at runtime by the
# skills sync job (simple-git spawns the `git` binary to fetch the
# skills repo).
RUN apk add --no-cache python3 make g++ git
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY apps/api/package.json apps/api/
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/
COPY packages/schema/package.json packages/schema/
COPY packages/engine/package.json packages/engine/
COPY packages/strategies/package.json packages/strategies/
RUN pnpm install --frozen-lockfile=false

# ── dev stage ───────────────────────────────────────────────────────────
FROM deps AS dev
COPY . .
EXPOSE 4000
CMD ["pnpm", "--filter", "@vibe/api", "dev"]

# ── build stage ─────────────────────────────────────────────────────────
FROM deps AS builder
COPY . .
# Dependency order: shared ← schema/engine ← strategies ← db (seed loads
# strategy content) ← api.
RUN pnpm --filter @vibe/shared build \
 && pnpm --filter @vibe/schema build \
 && pnpm --filter @vibe/engine build \
 && pnpm --filter @vibe/strategies build \
 && pnpm --filter @vibe/db build \
 && pnpm --filter @vibe/api build

# ── runtime stage ───────────────────────────────────────────────────────
FROM node:24-alpine AS runtime
WORKDIR /app
# git is required at runtime by the skills sync job (simple-git spawns
# `git` to fetch the skills repo). su-exec lets the entrypoint fix the
# ownership of mounted data directories as root and then drop to `node`.
# Keep the rest of the runtime slim.
# postgresql client for Admin → Backup & Restore. BOTH majors are installed
# so the app can match the client to the server: pg_dump 17 writes
# `SET transaction_timeout` into every dump, which PostgreSQL 16 rejects on
# restore — the backup looks fine and only fails when you need it. Alpine
# keeps them side by side under /usr/libexec/postgresql<major>/.
RUN apk add --no-cache git su-exec postgresql16-client postgresql17-client \
 && corepack enable && corepack prepare pnpm@9.15.9 --activate
COPY --from=builder /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=builder /app/apps/api/package.json apps/api/
COPY --from=builder /app/apps/api/dist apps/api/dist
COPY --from=builder /app/packages/db/dist packages/db/dist
COPY --from=builder /app/packages/db/package.json packages/db/
COPY --from=builder /app/packages/db/drizzle packages/db/drizzle
COPY --from=builder /app/packages/db/seeds packages/db/seeds
COPY --from=builder /app/packages/shared/dist packages/shared/dist
COPY --from=builder /app/packages/shared/package.json packages/shared/
COPY --from=builder /app/packages/schema/dist packages/schema/dist
COPY --from=builder /app/packages/schema/package.json packages/schema/
COPY --from=builder /app/packages/engine/dist packages/engine/dist
COPY --from=builder /app/packages/engine/package.json packages/engine/
# strategies dist includes the content/ JSON records the db seed loads.
COPY --from=builder /app/packages/strategies/dist packages/strategies/dist
COPY --from=builder /app/packages/strategies/package.json packages/strategies/
# pnpm's workspace install puts the actual dep store under
# /app/node_modules/.pnpm and exposes per-package symlinks at
# /app/<pkg>/node_modules. Without a COPY per workspace package node's
# module resolution from `apps/api/dist/*.js` walks up to
# /app/apps/api/node_modules and finds nothing for deps declared on the
# api package — the runtime crashes at import with ERR_MODULE_NOT_FOUND
# on express-async-errors, pdfkit, cookie-parser, etc.
COPY --from=builder /app/node_modules node_modules
COPY --from=builder /app/apps/api/node_modules apps/api/node_modules
COPY --from=builder /app/packages/db/node_modules packages/db/node_modules
COPY --from=builder /app/packages/shared/node_modules packages/shared/node_modules
COPY --from=builder /app/packages/schema/node_modules packages/schema/node_modules
COPY --from=builder /app/packages/engine/node_modules packages/engine/node_modules
COPY --from=builder /app/packages/strategies/node_modules packages/strategies/node_modules
# Migrate (and idempotently seed) on boot. The image ships
# packages/db/drizzle, so a container upgrade applies its own schema
# instead of silently running new code against an old database — the
# failure mode that made every deliverable render die with
# `relation "plan_memos" does not exist`. Migration is serialized by a
# Postgres advisory lock, so parallel container starts are safe, and a
# failure is fatal before the listener binds. Override with
# `-e MIGRATIONS_AUTO=false` to keep migrations a manual step.
ENV MIGRATIONS_AUTO=true

# Runtime write paths, created and owned by `node` BEFORE dropping
# privileges. Everything COPYed above lands root-owned, so without this the
# unprivileged process cannot create its own directories: deliverable
# rendering died with
#   EACCES: permission denied, mkdir '/app/storage/deliverables'
# and chat attachments / reference uploads would fail the same way.
#
# This also fixes the volume case. When a named volume is mounted over one
# of these paths, Docker seeds the empty volume from the image — including
# ownership — so the mount inherits node:node instead of root:root. (Bind
# mounts keep host ownership; that stays an operator concern.)
RUN mkdir -p /app/storage/deliverables /app/attachments /app/workspaces /app/backups \
 && chown -R node:node /app/storage /app/attachments /app/workspaces /app/backups

# The entrypoint runs as root only long enough to take ownership of mounted
# data directories, then execs the app as `node`. A Dockerfile chown cannot
# do this alone: bind mounts (the appliance uses /opt/vibe/data/...) and
# non-empty named volumes always keep the source's ownership, so the fix has
# to happen after the mounts exist. Set `user:` in compose to skip the
# root phase entirely.
COPY --chmod=0755 apps/api/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

EXPOSE 4000
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "apps/api/dist/index.js"]
