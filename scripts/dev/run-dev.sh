#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd -P)"
source "$REPO_ROOT/scripts/lib/port-layout.sh"
source "$REPO_ROOT/scripts/lib/start-common.sh"
source "$REPO_ROOT/scripts/dev/process-owner.sh"
assert_dev_launcher_capability "$REPO_ROOT"
unset XLN_DEV_LAUNCHER_PORT XLN_DEV_LAUNCHER_TOKEN
assert_no_dev_storage_path_overrides

RPC_PORT="$(xln_rpc_port)"
RPC2_PORT="$(xln_rpc2_port)"
API_PORT="$(xln_api_port)"
WEB_PORT="$(xln_web_port)"
WEB_HTTP_PORT="$(xln_web_http_port)"
CUSTODY_PORT="$(xln_custody_port)"
CUSTODY_DAEMON_PORT="$(xln_custody_daemon_port)"
WATCHTOWER_PORT="$(xln_watchtower_port)"
UI_PORT="$(xln_ui_port)"
ANVIL_BLOCK_TIME="${XLN_ANVIL_BLOCK_TIME:-1}"
DEV_LOG_DIR="${XLN_DEV_LOG_DIR:-$REPO_ROOT/.logs/dev}"
MESH_LOG_LEVEL="${XLN_LOG_LEVEL:-warn}"
DEV_VERBOSE="${DEV_VERBOSE:-0}"
RUNTIME_VERBOSE_LOGS="${RUNTIME_VERBOSE_LOGS:-0}"
XLN_LOG_WARN_STDOUT="${XLN_LOG_WARN_STDOUT:-1}"
DEV_DATA_ROOT="$(canonical_dev_data_root "${XLN_DEV_DATA_ROOT:-$REPO_ROOT/db/dev}")"
if [[ "$DEV_DATA_ROOT" == "$REPO_ROOT" || "$DEV_DATA_ROOT" == "${HOME:-__home_unset__}" ]]; then
  echo "DEV_DATA_ROOT_UNSAFE:${DEV_DATA_ROOT}" >&2
  exit 1
fi
XLN_RDB_ROOT="$DEV_DATA_ROOT/rdb"
XLN_JDB_ROOT="$DEV_DATA_ROOT/jdb"
XLN_STORAGE_HISTORY_PATH="$XLN_RDB_ROOT/storage-health-history.json"
XLN_STORAGE_HEALTH_DEEP_SCAN="${XLN_STORAGE_HEALTH_DEEP_SCAN:-1}"
ANVIL_TMPDIR="$XLN_JDB_ROOT/tmp/anvil"
XLN_DEV_PID_DIR="$DEV_DATA_ROOT/pids"
XLN_DEV_OWNER_FILE="$DEV_DATA_ROOT/process-owner"
DEV_RUNTIME_BUNDLE_PATH="$REPO_ROOT/frontend/static/runtime.js"
DEV_STARTED_AT_MS="$(bun -e 'process.stdout.write(String(Date.now()))')"
DEV_READY_TIMEOUT_MS="${XLN_DEV_READY_TIMEOUT_MS:-240000}"
DEV_SHUTDOWN_TIMEOUT_MS="${XLN_DEV_SHUTDOWN_TIMEOUT_MS:-65000}"
if [[ ! "$DEV_SHUTDOWN_TIMEOUT_MS" =~ ^[1-9][0-9]*$ ]]; then
  echo "DEV_SHUTDOWN_TIMEOUT_INVALID:${DEV_SHUTDOWN_TIMEOUT_MS}" >&2
  exit 1
fi

DEV_WEB_SCHEME=http
if [[ "${XLN_VITE_FORCE_HTTP:-0}" != "1" ]]; then
  for cert_base in \
    "$REPO_ROOT/frontend/localhost+3" \
    "$REPO_ROOT/frontend/localhost+2" \
    "$REPO_ROOT/192.168.1.23+2"; do
    if [[ -f "${cert_base}.pem" && -f "${cert_base}-key.pem" ]]; then
      DEV_WEB_SCHEME=https
      break
    fi
  done
fi
DEV_CUSTODY_SCHEME=http
case "${CUSTODY_HTTPS:-}" in
  1|[Tt][Rr][Uu][Ee]|[Yy][Ee][Ss]) DEV_CUSTODY_SCHEME=https ;;
esac
DEV_RELAY_WEB_URLS="${DEV_WEB_SCHEME}://localhost:${WEB_PORT},http://localhost:${WEB_HTTP_PORT},http://localhost:${UI_PORT}"

export XLN_JURISDICTIONS_PATH="$XLN_RDB_ROOT/jurisdictions.json"
XLN_MESH_ROOT_SEED_FILE="${XLN_MESH_ROOT_SEED_FILE:-$DEV_DATA_ROOT/secrets/mesh-root.seed}"
export XLN_MESH_ROOT_SEED="${XLN_MESH_ROOT_SEED:-$(xln_read_or_create_operator_seed "$XLN_MESH_ROOT_SEED_FILE")}"
export RPC_PORT RPC2_PORT API_PORT WEB_PORT WEB_HTTP_PORT CUSTODY_PORT CUSTODY_DAEMON_PORT WATCHTOWER_PORT UI_PORT
export ANVIL_BLOCK_TIME DEV_LOG_DIR MESH_LOG_LEVEL DEV_VERBOSE RUNTIME_VERBOSE_LOGS XLN_LOG_WARN_STDOUT
export DEV_DATA_ROOT XLN_RDB_ROOT XLN_JDB_ROOT XLN_STORAGE_HISTORY_PATH XLN_STORAGE_HEALTH_DEEP_SCAN ANVIL_TMPDIR XLN_DEV_PID_DIR XLN_DEV_OWNER_FILE
export DEV_RUNTIME_BUNDLE_PATH DEV_STARTED_AT_MS DEV_READY_TIMEOUT_MS DEV_SHUTDOWN_TIMEOUT_MS DEV_CUSTODY_SCHEME DEV_RELAY_WEB_URLS
export XLN_DEV_SHUTDOWN_TIMEOUT_MS="$DEV_SHUTDOWN_TIMEOUT_MS"

dev_cleanup_started=0

cleanup_dev_stack() {
  local exit_status="$?"
  [[ "$dev_cleanup_started" -eq 0 ]] || return "$exit_status"
  dev_cleanup_started=1
  trap - INT TERM EXIT
  local cleanup_status=0
  if [[ -f "$XLN_DEV_OWNER_FILE" ]]; then
    stop_owned_dev_processes "$XLN_DEV_OWNER_FILE" "$XLN_DEV_PID_DIR" "$REPO_ROOT" || cleanup_status=$?
  fi
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
  echo "DEV_PROCESS_OWNER_ALREADY_EXISTS:${XLN_DEV_OWNER_FILE}; stop the current bun run dev process first" >&2
  exit 1
fi
XLN_DEV_OWNER_ID="$(openssl rand -hex 16)"
(umask 077; printf '%s\n' "$XLN_DEV_OWNER_ID" > "$XLN_DEV_OWNER_FILE")
export XLN_DEV_OWNER_ID

DEV_RADAPTER_KEYS_JSON="$DEV_DATA_ROOT/radapter-keys.json"
DEV_RADAPTER_KEYS_ENV="$DEV_DATA_ROOT/radapter-keys.env"
bun core/scripts/operations/development/dev-radapter-keys.ts \
  --web-port "${WEB_PORT}" \
  --manager-origin "http://localhost:${WEB_HTTP_PORT}" \
  --api-port "${API_PORT}" \
  --out "$DEV_RADAPTER_KEYS_JSON" \
  --env-out "$DEV_RADAPTER_KEYS_ENV" \
  --suppress-url-log \
  --quiet
source "$DEV_RADAPTER_KEYS_ENV"

bun core/scripts/operations/development/print-dev-links.ts \
  --web-port "${WEB_PORT}" \
  --web-http-port "${WEB_HTTP_PORT}" \
  --web-scheme "${DEV_WEB_SCHEME}" \
  --api-port "${API_PORT}" \
  --rpc-port "${RPC_PORT}" \
  --rpc2-port "${RPC2_PORT}" \
  --custody-port "${CUSTODY_PORT}" \
  --custody-scheme "${DEV_CUSTODY_SCHEME}" \
  --custody-daemon-port "${CUSTODY_DAEMON_PORT}" \
  --watchtower-port "${WATCHTOWER_PORT}" \
  --ui-port "${UI_PORT}" \
  --keys "$DEV_RADAPTER_KEYS_JSON"

echo "DEV_BOOTING wallet=http://localhost:${WEB_HTTP_PORT}/app ui=http://localhost:${UI_PORT}/ api=http://127.0.0.1:${API_PORT}"

if [[ "$DEV_VERBOSE" != "1" ]]; then
  echo "anvil logs             ${DEV_LOG_DIR}/anvil-${RPC_PORT}.log"
  echo "anvil2 logs            ${DEV_LOG_DIR}/anvil-${RPC2_PORT}.log"
fi

bun scripts/dev/supervise-dev.ts
