# syntax=docker/dockerfile:1.7
# Multi-stage build for the web. Phase 28.

FROM node:20-alpine AS base
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile=false

FROM deps AS dev
COPY . .
EXPOSE 5173
CMD ["pnpm", "--filter", "@vibe/web", "dev"]

FROM deps AS builder
COPY . .
RUN pnpm --filter @vibe/shared build \
 && pnpm --filter @vibe/web build

# Production: nginx serves the static bundle.
#
# The Vite build bakes `/__VIBE_BASE_PATH__/` into every asset URL so
# a single image can serve any prefix. The 40-base-path.sh hook below
# runs before nginx and `sed -i` substitutes the sentinel based on
# VITE_BASE_PATH (defaults to '/'). Single-app boots leave assets at
# `/assets/...`; multi-app boots (vibe-installer's grouped overlay)
# pass `VITE_BASE_PATH=/tax/` and the same image serves
# `/tax/assets/...` instead. No rebuild needed to switch modes.
FROM nginx:1.27-alpine AS runtime
COPY --from=builder /app/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf

# Runtime base-path hook. Strip CR in case the build context was
# checked out on Windows with core.autocrlf=true.
COPY apps/web/docker-entrypoint.d/40-base-path.sh /docker-entrypoint.d/40-base-path.sh
RUN sed -i 's/\r$//' /docker-entrypoint.d/40-base-path.sh \
 && chmod +x /docker-entrypoint.d/40-base-path.sh

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
