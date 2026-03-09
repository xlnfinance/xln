#!/bin/bash
# XLN Server Startup Script for pm2
# This wraps the bun server with proper environment setup

cd /root/xln

kill_by_port() {
  local port="$1"
  local pids
  pids="$(lsof -ti TCP:${port} -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    echo "[start-server] killing stale listeners on :${port} -> ${pids}"
    echo "$pids" | xargs kill -9 2>/dev/null || true
  fi
}

export USE_ANVIL=true
export ANVIL_RPC=http://localhost:8545
export PUBLIC_RPC=${PUBLIC_RPC:-https://xln.finance/rpc}
export PUBLIC_RELAY_URL=${PUBLIC_RELAY_URL:-wss://xln.finance/relay}
export RELAY_URL=${RELAY_URL:-$PUBLIC_RELAY_URL}
export XLN_RUNTIME_SEED=${XLN_RUNTIME_SEED:-xln-prod-main-runtime}
export XLN_USE_PREDEPLOYED_ADDRESSES=${XLN_USE_PREDEPLOYED_ADDRESSES:-true}
export XLN_JURISDICTIONS_PATH=${XLN_JURISDICTIONS_PATH:-/root/xln/jurisdictions/jurisdictions.json}
# Prod must come up fully bootstrapped or fail fast.
export BOOTSTRAP_LOCAL_HUBS=${BOOTSTRAP_LOCAL_HUBS:-1}
export PATH="/root/.bun/bin:$PATH"

./scripts/sync-contract-artifacts.sh

kill_by_port 8080

exec /root/.bun/bin/bun runtime/server.ts --port 8080
