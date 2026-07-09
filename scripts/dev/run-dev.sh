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
DEV_VERBOSE="${DEV_VERBOSE:-0}"
RUNTIME_VERBOSE_LOGS="${RUNTIME_VERBOSE_LOGS:-0}"

export XLN_JURISDICTIONS_PATH="${XLN_JURISDICTIONS_PATH:-./db/dev/jurisdictions.json}"
export RPC_PORT RPC2_PORT API_PORT WEB_PORT WEB_HTTP_PORT CUSTODY_PORT CUSTODY_DAEMON_PORT WATCHTOWER_PORT
export ANVIL_BLOCK_TIME DEV_LOG_DIR MESH_LOG_LEVEL DEV_VERBOSE RUNTIME_VERBOSE_LOGS

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

if [[ "$DEV_VERBOSE" != "1" ]]; then
  echo "anvil logs             ${DEV_LOG_DIR}/anvil-${RPC_PORT}.log"
  echo "anvil2 logs            ${DEV_LOG_DIR}/anvil-${RPC2_PORT}.log"
fi

set +e
concurrently \
  --kill-others-on-fail \
  --names 'ANVIL,ANVIL2,MESH,WATCH,RUNTIME,VITE,VITE_HTTP' \
  -c 'magenta,cyan,blue,red,yellow,green,white' \
  "./scripts/dev/run-dev-child.sh anvil" \
  "./scripts/dev/run-dev-child.sh anvil2" \
  "./scripts/dev/run-dev-child.sh mesh" \
  "./scripts/dev/run-dev-child.sh watchtower" \
  "./scripts/dev/watch-runtime-build.sh" \
  "./scripts/dev/run-dev-child.sh vite" \
  "./scripts/dev/run-dev-child.sh vite-http" \
  2>&1 | awk '
    /Sending SIGTERM to other processes\.\./ {
      if (sawSigtermFanout++) next
    }
    { print; fflush() }
  '
concurrently_status=${PIPESTATUS[0]}
set -e
exit "$concurrently_status"
