#!/usr/bin/env bash
# Phase 27 — nightly pg_dump. Run from cron on the host.
# Outputs a gzipped SQL dump into BACKUP_DIR (default ./backups).
#
# Env knobs:
#   BACKUP_DIR             — output directory (default ./backups)
#   BACKUP_RETENTION_DAYS  — prune older files than this (default 30)
#   COMPOSE_FILE           — compose file path (default docker-compose.prod.yml)
#   COMPOSE_PROJECT_NAME   — compose project (default: directory name)
#   DUPLICATI_TARGET       — optional offsite hook (left as a TODO)
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
STAMP=$(date -u +%Y-%m-%dT%H-%M-%SZ)
OUT="${BACKUP_DIR}/vibe-${STAMP}.sql.gz"

mkdir -p "${BACKUP_DIR}"

echo "Backing up DB to ${OUT}…"
docker compose -f "${COMPOSE_FILE}" exec -T postgres pg_dump -U vibe vibe_tax | gzip > "${OUT}"

# Prune old
find "${BACKUP_DIR}" -type f -name 'vibe-*.sql.gz' -mtime "+${RETENTION_DAYS}" -delete || true

# Optional: push to Duplicati target if configured.
if [[ -n "${DUPLICATI_TARGET:-}" ]]; then
  echo "Forwarding to ${DUPLICATI_TARGET}…"
  # TODO: invoke duplicati CLI; left as a host-side hook.
fi

echo "Done."
