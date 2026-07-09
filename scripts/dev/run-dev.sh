#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

source "$REPO_ROOT/scripts/lib/port-layout.sh"

RPC_PORT="$(xln_rpc_port)"
RPC2_PORT="$((RPC_PORT + 1))"
API_PORT="$(xln_api_port)"
WEB_PORT="$(xln_web_port)"
WEB_HTTP_PORT="$(xln_web_http_port)"
CUSTODY_PORT="$(xln_custody_port)"
CUSTODY_DAEMON_PORT="$(xln_custody_daemon_port)"
WATCHTOWER_PORT="$(xln_watchtower_port)"
ANVIL_BLOCK_TIME="${XLN_ANVIL_BLOCK_TIME:-1}"
DEV_LOG_DIR="${XLN_DEV_LOG_DIR:-$REPO_ROOT/.logs/dev}"
MESH_LOG_LEVEL="${XLN_LOG_LEVEL:-warn}"

export XLN_JURISDICTIONS_PATH="${XLN_JURISDICTIONS_PATH:-./db/dev/jurisdictions.json}"

cd "$REPO_ROOT"
mkdir -p "$DEV_LOG_DIR"

DEV_RADAPTER_KEYS_JSON="$REPO_ROOT/db/dev/radapter-keys.json"
DEV_RADAPTER_KEYS_ENV="$REPO_ROOT/db/dev/radapter-keys.env"
bun runtime/scripts/dev-radapter-keys.ts \
  --web-port "${WEB_PORT}" \
  --manager-origin "http://localhost:${WEB_HTTP_PORT}" \
  --api-port "${API_PORT}" \
  --out "$DEV_RADAPTER_KEYS_JSON" \
  --env-out "$DEV_RADAPTER_KEYS_ENV" \
  --suppress-url-log \
  --quiet
source "$DEV_RADAPTER_KEYS_ENV"

bun runtime/scripts/print-dev-links.ts \
  --web-port "${WEB_PORT}" \
  --web-http-port "${WEB_HTTP_PORT}" \
  --api-port "${API_PORT}" \
  --rpc-port "${RPC_PORT}" \
  --rpc2-port "${RPC2_PORT}" \
  --custody-port "${CUSTODY_PORT}" \
  --custody-daemon-port "${CUSTODY_DAEMON_PORT}" \
  --watchtower-port "${WATCHTOWER_PORT}" \
  --keys "$DEV_RADAPTER_KEYS_JSON"

ANVIL_CMD="anvil --silent --host 0.0.0.0 --port ${RPC_PORT} --chain-id 31337 --mixed-mining --block-time ${ANVIL_BLOCK_TIME} --block-gas-limit 60000000 --code-size-limit 65536"
ANVIL2_CMD="anvil --silent --host 0.0.0.0 --port ${RPC2_PORT} --chain-id 31338 --mixed-mining --block-time ${ANVIL_BLOCK_TIME} --block-gas-limit 60000000 --code-size-limit 65536"
if [[ "${DEV_VERBOSE:-0}" != "1" ]]; then
  ANVIL_CMD="${ANVIL_CMD} > ${DEV_LOG_DIR}/anvil-${RPC_PORT}.log 2>&1"
  ANVIL2_CMD="${ANVIL2_CMD} > ${DEV_LOG_DIR}/anvil-${RPC2_PORT}.log 2>&1"
  echo "anvil logs             ${DEV_LOG_DIR}/anvil-${RPC_PORT}.log"
  echo "anvil2 logs            ${DEV_LOG_DIR}/anvil-${RPC2_PORT}.log"
fi

exec concurrently \
  --kill-others-on-fail \
  --names 'ANVIL,ANVIL2,MESH,WATCH,RUNTIME,VITE,VITE_HTTP' \
  -c 'magenta,cyan,blue,red,yellow,green,white' \
  "$ANVIL_CMD" \
  "$ANVIL2_CMD" \
  "USE_ANVIL=true RUNTIME_VERBOSE_LOGS=${RUNTIME_VERBOSE_LOGS:-0} XLN_LOG_LEVEL=${MESH_LOG_LEVEL} ANVIL_RPC=http://localhost:${RPC_PORT} ANVIL_RPC2=http://localhost:${RPC2_PORT} XLN_MESH_RESET_ALLOWED=1 bun runtime/orchestrator/orchestrator.ts --host 127.0.0.1 --port ${API_PORT} --public-ws-base-url ws://127.0.0.1:${API_PORT} --rpc-url http://127.0.0.1:${RPC_PORT} --rpc2-url http://127.0.0.1:${RPC2_PORT} --db-root ./db/dev/mesh --mm --custody --allow-reset --custody-port ${CUSTODY_PORT} --custody-daemon-port ${CUSTODY_DAEMON_PORT} --wallet-url http://localhost:${WEB_HTTP_PORT}/app" \
  "bun runtime/watchtower/standalone-server.ts --host 127.0.0.1 --port ${WATCHTOWER_PORT} --db ./db/dev/watchtower --quota-bytes 4194304 --max-bundles 3" \
  "bun build runtime/runtime.ts --target=browser --outfile=frontend/static/runtime.js --minify --external http --external https --external zlib --external fs --external path --external crypto --external stream --external url --external net --external tls --external os --external util --watch" \
  "cd frontend && VITE_DEV_PORT=${WEB_PORT} VITE_API_PROXY_TARGET=http://127.0.0.1:${API_PORT} VITE_XLN_WATCHTOWER_URL=http://127.0.0.1:${WATCHTOWER_PORT} ANVIL_RPC=http://localhost:${RPC_PORT} ANVIL_RPC2=http://localhost:${RPC2_PORT} RPC_ETHEREUM=http://localhost:${RPC_PORT} RPC_TRON=http://localhost:${RPC2_PORT} vite dev --logLevel warn" \
  "cd frontend && VITE_DEV_PORT=${WEB_HTTP_PORT} VITE_API_PROXY_TARGET=http://127.0.0.1:${API_PORT} VITE_XLN_WATCHTOWER_URL=http://127.0.0.1:${WATCHTOWER_PORT} ANVIL_RPC=http://localhost:${RPC_PORT} ANVIL_RPC2=http://localhost:${RPC2_PORT} RPC_ETHEREUM=http://localhost:${RPC_PORT} RPC_TRON=http://localhost:${RPC2_PORT} vite dev --config vite.config.http.ts --logLevel warn"
