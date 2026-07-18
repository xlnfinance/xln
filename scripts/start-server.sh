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
RDB_ROOT="${XLN_RDB_ROOT:-$REPO_ROOT/db}"

export USE_ANVIL=true
export ANVIL_RPC="http://127.0.0.1:${RPC_PORT}"
export ANVIL_RPC2="${ANVIL_RPC2:-http://127.0.0.1:${RPC2_PORT}}"
export RPC_TRON="${RPC_TRON:-$ANVIL_RPC2}"
export PUBLIC_RPC=${PUBLIC_RPC:-https://xln.finance/rpc}
export INTERNAL_RELAY_URL=${INTERNAL_RELAY_URL:-ws://127.0.0.1:${API_PORT}/relay}
export PUBLIC_RELAY_URL=${PUBLIC_RELAY_URL:-wss://xln.finance/relay}
export PUBLIC_WS_BASE_URL=${PUBLIC_WS_BASE_URL:-wss://xln.finance}
export RELAY_URL=${RELAY_URL:-$INTERNAL_RELAY_URL}
XLN_RUNTIME_SEED_FILE=${XLN_RUNTIME_SEED_FILE:-$RDB_ROOT/secrets/main-runtime.seed}
export XLN_RUNTIME_SEED=${XLN_RUNTIME_SEED:-$(xln_read_or_create_operator_seed "$XLN_RUNTIME_SEED_FILE")}
XLN_MESH_ROOT_SEED_FILE=${XLN_MESH_ROOT_SEED_FILE:-$RDB_ROOT/secrets/mesh-root.seed}
export XLN_MESH_ROOT_SEED=${XLN_MESH_ROOT_SEED:-$(xln_read_or_create_operator_seed "$XLN_MESH_ROOT_SEED_FILE")}
export XLN_DB_PATH=${XLN_DB_PATH:-$RDB_ROOT/runtime/prod-main}
export XLN_USE_PREDEPLOYED_ADDRESSES=${XLN_USE_PREDEPLOYED_ADDRESSES:-true}
export XLN_JURISDICTIONS_PATH=${XLN_JURISDICTIONS_PATH:-$XLN_DB_PATH/jurisdictions.json}
export XLN_MESH_DB_ROOT=${XLN_MESH_DB_ROOT:-$RDB_ROOT/runtime/prod-mesh}
export XLN_MESH_API_PORT_BASE=${XLN_MESH_API_PORT_BASE:-18090}
export XLN_MESH_PUBLIC_PORT_BASE=${XLN_MESH_PUBLIC_PORT_BASE:-8090}
export XLN_MESH_CUSTODY_PORT=${XLN_MESH_CUSTODY_PORT:-$(xln_custody_port)}
export XLN_MESH_CUSTODY_DAEMON_PORT=${XLN_MESH_CUSTODY_DAEMON_PORT:-$(xln_custody_daemon_port)}
# Public radapter URL for the custody daemon (nginx custody.xln.finance/rpc -> 127.0.0.1:8088),
# so custody shows up + connects in the wallet's "Connect to live runtime" dropdown.
export XLN_CUSTODY_PUBLIC_RPC_URL=${XLN_CUSTODY_PUBLIC_RPC_URL:-wss://custody.xln.finance/rpc}
export XLN_RUNTIME_EXIT_ON_FATAL=${XLN_RUNTIME_EXIT_ON_FATAL:-1}
export XLN_STORAGE_WRITE_TIMEOUT_MS=${XLN_STORAGE_WRITE_TIMEOUT_MS:-60000}
export XLN_RUNTIME_TICK_DELAY_MS=${XLN_RUNTIME_TICK_DELAY_MS:-1}
export XLN_MAX_ENTITY_INPUTS_PER_RUNTIME_FRAME=${XLN_MAX_ENTITY_INPUTS_PER_RUNTIME_FRAME:-8}
export XLN_MAX_ENTITY_TXS_PER_RUNTIME_FRAME=${XLN_MAX_ENTITY_TXS_PER_RUNTIME_FRAME:-64}
export XLN_ORCHESTRATOR_STARTUP_TIMEOUT_MS=${XLN_ORCHESTRATOR_STARTUP_TIMEOUT_MS:-600000}
export XLN_HUB_BASELINE_TIMEOUT_MS=${XLN_HUB_BASELINE_TIMEOUT_MS:-600000}
export XLN_HUB_BOOTSTRAP_PAUSE_STORAGE=${XLN_HUB_BOOTSTRAP_PAUSE_STORAGE:-1}
export XLN_HUB_READY_SNAPSHOT_TIMEOUT_MS=${XLN_HUB_READY_SNAPSHOT_TIMEOUT_MS:-60000}
export XLN_MESH_BOOTSTRAP_STALL_TIMEOUT_MS=${XLN_MESH_BOOTSTRAP_STALL_TIMEOUT_MS:-120000}
export XLN_MARKET_MAKER_PERSIST_READY_SNAPSHOT=${XLN_MARKET_MAKER_PERSIST_READY_SNAPSHOT:-1}
export MARKET_MAKER_MAX_ENTITY_INPUTS_PER_RUNTIME_FRAME=${MARKET_MAKER_MAX_ENTITY_INPUTS_PER_RUNTIME_FRAME:-8}
export MARKET_MAKER_MAX_ENTITY_TXS_PER_RUNTIME_FRAME=${MARKET_MAKER_MAX_ENTITY_TXS_PER_RUNTIME_FRAME:-64}
export XLN_RUNTIME_PROCESS_SLOW_MS=${XLN_RUNTIME_PROCESS_SLOW_MS:-250}
export XLN_ENTITY_FRAME_SLOW_MS=${XLN_ENTITY_FRAME_SLOW_MS:-250}
export MARKET_MAKER_MAX_LEVELS_PER_PAIR=${MARKET_MAKER_MAX_LEVELS_PER_PAIR:-10}
export MARKET_MAKER_CROSS_LEVELS_PER_PAIR=${MARKET_MAKER_CROSS_LEVELS_PER_PAIR:-3}
export MARKET_MAKER_CROSS_MAX_TOKEN_PAIRS_PER_ROUTE=${MARKET_MAKER_CROSS_MAX_TOKEN_PAIRS_PER_ROUTE:-1000}
export MARKET_MAKER_BOOTSTRAP_CROSS_SOURCE_HUB_GROUPS_PER_WAVE=${MARKET_MAKER_BOOTSTRAP_CROSS_SOURCE_HUB_GROUPS_PER_WAVE:-3}
export MARKET_MAKER_BOOTSTRAP_CROSS_OFFERS_PER_ACCOUNT_PER_TICK=${MARKET_MAKER_BOOTSTRAP_CROSS_OFFERS_PER_ACCOUNT_PER_TICK:-45}
export MARKET_MAKER_BOOTSTRAP_MAX_NEW_CROSS_OFFERS_PER_TICK=${MARKET_MAKER_BOOTSTRAP_MAX_NEW_CROSS_OFFERS_PER_TICK:-45}
export ANVIL_TMPDIR=${ANVIL_TMPDIR:-${XLN_JDB_ROOT:-$REPO_ROOT/data}/tmp}
export PATH="${HOME}/.bun/bin:$PATH"
export XLN_MIN_DISK_FREE_BYTES=${XLN_MIN_DISK_FREE_BYTES:-$((5 * 1024 * 1024 * 1024))}

# QA evidence root: persistent on prod (outside the /root/xln checkout that deploy.sh
# hard-resets + git-cleans on every deploy), and the local .logs dir for dev. Detected
# by checkout path so the same script works on the Mac and on the server. Run artifacts
# + the history DB are uploaded here by scripts/deploy-qa-evidence.sh (bun run deploy:qa),
# decoupled from the code deploy.
if [ -z "${QA_EVIDENCE_ROOT:-}" ]; then
  if [ "$REPO_ROOT" = "/root/xln" ]; then
    QA_EVIDENCE_ROOT="/root/xln-qa-evidence"
  else
    QA_EVIDENCE_ROOT="$REPO_ROOT/.logs"
  fi
fi
export QA_EVIDENCE_ROOT
mkdir -p "$QA_EVIDENCE_ROOT/e2e-parallel"

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
xln_kill_by_pattern "runtime/server/index.ts --port ${XLN_MESH_CUSTODY_DAEMON_PORT} --host 127.0.0.1 --server-id custody-daemon-${XLN_MESH_CUSTODY_DAEMON_PORT}" start-server
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
