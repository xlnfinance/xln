#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$REPO_ROOT"
source "$REPO_ROOT/scripts/lib/start-common.sh"
source "$REPO_ROOT/scripts/lib/port-layout.sh"

MAIN_RPC_PORT="${ANVIL_PORT:-$(xln_rpc_port)}"
MAIN_API_PORT="${XLN_SERVER_PORT:-$(xln_web_port)}"
DEFAULT_CUSTODY_DAEMON_PORT="$(xln_custody_daemon_port)"
DEFAULT_CUSTODY_PORT="$(xln_custody_port)"

export PATH="${HOME}/.bun/bin:$PATH"
export USE_ANVIL=true
export CUSTODY_MAIN_API_BASE_URL=${CUSTODY_MAIN_API_BASE_URL:-http://127.0.0.1:${MAIN_API_PORT}}
export CUSTODY_MAIN_RPC_URL=${CUSTODY_MAIN_RPC_URL:-http://127.0.0.1:${MAIN_RPC_PORT}}
export CUSTODY_PUBLIC_RPC_URL=${CUSTODY_PUBLIC_RPC_URL:-https://xln.finance/rpc}
export CUSTODY_RELAY_URL=${CUSTODY_RELAY_URL:-ws://127.0.0.1:${MAIN_API_PORT}/relay}
export CUSTODY_WALLET_URL=${CUSTODY_WALLET_URL:-https://xln.finance/app}
export CUSTODY_JURISDICTION_ID=${CUSTODY_JURISDICTION_ID:-arrakis}
export CUSTODY_DAEMON_RUNTIME_SEED=${CUSTODY_DAEMON_RUNTIME_SEED:-xln-prod-custody-runtime}
export CUSTODY_DAEMON_PORT=${CUSTODY_DAEMON_PORT:-$DEFAULT_CUSTODY_DAEMON_PORT}
export CUSTODY_PORT=${CUSTODY_PORT:-$DEFAULT_CUSTODY_PORT}
export CUSTODY_DB_ROOT=${CUSTODY_DB_ROOT:-$REPO_ROOT/db/custody/prod}
export XLN_USE_PREDEPLOYED_ADDRESSES=${XLN_USE_PREDEPLOYED_ADDRESSES:-true}
export XLN_JURISDICTIONS_PATH=${XLN_JURISDICTIONS_PATH:-$REPO_ROOT/db/runtime/prod-main/jurisdictions.json}

mkdir -p "$CUSTODY_DB_ROOT"
xln_ensure_jurisdictions_path "$XLN_JURISDICTIONS_PATH"

xln_kill_by_port "$CUSTODY_PORT" start-custody
xln_kill_by_port "$CUSTODY_DAEMON_PORT" start-custody
xln_kill_by_pattern "runtime/server.ts --port ${CUSTODY_DAEMON_PORT} --host 127.0.0.1 --server-id custody-daemon-${CUSTODY_DAEMON_PORT}" start-custody

exec "${HOME}/.bun/bin/bun" runtime/scripts/start-custody-prod.ts
