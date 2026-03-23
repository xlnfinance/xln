#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

source "$REPO_ROOT/scripts/lib/port-layout.sh"

RPC_PORT="$(xln_rpc_port)"
API_PORT="$(xln_api_port)"
WEB_PORT="$(xln_web_port)"
CUSTODY_PORT="$(xln_custody_port)"
CUSTODY_DAEMON_PORT="$(xln_custody_daemon_port)"
ANVIL_BLOCK_TIME="${XLN_ANVIL_BLOCK_TIME:-1}"

export XLN_DEV_SESSION_ID="${XLN_DEV_SESSION_ID:-$(uuidgen)}"
export XLN_JURISDICTIONS_PATH="${XLN_JURISDICTIONS_PATH:-./db/dev/jurisdictions.json}"

cd "$REPO_ROOT"

exec concurrently \
  --kill-others-on-fail \
  --names 'ANVIL,API,CUSTODY,RUNTIME,VITE' \
  -c 'magenta,blue,cyan,yellow,green' \
  "anvil --silent --host 0.0.0.0 --port ${RPC_PORT} --chain-id 31337 --mixed-mining --block-time ${ANVIL_BLOCK_TIME} --block-gas-limit 60000000 --code-size-limit 65536" \
  "USE_ANVIL=true BOOTSTRAP_LOCAL_HUBS=1 XLN_RUNTIME_SEED=xln-dev-main-runtime RUNTIME_VERBOSE_LOGS=${RUNTIME_VERBOSE_LOGS:-0} ANVIL_RPC=http://localhost:${RPC_PORT} bun runtime/server.ts --port ${API_PORT}" \
  "DEV_VERBOSE=${DEV_VERBOSE:-0} DEV_ANVIL_RPC=http://127.0.0.1:${RPC_PORT} DEV_API_BASE_URL=http://127.0.0.1:${API_PORT} DEV_WALLET_PORT=${WEB_PORT} DEV_WALLET_URL=https://localhost:${WEB_PORT}/app DEV_CUSTODY_PORT=${CUSTODY_PORT} DEV_CUSTODY_DAEMON_PORT=${CUSTODY_DAEMON_PORT} bun runtime/scripts/start-custody-dev.ts" \
  "bun build runtime/runtime.ts --target=browser --outfile=frontend/static/runtime.js --minify --external http --external https --external zlib --external fs --external path --external crypto --external stream --external url --external net --external tls --external os --external util --watch" \
  "cd frontend && VITE_DEV_PORT=${WEB_PORT} VITE_API_PROXY_TARGET=http://127.0.0.1:${API_PORT} vite dev"
