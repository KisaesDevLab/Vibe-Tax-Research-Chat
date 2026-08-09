# syntax=docker/dockerfile:1.7
# Multi-stage build for the authority-mcp service. Mirrors apps/api's
# Dockerfile structure (deps → dev / builder → runtime) so the image
# layout matches the rest of the suite — same pnpm version, same
# workspace symlink set, same CMD shape.

FROM node:24-alpine AS base
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

# ── deps stage ──────────────────────────────────────────────────────────
FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY apps/authority-mcp/package.json apps/authority-mcp/
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/
# db depends on @vibe/strategies (seed loads strategy content), which
# pulls engine + schema — the whole chain must be in the workspace or
# pnpm install fails with ERR_PNPM_WORKSPACE_PKG_NOT_FOUND.
COPY packages/schema/package.json packages/schema/
COPY packages/engine/package.json packages/engine/
COPY packages/strategies/package.json packages/strategies/
RUN pnpm install --frozen-lockfile=false

# ── dev stage ───────────────────────────────────────────────────────────
FROM deps AS dev
COPY . .
EXPOSE 4100
CMD ["pnpm", "--filter", "@vibe/authority-mcp", "dev"]

# ── build stage ─────────────────────────────────────────────────────────
FROM deps AS builder
COPY . .
# Dependency order: shared ← schema/engine ← strategies ← db (seed loads
# strategy content) ← authority-mcp.
RUN pnpm --filter @vibe/shared build \
 && pnpm --filter @vibe/schema build \
 && pnpm --filter @vibe/engine build \
 && pnpm --filter @vibe/strategies build \
 && pnpm --filter @vibe/db build \
 && pnpm --filter @vibe/authority-mcp build

# ── runtime stage ───────────────────────────────────────────────────────
FROM node:24-alpine AS runtime
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
COPY --from=builder /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=builder /app/apps/authority-mcp/package.json apps/authority-mcp/
COPY --from=builder /app/apps/authority-mcp/dist apps/authority-mcp/dist
COPY --from=builder /app/packages/db/dist packages/db/dist
COPY --from=builder /app/packages/db/package.json packages/db/
COPY --from=builder /app/packages/shared/dist packages/shared/dist
COPY --from=builder /app/packages/shared/package.json packages/shared/
# db's dist references @vibe/strategies (seed path); ship the chain so
# any import through db resolves instead of dangling on a symlink.
COPY --from=builder /app/packages/schema/dist packages/schema/dist
COPY --from=builder /app/packages/schema/package.json packages/schema/
COPY --from=builder /app/packages/engine/dist packages/engine/dist
COPY --from=builder /app/packages/engine/package.json packages/engine/
COPY --from=builder /app/packages/strategies/dist packages/strategies/dist
COPY --from=builder /app/packages/strategies/package.json packages/strategies/
# pnpm workspace install puts the actual dep store under
# /app/node_modules/.pnpm and exposes per-package symlinks at
# /app/<pkg>/node_modules. Same pattern as apps/api/Dockerfile.
COPY --from=builder /app/node_modules node_modules
COPY --from=builder /app/apps/authority-mcp/node_modules apps/authority-mcp/node_modules
COPY --from=builder /app/packages/db/node_modules packages/db/node_modules
COPY --from=builder /app/packages/shared/node_modules packages/shared/node_modules
COPY --from=builder /app/packages/schema/node_modules packages/schema/node_modules
COPY --from=builder /app/packages/engine/node_modules packages/engine/node_modules
COPY --from=builder /app/packages/strategies/node_modules packages/strategies/node_modules
# Build provenance, passed by release.yml — same pattern as apps/api.
ARG APP_VERSION=dev
ARG GIT_SHA=unknown
ARG BUILD_DATE=unknown
ENV APP_VERSION=$APP_VERSION GIT_SHA=$GIT_SHA BUILD_DATE=$BUILD_DATE
EXPOSE 4100
USER node
CMD ["node", "apps/authority-mcp/dist/server.js"]
