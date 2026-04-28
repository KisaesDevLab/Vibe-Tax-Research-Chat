#!/usr/bin/env bash
# Phase 27 — nightly pg_dump. Run from cron on the host or via docker exec.
# Outputs a gzipped tarball into BACKUP_DIR (default ./backups).
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
STAMP=$(date -u +%Y-%m-%dT%H-%M-%SZ)
OUT="${BACKUP_DIR}/vibe-${STAMP}.sql.gz"

mkdir -p "${BACKUP_DIR}"

echo "Backing up DB to ${OUT}…"
docker compose -f docker-compose.prod.yml exec -T postgres pg_dump -U vibe vibe_tax | gzip > "${OUT}"

# Prune old
find "${BACKUP_DIR}" -type f -name 'vibe-*.sql.gz' -mtime "+${RETENTION_DAYS}" -delete || true

# Optional: push to Duplicati target if configured.
if [[ -n "${DUPLICATI_TARGET:-}" ]]; then
  echo "Forwarding to ${DUPLICATI_TARGET}…"
  # TODO: invoke duplicati CLI; left as a host-side hook.
fi

echo "Done."
