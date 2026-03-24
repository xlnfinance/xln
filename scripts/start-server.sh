#!/bin/bash
# XLN Server Startup Script for pm2
# This wraps the bun server with proper environment setup

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$REPO_ROOT"
source "$REPO_ROOT/scripts/lib/start-common.sh"
source "$REPO_ROOT/scripts/lib/port-layout.sh"

RPC_PORT="${ANVIL_PORT:-$(xln_rpc_port)}"
API_PORT="${XLN_SERVER_PORT:-$(xln_web_port)}"

export USE_ANVIL=true
export ANVIL_RPC="http://localhost:${RPC_PORT}"
export PUBLIC_RPC=${PUBLIC_RPC:-https://xln.finance/rpc}
export INTERNAL_RELAY_URL=${INTERNAL_RELAY_URL:-ws://127.0.0.1:${API_PORT}/relay}
export PUBLIC_RELAY_URL=${PUBLIC_RELAY_URL:-wss://xln.finance/relay}
export RELAY_URL=${RELAY_URL:-$INTERNAL_RELAY_URL}
export XLN_RUNTIME_SEED=${XLN_RUNTIME_SEED:-xln-prod-main-runtime}
export XLN_DB_PATH=${XLN_DB_PATH:-$REPO_ROOT/db/runtime/prod-main}
export XLN_USE_PREDEPLOYED_ADDRESSES=${XLN_USE_PREDEPLOYED_ADDRESSES:-true}
export XLN_JURISDICTIONS_PATH=${XLN_JURISDICTIONS_PATH:-$XLN_DB_PATH/jurisdictions.json}
export XLN_MESH_DB_ROOT=${XLN_MESH_DB_ROOT:-$REPO_ROOT/db/runtime/prod-mesh}
export XLN_MESH_CUSTODY_PORT=${XLN_MESH_CUSTODY_PORT:-$(xln_custody_port)}
export XLN_MESH_CUSTODY_DAEMON_PORT=${XLN_MESH_CUSTODY_DAEMON_PORT:-$(xln_custody_daemon_port)}
export PATH="${HOME}/.bun/bin:$PATH"

mkdir -p "$XLN_DB_PATH"
mkdir -p "$XLN_MESH_DB_ROOT"
xln_ensure_jurisdictions_path "$XLN_JURISDICTIONS_PATH"

xln_kill_by_port "$API_PORT" start-server

exec "${HOME}/.bun/bin/bun" runtime/orchestrator/orchestrator.ts \
  --host 127.0.0.1 \
  --port "$API_PORT" \
  --rpc-url "$ANVIL_RPC" \
  --db-root "$XLN_MESH_DB_ROOT" \
  --mm \
  --custody \
  --custody-port "$XLN_MESH_CUSTODY_PORT" \
  --custody-daemon-port "$XLN_MESH_CUSTODY_DAEMON_PORT" \
  --wallet-url "https://xln.finance/app"
