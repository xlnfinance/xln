#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd -P)"
DEV_CHILD_COMMAND="\"$REPO_ROOT/scripts/dev/run-dev-child.sh\""
CONCURRENTLY_JS="$REPO_ROOT/node_modules/concurrently/dist/bin/concurrently.js"

source "$REPO_ROOT/scripts/lib/port-layout.sh"
source "$REPO_ROOT/scripts/lib/start-common.sh"
source "$REPO_ROOT/scripts/dev/process-owner.sh"

RPC_PORT="$(xln_rpc_port)"
RPC2_PORT="$(xln_rpc2_port)"
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
XLN_LOG_WARN_STDOUT="${XLN_LOG_WARN_STDOUT:-1}"
DEV_DATA_ROOT="${XLN_DEV_DATA_ROOT:-$REPO_ROOT/db/dev}"
XLN_RDB_ROOT="${XLN_RDB_ROOT:-$DEV_DATA_ROOT/rdb}"
XLN_JDB_ROOT="${XLN_JDB_ROOT:-$DEV_DATA_ROOT/jdb}"
XLN_STORAGE_HISTORY_PATH="${XLN_STORAGE_HISTORY_PATH:-$XLN_RDB_ROOT/storage-health-history.json}"
XLN_STORAGE_HEALTH_DEEP_SCAN="${XLN_STORAGE_HEALTH_DEEP_SCAN:-1}"
ANVIL_TMPDIR="${ANVIL_TMPDIR:-$XLN_JDB_ROOT/tmp/anvil}"
XLN_DEV_PID_DIR="$DEV_DATA_ROOT/pids"
XLN_DEV_OWNER_FILE="$DEV_DATA_ROOT/process-owner"

export XLN_JURISDICTIONS_PATH="${XLN_JURISDICTIONS_PATH:-$XLN_RDB_ROOT/jurisdictions.json}"
XLN_MESH_ROOT_SEED_FILE="${XLN_MESH_ROOT_SEED_FILE:-$DEV_DATA_ROOT/secrets/mesh-root.seed}"
export XLN_MESH_ROOT_SEED="${XLN_MESH_ROOT_SEED:-$(xln_read_or_create_operator_seed "$XLN_MESH_ROOT_SEED_FILE")}"
export RPC_PORT RPC2_PORT API_PORT WEB_PORT WEB_HTTP_PORT CUSTODY_PORT CUSTODY_DAEMON_PORT WATCHTOWER_PORT
export ANVIL_BLOCK_TIME DEV_LOG_DIR MESH_LOG_LEVEL DEV_VERBOSE RUNTIME_VERBOSE_LOGS XLN_LOG_WARN_STDOUT
export DEV_DATA_ROOT XLN_RDB_ROOT XLN_JDB_ROOT XLN_STORAGE_HISTORY_PATH XLN_STORAGE_HEALTH_DEEP_SCAN ANVIL_TMPDIR XLN_DEV_PID_DIR XLN_DEV_OWNER_FILE

dev_supervisor_pid=''
dev_cleanup_started=0

stop_dev_supervisor() {
  [[ -n "$dev_supervisor_pid" ]] || return 0
  kill -0 "$dev_supervisor_pid" 2>/dev/null || { wait "$dev_supervisor_pid" 2>/dev/null || true; return 0; }
  kill -TERM "$dev_supervisor_pid" 2>/dev/null || true
  local attempts=50
  while kill -0 "$dev_supervisor_pid" 2>/dev/null && [[ "$attempts" -gt 0 ]]; do
    sleep 0.1
    attempts=$((attempts - 1))
  done
  if kill -0 "$dev_supervisor_pid" 2>/dev/null; then
    echo "[dev] force-stopping process supervisor pid=${dev_supervisor_pid}" >&2
    kill -KILL "$dev_supervisor_pid" 2>/dev/null || true
  fi
  wait "$dev_supervisor_pid" 2>/dev/null || true
}

cleanup_dev_stack() {
  local exit_status="$?"
  [[ "$dev_cleanup_started" -eq 0 ]] || return "$exit_status"
  dev_cleanup_started=1
  trap - INT TERM EXIT
  local cleanup_status=0
  if [[ -f "$XLN_DEV_OWNER_FILE" ]]; then
    stop_owned_dev_processes "$XLN_DEV_OWNER_FILE" "$XLN_DEV_PID_DIR" "$REPO_ROOT" || cleanup_status=$?
  fi
  stop_dev_supervisor
  if [[ "$cleanup_status" -eq 0 ]]; then
    rm -f "$XLN_DEV_PID_DIR"/*.pid "$XLN_DEV_OWNER_FILE"
  else
    echo "DEV_STACK_CLEANUP_FAILED:status=${cleanup_status}" >&2
  fi
  [[ "$exit_status" -ne 0 ]] && return "$exit_status"
  return "$cleanup_status"
}

trap 'exit 130' INT
trap 'exit 143' TERM
trap cleanup_dev_stack EXIT

cd "$REPO_ROOT"
mkdir -p "$DEV_LOG_DIR" "$XLN_RDB_ROOT" "$XLN_JDB_ROOT" "$XLN_DEV_PID_DIR"
if [[ -e "$XLN_DEV_OWNER_FILE" ]]; then
  echo "DEV_PROCESS_OWNER_ALREADY_EXISTS:${XLN_DEV_OWNER_FILE}; run bun run dev so dev:setup can stop the owned stack" >&2
  exit 1
fi
XLN_DEV_OWNER_ID="$(openssl rand -hex 16)"
(umask 077; printf '%s\n' "$XLN_DEV_OWNER_ID" > "$XLN_DEV_OWNER_FILE")
export XLN_DEV_OWNER_ID

DEV_RADAPTER_KEYS_JSON="$DEV_DATA_ROOT/radapter-keys.json"
DEV_RADAPTER_KEYS_ENV="$DEV_DATA_ROOT/radapter-keys.env"
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
bun --no-orphans "$CONCURRENTLY_JS" \
  --kill-others \
  --kill-others-on-fail \
  --kill-timeout 5000 \
  --names 'ANVIL,ANVIL2,STACK' \
  -c 'magenta,cyan,blue' \
  "${DEV_CHILD_COMMAND} anvil" \
  "${DEV_CHILD_COMMAND} anvil2" \
  "${DEV_CHILD_COMMAND} stack" &
dev_supervisor_pid=$!
wait "$dev_supervisor_pid"
concurrently_status=$?
dev_supervisor_pid=''
set -e
exit "$concurrently_status"
