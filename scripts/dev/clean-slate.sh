#!/bin/bash
set -euo pipefail

echo "🧹 XLN clean-slate: stopping stale processes and wiping local state..."

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT_DIR"
source "$ROOT_DIR/scripts/lib/port-layout.sh"
CANONICAL_J_PATH="$ROOT_DIR/jurisdictions/jurisdictions.json"
DEV_J_PATH="$ROOT_DIR/db/dev/jurisdictions.json"
RPC_PORT="$(xln_rpc_port)"
API_PORT="$(xln_api_port)"
WEB_PORT="$(xln_web_port)"
CUSTODY_PORT="$(xln_custody_port)"
CUSTODY_DAEMON_PORT="$(xln_custody_daemon_port)"

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
for pm2_app in anvil xln-server xln-custody; do
  pm2 delete "$pm2_app" 2>/dev/null || true
  pm2 stop "$pm2_app" 2>/dev/null || true
done
pkill -9 -f "anvil" 2>/dev/null || true
pkill -9 -f "bash .*scripts/start-anvil.sh" 2>/dev/null || true
pkill -9 -f "scripts/start-anvil.sh" 2>/dev/null || true
pkill -9 -f "bun runtime/orchestrator/orchestrator.ts" 2>/dev/null || true
pkill -9 -f "bun runtime/server.ts" 2>/dev/null || true
pkill -9 -f "bun runtime/scripts/start-custody-dev.ts" 2>/dev/null || true
pkill -9 -f "bun runtime/scripts/start-custody-prod.ts" 2>/dev/null || true
pkill -9 -f "bun runtime/orchestrator/hub-node.ts" 2>/dev/null || true
pkill -9 -f "bun runtime/orchestrator/mm-node.ts" 2>/dev/null || true
pkill -9 -f "bun custody/server.ts" 2>/dev/null || true
pkill -9 -f "bun build runtime/runtime.ts" 2>/dev/null || true
pkill -9 -f "vite dev" 2>/dev/null || true
pkill -9 -f "node .*vite" 2>/dev/null || true
pkill -9 -f "concurrently --names ANVIL,MESH,RUNTIME,VITE" 2>/dev/null || true

kill_by_port "$RPC_PORT"
kill_by_port "$WEB_PORT"
kill_by_port "$API_PORT"
kill_by_port "$CUSTODY_PORT"
kill_by_port "$CUSTODY_DAEMON_PORT"
kill_by_port 8090
kill_by_port 9000
kill_by_port 5173
kill_by_port 8787

wait_for_port_clear "$RPC_PORT"
wait_for_port_clear "$WEB_PORT"
wait_for_port_clear "$API_PORT"
wait_for_port_clear "$CUSTODY_PORT"
wait_for_port_clear "$CUSTODY_DAEMON_PORT"

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
