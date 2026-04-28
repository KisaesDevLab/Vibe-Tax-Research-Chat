# syntax=docker/dockerfile:1.7
# Multi-stage build for the API. Phase 28.

FROM node:20-alpine AS base
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

# ── deps stage ──────────────────────────────────────────────────────────
FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY apps/api/package.json apps/api/
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile=false

# ── dev stage ───────────────────────────────────────────────────────────
FROM deps AS dev
COPY . .
EXPOSE 4000
CMD ["pnpm", "--filter", "@vibe/api", "dev"]

# ── build stage ─────────────────────────────────────────────────────────
FROM deps AS builder
COPY . .
RUN pnpm --filter @vibe/shared build \
 && pnpm --filter @vibe/db build \
 && pnpm --filter @vibe/api build

# ── runtime stage ───────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
COPY --from=builder /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=builder /app/apps/api/package.json apps/api/
COPY --from=builder /app/apps/api/dist apps/api/dist
COPY --from=builder /app/packages/db/dist packages/db/dist
COPY --from=builder /app/packages/db/package.json packages/db/
COPY --from=builder /app/packages/shared/dist packages/shared/dist
COPY --from=builder /app/packages/shared/package.json packages/shared/
COPY --from=builder /app/node_modules node_modules
EXPOSE 4000
USER node
CMD ["node", "apps/api/dist/index.js"]
