#!/usr/bin/env bash
# Sobe a API com banco temporário, roda o k6 (Docker) e verifica as invariantes.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-3103}"
SECRET="segredo-de-carga"
TMP="$(mktemp -d)"
DB_PATH="$TMP/load.sqlite"
export NODE_OPTIONS='--disable-warning=ExperimentalWarning'

cd "$ROOT"
PORT="$PORT" DB_PATH="$DB_PATH" WEBHOOK_SECRET="$SECRET" npx tsx src/index.ts > "$TMP/server.log" 2>&1 &
SERVER_PID=$!
cleanup() { kill "$SERVER_PID" 2>/dev/null || true; wait "$SERVER_PID" 2>/dev/null || true; rm -rf "$TMP"; }
trap cleanup EXIT

for _ in $(seq 1 50); do
  curl -fsS "http://127.0.0.1:$PORT/health" > /dev/null 2>&1 && break
  sleep 0.2
done
curl -fsS "http://127.0.0.1:$PORT/health" > /dev/null || { echo "API não subiu"; cat "$TMP/server.log"; exit 1; }

K6_STATUS=0
docker run --rm -i \
  --add-host=host.docker.internal:host-gateway \
  -e BASE_URL="http://host.docker.internal:$PORT" \
  -e WEBHOOK_SECRET="$SECRET" \
  -v "$ROOT/load:/load:ro" \
  grafana/k6:0.54.0 run /load/webhooks.js || K6_STATUS=$?

BASE_URL="http://127.0.0.1:$PORT" DB_PATH="$DB_PATH" npx tsx scripts/verify-load.ts
exit "$K6_STATUS"
