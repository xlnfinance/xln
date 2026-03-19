#!/bin/bash
set -euo pipefail

echo "🧹 XLN clean-slate: stopping stale processes and wiping local state..."

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT_DIR"
CANONICAL_J_PATH="$ROOT_DIR/jurisdictions/jurisdictions.json"
DEV_J_PATH="$ROOT_DIR/db/dev/jurisdictions.json"

kill_by_port() {
  local port="$1"
  local pids
  pids="$(lsof -ti TCP:${port} -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    echo "🔪 Killing listeners on :${port} -> ${pids}"
    echo "$pids" | xargs kill -9 2>/dev/null || true
  fi
}

wait_for_port_clear() {
  local port="$1"
  local attempts=50
  local pids=""
  while [ "$attempts" -gt 0 ]; do
    pids="$(lsof -ti TCP:${port} -sTCP:LISTEN 2>/dev/null || true)"
    if [ -z "$pids" ]; then
      return 0
    fi
    sleep 0.1
    attempts=$((attempts - 1))
  done
  echo "❌ Port :${port} is still busy after cleanup -> ${pids}" >&2
  return 1
}

echo "🛑 Killing known XLN/anvil/dev processes..."
pm2 delete anvil xln-server xln-custody 2>/dev/null || true
pm2 stop anvil xln-server xln-custody 2>/dev/null || true
pkill -9 -f "anvil" 2>/dev/null || true
pkill -9 -f "bash .*scripts/start-anvil.sh" 2>/dev/null || true
pkill -9 -f "scripts/start-anvil.sh" 2>/dev/null || true
pkill -9 -f "bun runtime/server.ts" 2>/dev/null || true
pkill -9 -f "bun runtime/scripts/start-custody-dev.ts" 2>/dev/null || true
pkill -9 -f "bun runtime/scripts/start-custody-prod.ts" 2>/dev/null || true
pkill -9 -f "bun custody/server.ts" 2>/dev/null || true
pkill -9 -f "bun build runtime/runtime.ts" 2>/dev/null || true
pkill -9 -f "vite dev" 2>/dev/null || true
pkill -9 -f "node .*vite" 2>/dev/null || true
pkill -9 -f "concurrently --names ANVIL,API,CUSTODY,RUNTIME,VITE" 2>/dev/null || true

kill_by_port 8545
kill_by_port 8080
kill_by_port 8082
kill_by_port 8087
kill_by_port 8088
kill_by_port 8090
kill_by_port 9000
kill_by_port 5173
kill_by_port 8787

wait_for_port_clear 8545
wait_for_port_clear 8080
wait_for_port_clear 8082
wait_for_port_clear 8087
wait_for_port_clear 8088

echo "🧽 Removing lock files and local runtime state..."
find db-tmp -name LOCK -type f -delete 2>/dev/null || true
rm -rf db-tmp 2>/dev/null || true
rm -rf db 2>/dev/null || true
rm -rf db-relay 2>/dev/null || true
rm -rf pids/*.pid 2>/dev/null || true
rm -rf logs/*.log 2>/dev/null || true

mkdir -p db-tmp/runtime db/dev logs pids
cp "$CANONICAL_J_PATH" "$DEV_J_PATH"

echo "✅ Clean slate ready"
