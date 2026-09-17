#!/usr/bin/env bash

set -Eeuo pipefail

project_dir=${1:-$PWD}
env_file=${2:-$HOME/apps/reviewflow/shared/reviewflow.env}
port=${REVIEWFLOW_SMOKE_PORT:-3101}

if [[ ! -r "$env_file" ]]; then
  echo "Environment file is not readable: $env_file" >&2
  exit 2
fi

set -a
source "$env_file"
set +a
: "${DATABASE_URL:?DATABASE_URL is required}"
: "${SESSION_SECRET:?SESSION_SECRET is required}"

temporary_dir=$(mktemp -d)
server_pid=
cleanup() {
  if [[ -n "$server_pid" ]]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  rm -rf "$temporary_dir"
}
trap cleanup EXIT

cd "$project_dir"
NODE_ENV=production \
HOST=127.0.0.1 \
PORT="$port" \
COOKIE_SECURE=false \
COOKIE_PATH=/ \
node dist-server/server/index.js >"$temporary_dir/server.log" 2>&1 &
server_pid=$!

health=$(curl --fail --silent --show-error \
  --retry 20 \
  --retry-connrefused \
  --retry-delay 1 \
  --max-time 20 \
  "http://127.0.0.1:$port/api/health" 2>/dev/null || true)
if [[ "$health" != *'"database":"postgresql"'* ]]; then
  cat "$temporary_dir/server.log" >&2
  echo 'PostgreSQL smoke health check failed' >&2
  exit 1
fi

switch_user() {
  local user_id=$1
  local status_code
  status_code=$(curl --silent --show-error \
    --cookie "$temporary_dir/cookies" \
    --cookie-jar "$temporary_dir/cookies" \
    --output "$temporary_dir/response.json" \
    --write-out '%{http_code}' \
    --header 'Content-Type: application/json' \
    --request POST \
    --data "{\"userId\":\"$user_id\"}" \
    "http://127.0.0.1:$port/api/session/switch")
  [[ "$status_code" == 200 ]]
}

json_length() {
  node -e '
    const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    process.stdout.write(String(Array.isArray(value) ? value.length : value.items.length));
  ' "$1"
}

switch_user user-alice
curl --fail --silent --show-error \
  --cookie "$temporary_dir/cookies" \
  --output "$temporary_dir/alice.json" \
  "http://127.0.0.1:$port/api/contents?scope=mine"
alice_count=$(json_length "$temporary_dir/alice.json")
[[ "$alice_count" -ge 56 ]]

switch_user user-bob
curl --fail --silent --show-error \
  --cookie "$temporary_dir/cookies" \
  --output "$temporary_dir/bob.json" \
  "http://127.0.0.1:$port/api/reviews/pending"
bob_pending=$(json_length "$temporary_dir/bob.json")
[[ "$bob_pending" -ge 15 ]]

switch_user user-diana
curl --fail --silent --show-error \
  --cookie "$temporary_dir/cookies" \
  --output "$temporary_dir/diana.json" \
  "http://127.0.0.1:$port/api/admin/users"
admin_users=$(json_length "$temporary_dir/diana.json")
[[ "$admin_users" -ge 4 ]]

switch_user user-alice
idempotency_key="postgres-smoke-$(date -u +%Y%m%d%H%M%S)-$RANDOM"
title="PostgreSQL smoke $(date -u +%Y-%m-%dT%H:%M:%SZ)"
status_code=$(curl --silent --show-error \
  --cookie "$temporary_dir/cookies" \
  --output "$temporary_dir/created.json" \
  --write-out '%{http_code}' \
  --header 'Content-Type: application/json' \
  --header "Idempotency-Key: $idempotency_key" \
  --request POST \
  --data "{\"title\":\"$title\",\"body\":\"Temporary PostgreSQL smoke record\",\"risk\":\"LOW\"}" \
  "http://127.0.0.1:$port/api/contents")
[[ "$status_code" == 201 ]]
content_id=$(node -e '
  const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  process.stdout.write(value.content.id);
' "$temporary_dir/created.json")

curl --fail --silent --show-error \
  --cookie "$temporary_dir/cookies" \
  "http://127.0.0.1:$port/api/contents/$content_id" >/dev/null

psql "$DATABASE_URL" \
  --set ON_ERROR_STOP=1 \
  --set content_id="$content_id" \
  --set idempotency_key="$idempotency_key" \
  >"$temporary_dir/cleanup.log" <<'SQL'
BEGIN;
DELETE FROM idempotency_requests
WHERE actor_id = 'user-alice'
  AND operation = 'CREATE_CONTENT'
  AND idempotency_key = :'idempotency_key';
DELETE FROM contents WHERE id = :'content_id';
UPDATE capacity_counters counters
SET used = source.used
FROM (
  SELECT 'users'::text AS resource, count(*)::bigint AS used FROM users
  UNION ALL SELECT 'contents', count(*)::bigint FROM contents
  UNION ALL SELECT 'idempotency', count(*)::bigint FROM idempotency_requests
) source
WHERE counters.resource = source.resource;
COMMIT;
SQL

remaining=$(psql "$DATABASE_URL" --tuples-only --no-align \
  --set content_id="$content_id" <<'SQL'
SELECT count(*) FROM contents WHERE id = :'content_id';
SQL
)
[[ "$remaining" == 0 ]]

echo "PostgreSQL smoke passed: Alice=$alice_count BobPending=$bob_pending AdminUsers=$admin_users"