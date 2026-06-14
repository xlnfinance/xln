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
RPC2_PORT="${ANVIL2_PORT:-$(xln_rpc2_port)}"
API_PORT="${XLN_SERVER_PORT:-$(xln_web_port)}"

export USE_ANVIL=true
export ANVIL_RPC="http://127.0.0.1:${RPC_PORT}"
export ANVIL_RPC2="${ANVIL_RPC2:-http://127.0.0.1:${RPC2_PORT}}"
export RPC_TRON="${RPC_TRON:-$ANVIL_RPC2}"
export PUBLIC_RPC=${PUBLIC_RPC:-https://xln.finance/rpc}
export INTERNAL_RELAY_URL=${INTERNAL_RELAY_URL:-ws://127.0.0.1:${API_PORT}/relay}
export PUBLIC_RELAY_URL=${PUBLIC_RELAY_URL:-wss://xln.finance/relay}
export PUBLIC_WS_BASE_URL=${PUBLIC_WS_BASE_URL:-wss://xln.finance}
export RELAY_URL=${RELAY_URL:-$INTERNAL_RELAY_URL}
export XLN_RUNTIME_SEED=${XLN_RUNTIME_SEED:-xln-prod-main-runtime}
export XLN_DB_PATH=${XLN_DB_PATH:-$REPO_ROOT/db/runtime/prod-main}
export XLN_USE_PREDEPLOYED_ADDRESSES=${XLN_USE_PREDEPLOYED_ADDRESSES:-true}
export XLN_JURISDICTIONS_PATH=${XLN_JURISDICTIONS_PATH:-$XLN_DB_PATH/jurisdictions.json}
export XLN_MESH_DB_ROOT=${XLN_MESH_DB_ROOT:-$REPO_ROOT/db/runtime/prod-mesh}
export XLN_MESH_API_PORT_BASE=${XLN_MESH_API_PORT_BASE:-18090}
export XLN_MESH_PUBLIC_PORT_BASE=${XLN_MESH_PUBLIC_PORT_BASE:-8090}
export XLN_MESH_CUSTODY_PORT=${XLN_MESH_CUSTODY_PORT:-$(xln_custody_port)}
export XLN_MESH_CUSTODY_DAEMON_PORT=${XLN_MESH_CUSTODY_DAEMON_PORT:-$(xln_custody_daemon_port)}
export XLN_RUNTIME_EXIT_ON_FATAL=${XLN_RUNTIME_EXIT_ON_FATAL:-1}
export XLN_STORAGE_WRITE_TIMEOUT_MS=${XLN_STORAGE_WRITE_TIMEOUT_MS:-15000}
export ANVIL_TMPDIR=${ANVIL_TMPDIR:-$REPO_ROOT/data/anvil-tmp}
export PATH="${HOME}/.bun/bin:$PATH"
export XLN_MIN_DISK_FREE_BYTES=${XLN_MIN_DISK_FREE_BYTES:-$((5 * 1024 * 1024 * 1024))}

mkdir -p "$XLN_DB_PATH"
mkdir -p "$XLN_MESH_DB_ROOT"
mkdir -p "$ANVIL_TMPDIR"
xln_ensure_jurisdictions_path "$XLN_JURISDICTIONS_PATH"

available_kb="$(df -Pk / | awk 'NR==2 { print $4 }')"
required_kb="$((XLN_MIN_DISK_FREE_BYTES / 1024))"
if [ "${available_kb:-0}" -lt "$required_kb" ]; then
  echo "[start-server] INSUFFICIENT_DISK_FREE available_kb=${available_kb:-0} required_kb=$required_kb" >&2
  exit 1
fi

xln_kill_by_pattern "scripts/start-custody.sh" start-server
xln_kill_by_pattern "runtime/scripts/start-custody-prod.ts" start-server
xln_kill_by_pattern "runtime/server.ts --port ${XLN_MESH_CUSTODY_DAEMON_PORT} --host 127.0.0.1 --server-id custody-daemon-${XLN_MESH_CUSTODY_DAEMON_PORT}" start-server
xln_kill_by_port "$XLN_MESH_CUSTODY_PORT" start-server
xln_kill_by_port "$XLN_MESH_CUSTODY_DAEMON_PORT" start-server
xln_kill_by_port "$API_PORT" start-server

exec "${HOME}/.bun/bin/bun" runtime/orchestrator/orchestrator.ts \
  --host 127.0.0.1 \
  --port "$API_PORT" \
  --public-ws-base-url "$PUBLIC_WS_BASE_URL" \
  --node-api-port-base "$XLN_MESH_API_PORT_BASE" \
  --node-public-port-base "$XLN_MESH_PUBLIC_PORT_BASE" \
  --relay-url "$RELAY_URL" \
  --rpc-url "$ANVIL_RPC" \
  --rpc2-url "$ANVIL_RPC2" \
  --db-root "$XLN_MESH_DB_ROOT" \
  --allow-reset \
  --mm \
  --custody \
  --custody-port "$XLN_MESH_CUSTODY_PORT" \
  --custody-daemon-port "$XLN_MESH_CUSTODY_DAEMON_PORT" \
  --wallet-url "https://xln.finance/app"
