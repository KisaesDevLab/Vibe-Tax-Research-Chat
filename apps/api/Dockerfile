# syntax=docker/dockerfile:1.7
# Multi-stage build for the API. Phase 28.

FROM node:20-alpine AS base
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

# ── deps stage ──────────────────────────────────────────────────────────
FROM base AS deps
# bcrypt has no prebuilt binary for Alpine (musl) and falls back to a
# node-gyp source build, which needs python3 + a C++ toolchain. Without
# these, `pnpm install` fails the moment the GHA layer cache misses
# (e.g., after a lockfile change). The packages live in the deps stage
# only — runtime is a fresh `node:20-alpine` and stays slim.
RUN apk add --no-cache python3 make g++
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
COPY --from=builder /app/packages/db/drizzle packages/db/drizzle
COPY --from=builder /app/packages/db/seeds packages/db/seeds
COPY --from=builder /app/packages/shared/dist packages/shared/dist
COPY --from=builder /app/packages/shared/package.json packages/shared/
# pnpm's workspace install puts the actual dep store under
# /app/node_modules/.pnpm and exposes per-package symlinks at
# /app/<pkg>/node_modules. Without all four COPY lines node's module
# resolution from `apps/api/dist/*.js` walks up to /app/apps/api/node_modules
# and finds nothing for deps declared on the api package — the runtime
# crashes at import with ERR_MODULE_NOT_FOUND on express-async-errors,
# pdfkit, cookie-parser, etc.
COPY --from=builder /app/node_modules node_modules
COPY --from=builder /app/apps/api/node_modules apps/api/node_modules
COPY --from=builder /app/packages/db/node_modules packages/db/node_modules
COPY --from=builder /app/packages/shared/node_modules packages/shared/node_modules
EXPOSE 4000
USER node
CMD ["node", "apps/api/dist/index.js"]
