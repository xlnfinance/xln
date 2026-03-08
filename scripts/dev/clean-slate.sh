#!/bin/bash
set -euo pipefail

echo "🧹 XLN clean-slate: stopping stale processes and wiping local state..."

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT_DIR"

kill_by_port() {
  local port="$1"
  local pids
  pids="$(lsof -ti TCP:${port} -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    echo "🔪 Killing listeners on :${port} -> ${pids}"
    echo "$pids" | xargs kill -9 2>/dev/null || true
  fi
}

echo "🛑 Killing known XLN/anvil/dev processes..."
pkill -9 -f "anvil" 2>/dev/null || true
pkill -9 -f "bun runtime/server.ts" 2>/dev/null || true
pkill -9 -f "bun runtime/scripts/start-custody-dev.ts" 2>/dev/null || true
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

echo "🧽 Removing lock files and local runtime state..."
find db-tmp -name LOCK -type f -delete 2>/dev/null || true
rm -rf db-tmp 2>/dev/null || true
rm -rf db 2>/dev/null || true
rm -rf db-relay 2>/dev/null || true
rm -rf pids/*.pid 2>/dev/null || true
rm -rf logs/*.log 2>/dev/null || true

mkdir -p db-tmp/runtime logs pids

echo "✅ Clean slate ready"
