#!/bin/bash
set -euo pipefail

cd /root/xln
source /root/xln/scripts/lib/start-common.sh

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
export XLN_JURISDICTIONS_PATH=${XLN_JURISDICTIONS_PATH:-/root/xln/db/runtime/prod-main/jurisdictions.json}

mkdir -p "$CUSTODY_DB_ROOT"
xln_ensure_jurisdictions_path "$XLN_JURISDICTIONS_PATH"

xln_kill_by_port "$CUSTODY_PORT" start-custody
xln_kill_by_port "$CUSTODY_DAEMON_PORT" start-custody
xln_kill_by_pattern "runtime/server.ts --port ${CUSTODY_DAEMON_PORT} --host 127.0.0.1 --server-id custody-daemon-${CUSTODY_DAEMON_PORT}" start-custody

exec /root/.bun/bin/bun runtime/scripts/start-custody-prod.ts
