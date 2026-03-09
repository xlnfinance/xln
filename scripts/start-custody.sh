#!/bin/bash
set -euo pipefail

cd /root/xln

export PATH="/root/.bun/bin:$PATH"
export USE_ANVIL=true
export CUSTODY_MAIN_API_BASE_URL=${CUSTODY_MAIN_API_BASE_URL:-http://127.0.0.1:8080}
export CUSTODY_MAIN_RPC_URL=${CUSTODY_MAIN_RPC_URL:-http://127.0.0.1:8545}
export CUSTODY_PUBLIC_RPC_URL=${CUSTODY_PUBLIC_RPC_URL:-https://xln.finance/rpc}
export CUSTODY_RELAY_URL=${CUSTODY_RELAY_URL:-wss://xln.finance/relay}
export CUSTODY_WALLET_URL=${CUSTODY_WALLET_URL:-https://xln.finance/app}

exec /root/.bun/bin/bun runtime/scripts/start-custody-prod.ts
