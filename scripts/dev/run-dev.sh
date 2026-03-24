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
  --names 'ANVIL,MESH,RUNTIME,VITE' \
  -c 'magenta,blue,yellow,green' \
  "anvil --silent --host 0.0.0.0 --port ${RPC_PORT} --chain-id 31337 --mixed-mining --block-time ${ANVIL_BLOCK_TIME} --block-gas-limit 60000000 --code-size-limit 65536" \
  "USE_ANVIL=true RUNTIME_VERBOSE_LOGS=${RUNTIME_VERBOSE_LOGS:-0} ANVIL_RPC=http://localhost:${RPC_PORT} XLN_MESH_RESET_ALLOWED=1 bun runtime/orchestrator/orchestrator.ts --host 127.0.0.1 --port ${API_PORT} --public-ws-base-url ws://localhost:${API_PORT} --rpc-url http://127.0.0.1:${RPC_PORT} --db-root ./db/dev/mesh --mm --custody --allow-reset --custody-port ${CUSTODY_PORT} --custody-daemon-port ${CUSTODY_DAEMON_PORT} --wallet-url https://localhost:${WEB_PORT}/app" \
  "bun build runtime/runtime.ts --target=browser --outfile=frontend/static/runtime.js --minify --external http --external https --external zlib --external fs --external path --external crypto --external stream --external url --external net --external tls --external os --external util --watch" \
  "cd frontend && VITE_DEV_PORT=${WEB_PORT} VITE_API_PROXY_TARGET=http://127.0.0.1:${API_PORT} vite dev"
