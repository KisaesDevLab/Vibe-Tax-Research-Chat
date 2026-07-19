#!/usr/bin/env bash
# Phase 27 — nightly pg_dump. Run from cron on the host.
# Outputs a gzipped SQL dump into BACKUP_DIR (default ./backups).
#
# Modes (BACKUP_MODE, default `compose`):
#   compose — pg_dump inside the compose postgres container (production).
#   local   — pg_dump against a directly reachable Postgres (TP-15 restore
#             drill, non-docker installs). Connection comes from the
#             standard libpq env vars (PGHOST/PGPORT/PGUSER/PGPASSWORD/
#             PGDATABASE) or a full PG_URL.
#
# Env knobs:
#   BACKUP_MODE            — compose | local (default compose)
#   BACKUP_DIR             — output directory (default ./backups)
#   BACKUP_RETENTION_DAYS  — prune older files than this (default 30)
#   COMPOSE_FILE           — compose file path (default docker-compose.prod.yml)
#   COMPOSE_PROJECT_NAME   — compose project (default: directory name)
#   PG_URL                 — local mode: full connection URL (overrides PG* vars)
#   DUPLICATI_TARGET       — optional offsite hook (left as a TODO)
set -euo pipefail

MODE="${BACKUP_MODE:-compose}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
STAMP=$(date -u +%Y-%m-%dT%H-%M-%SZ)
OUT="${BACKUP_DIR}/vibe-${STAMP}.sql.gz"

mkdir -p "${BACKUP_DIR}"

echo "Backing up DB (${MODE} mode) to ${OUT}…"
if [[ "${MODE}" == "local" ]]; then
  if [[ -n "${PG_URL:-}" ]]; then
    pg_dump "${PG_URL}" | gzip > "${OUT}"
  else
    pg_dump | gzip > "${OUT}"
  fi
else
  docker compose -f "${COMPOSE_FILE}" exec -T postgres pg_dump -U vibe vibe_tax | gzip > "${OUT}"
fi

# Prune old
find "${BACKUP_DIR}" -type f -name 'vibe-*.sql.gz' -mtime "+${RETENTION_DAYS}" -delete || true

# Optional: push to Duplicati target if configured.
if [[ -n "${DUPLICATI_TARGET:-}" ]]; then
  echo "Forwarding to ${DUPLICATI_TARGET}…"
  # TODO: invoke duplicati CLI; left as a host-side hook.
fi

echo "Done."
