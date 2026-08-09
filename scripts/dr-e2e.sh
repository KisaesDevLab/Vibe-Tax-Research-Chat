#!/usr/bin/env bash
# DR v2 — end-to-end restore drill against a DISPOSABLE compose stack.
#
#   bootstrap admin → marker chat → create backup → copy archive out →
#   destroy all volumes → fresh boot → first-run restore → sign in with the
#   PRE-WIPE credentials → marker present.
#
# A backup nobody has restored is a hope, not a plan; run this after any
# upgrade touching the schema or storage. Uses its own compose project name
# and named volumes — it never touches a real install.
#
# Requirements: docker compose, curl, jq. Runs the prod images defined by
# API_IMAGE/WEB_IMAGE (defaults to the locally built compose file).
set -euo pipefail

PROJECT=vibe-dr-drill
PORT="${DR_PORT:-8098}"
BASE="http://localhost:${PORT}"
WORK="$(mktemp -d)"
# Override the prod compose's fixed :80 publish so the drill never collides
# with a real install on the same host. `!override` replaces, not appends.
cat >"$WORK/override.yml" <<EOF
services:
  web:
    ports: !override
      - "${PORT}:80"
EOF
COMPOSE=(docker compose -p "$PROJECT" -f docker-compose.prod.yml -f "$WORK/override.yml")
ADMIN_EMAIL="drill@example.test"
ADMIN_PASS="drill-password-1"
PASSPHRASE="drill-passphrase-123"

cleanup() {
  "${COMPOSE[@]}" down -v >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

say() { printf '\n== %s\n' "$*"; }

wait_health() {
  for _ in $(seq 1 60); do
    if curl -fsS "$BASE/api/health" >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  echo "api never became healthy" >&2
  exit 1
}

say "fresh stack up (project: $PROJECT, port: $PORT)"
export DR_PORT="$PORT"
"${COMPOSE[@]}" down -v >/dev/null 2>&1 || true
"${COMPOSE[@]}" up -d
wait_health

say "bootstrap admin + marker data"
TOKEN="$(curl -fsS -X POST "$BASE/api/setup/bootstrap" \
  -H 'content-type: application/json' \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASS\"}" | jq -r .access_token)"
[[ -n "$TOKEN" && "$TOKEN" != "null" ]]
CHAT_ID="$(curl -fsS -X POST "$BASE/api/chats" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"title":"dr-drill-marker"}' | jq -r '.chat.id // .id')"
echo "marker chat: $CHAT_ID"

say "create backup"
curl -fsS -X POST "$BASE/api/admin/backup" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"passphrase\":\"$PASSPHRASE\"}" >/dev/null
deadline=$((SECONDS + 600))
ARCHIVE=""
while ((SECONDS < deadline)); do
  J="$(curl -fsS "$BASE/api/admin/backup/jobs/current" -H "authorization: Bearer $TOKEN")"
  S="$(jq -r .status <<<"$J")"
  if [[ "$S" == "succeeded" ]]; then ARCHIVE="$(jq -r .file.name <<<"$J")"; break; fi
  if [[ "$S" == "failed" ]]; then echo "$J" | jq . >&2; exit 1; fi
  sleep 2
done
[[ -n "$ARCHIVE" ]]
echo "archive: $ARCHIVE"

say "download archive off the stack"
curl -fsS "$BASE/api/admin/backup/archives/$ARCHIVE/download" \
  -H "authorization: Bearer $TOKEN" -o "$WORK/drill.vtbk"
ls -l "$WORK/drill.vtbk"

say "destroy the install (down -v)"
"${COMPOSE[@]}" down -v
"${COMPOSE[@]}" up -d
wait_health
[[ "$(curl -fsS "$BASE/api/setup/status" | jq -r .admin_exists)" == "false" ]]

say "first-run restore"
curl -fsS -X POST "$BASE/api/setup/restore" \
  -F "file=@$WORK/drill.vtbk" -F "passphrase=$PASSPHRASE" >/dev/null
deadline=$((SECONDS + 900))
while ((SECONDS < deadline)); do
  J="$(curl -fsS "$BASE/api/setup/restore/status")"
  S="$(jq -r .status <<<"$J")"
  P="$(jq -r .phase <<<"$J")"
  echo "  $S/$P"
  if [[ "$S" == "succeeded" ]]; then break; fi
  if [[ "$S" == "failed" || "$S" == "interrupted" ]]; then echo "$J" | jq . >&2; exit 1; fi
  sleep 3
done

say "restart api (fresh pools/settings) and sign in with PRE-WIPE credentials"
"${COMPOSE[@]}" restart api >/dev/null
wait_health
TOKEN2="$(curl -fsS -X POST "$BASE/api/auth/login" \
  -H 'content-type: application/json' \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASS\"}" | jq -r .access_token)"
[[ -n "$TOKEN2" && "$TOKEN2" != "null" ]]

say "marker data survived"
curl -fsS "$BASE/api/chats" -H "authorization: Bearer $TOKEN2" | jq -e \
  '..|strings|select(. == "dr-drill-marker")' >/dev/null

say "DR DRILL PASSED — backup → wipe → restore → original login works"
