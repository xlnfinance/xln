#!/bin/bash
# XLN Server Startup Script for pm2
# This wraps the bun server with proper environment setup

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$REPO_ROOT"
source "$REPO_ROOT/scripts/lib/start-common.sh"

export USE_ANVIL=true
export ANVIL_RPC=http://localhost:8545
export PUBLIC_RPC=${PUBLIC_RPC:-https://xln.finance/rpc}
export PUBLIC_RELAY_URL=${PUBLIC_RELAY_URL:-wss://xln.finance/relay}
export RELAY_URL=${RELAY_URL:-$PUBLIC_RELAY_URL}
export XLN_RUNTIME_SEED=${XLN_RUNTIME_SEED:-xln-prod-main-runtime}
export XLN_DB_PATH=${XLN_DB_PATH:-$REPO_ROOT/db/runtime/prod-main}
export XLN_USE_PREDEPLOYED_ADDRESSES=${XLN_USE_PREDEPLOYED_ADDRESSES:-true}
export XLN_JURISDICTIONS_PATH=${XLN_JURISDICTIONS_PATH:-$XLN_DB_PATH/jurisdictions.json}
# Prod must come up fully bootstrapped or fail fast.
export BOOTSTRAP_LOCAL_HUBS=${BOOTSTRAP_LOCAL_HUBS:-1}
export PATH="${HOME}/.bun/bin:$PATH"

mkdir -p "$XLN_DB_PATH"
xln_ensure_jurisdictions_path "$XLN_JURISDICTIONS_PATH"

xln_kill_by_port 8080 start-server

exec "${HOME}/.bun/bin/bun" runtime/server.ts --port 8080
