#!/bin/bash
set -euo pipefail

cd /root/xln

kill_by_port() {
  local port="$1"
  local pids
  pids="$(lsof -ti TCP:${port} -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    echo "[start-custody] killing stale listeners on :${port} -> ${pids}"
    echo "$pids" | xargs kill -9 2>/dev/null || true
  fi
}

kill_by_pattern() {
  local pattern="$1"
  local pids
  pids="$(pgrep -f -- "$pattern" 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    echo "[start-custody] killing stale process pattern '$pattern' -> ${pids}"
    echo "$pids" | xargs kill -TERM 2>/dev/null || true
    sleep 1
    pids="$(pgrep -f -- "$pattern" 2>/dev/null || true)"
    if [ -n "$pids" ]; then
      echo "$pids" | xargs kill -KILL 2>/dev/null || true
    fi
  fi
}

export PATH="/root/.bun/bin:$PATH"
export USE_ANVIL=true
export CUSTODY_MAIN_API_BASE_URL=${CUSTODY_MAIN_API_BASE_URL:-http://127.0.0.1:8080}
export CUSTODY_MAIN_RPC_URL=${CUSTODY_MAIN_RPC_URL:-http://127.0.0.1:8545}
export CUSTODY_PUBLIC_RPC_URL=${CUSTODY_PUBLIC_RPC_URL:-https://xln.finance/rpc}
export CUSTODY_RELAY_URL=${CUSTODY_RELAY_URL:-wss://xln.finance/relay}
export CUSTODY_WALLET_URL=${CUSTODY_WALLET_URL:-https://xln.finance/app}
export CUSTODY_DAEMON_RUNTIME_SEED=${CUSTODY_DAEMON_RUNTIME_SEED:-xln-prod-custody-runtime}
export CUSTODY_DAEMON_PORT=${CUSTODY_DAEMON_PORT:-8088}
export CUSTODY_PORT=${CUSTODY_PORT:-8087}
export CUSTODY_DB_ROOT=${CUSTODY_DB_ROOT:-/root/xln/db/custody/prod}
export XLN_USE_PREDEPLOYED_ADDRESSES=${XLN_USE_PREDEPLOYED_ADDRESSES:-true}
export XLN_JURISDICTIONS_PATH=${XLN_JURISDICTIONS_PATH:-$CUSTODY_DB_ROOT/jurisdictions.json}

mkdir -p "$CUSTODY_DB_ROOT"
if [ ! -f "$XLN_JURISDICTIONS_PATH" ]; then
  cp /root/xln/jurisdictions/jurisdictions.json "$XLN_JURISDICTIONS_PATH"
fi

kill_by_port "$CUSTODY_PORT"
kill_by_port "$CUSTODY_DAEMON_PORT"
kill_by_pattern "runtime/server.ts --port ${CUSTODY_DAEMON_PORT} --host 127.0.0.1 --server-id custody-daemon-${CUSTODY_DAEMON_PORT}"

exec /root/.bun/bin/bun runtime/scripts/start-custody-prod.ts
