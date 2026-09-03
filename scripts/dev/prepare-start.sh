#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd -P)"
DEV_DATA_ROOT="${XLN_DEV_DATA_ROOT:-$ROOT_DIR/db/dev}"
DEV_RDB_ROOT="$DEV_DATA_ROOT/rdb"
DEV_JDB_ROOT="$DEV_DATA_ROOT/jdb"
DEV_PID_DIR="$DEV_DATA_ROOT/pids"
DEV_OWNER_FILE="$DEV_DATA_ROOT/process-owner"
CANONICAL_J_PATH="$ROOT_DIR/jurisdictions/jurisdictions.json"

source "$ROOT_DIR/scripts/lib/port-layout.sh"
source "$ROOT_DIR/scripts/dev/process-owner.sh"
assert_dev_launcher_capability "$ROOT_DIR"
unset XLN_DEV_LAUNCHER_PORT XLN_DEV_LAUNCHER_TOKEN
assert_no_dev_storage_path_overrides
DEV_DATA_ROOT="$(canonical_dev_data_root "$DEV_DATA_ROOT")"
DEV_RDB_ROOT="$DEV_DATA_ROOT/rdb"
DEV_JDB_ROOT="$DEV_DATA_ROOT/jdb"
DEV_PID_DIR="$DEV_DATA_ROOT/pids"
DEV_OWNER_FILE="$DEV_DATA_ROOT/process-owner"
RPC_PORT="$(xln_rpc_port)"
RPC2_PORT="$(xln_rpc2_port)"
API_PORT="$(xln_api_port)"
WEB_PORT="$(xln_web_port)"
WEB_HTTP_PORT="$(xln_web_http_port)"
CUSTODY_PORT="$(xln_custody_port)"
CUSTODY_DAEMON_PORT="$(xln_custody_daemon_port)"
WATCHTOWER_PORT="$(xln_watchtower_port)"
UI_PORT="$(xln_ui_port)"

case "$DEV_DATA_ROOT" in
  "$ROOT_DIR"|"${HOME:-__home_unset__}")
    echo "DEV_DATA_ROOT_UNSAFE:${DEV_DATA_ROOT}" >&2
    exit 1
    ;;
esac

if [[ ! -x "$ROOT_DIR/frontend/node_modules/.bin/vite" \
  || ! -f "$ROOT_DIR/frontend/node_modules/@sveltejs/kit/svelte-kit.js" \
  || ! -f "$ROOT_DIR/frontend/node_modules/@sveltejs/vite-plugin-svelte/package.json" \
  || ! -f "$ROOT_DIR/frontend/node_modules/svelte/package.json" ]]; then
  echo "DEV_DEPENDENCIES_MISSING:frontend; run: cd frontend && bun install --frozen-lockfile" >&2
  exit 1
fi
if [[ ! -x "$ROOT_DIR/ui/node_modules/.bin/vite" || ! -f "$ROOT_DIR/ui/node_modules/@vitejs/plugin-react/package.json" ]]; then
  echo "DEV_DEPENDENCIES_MISSING:ui; run: cd ui && bun install" >&2
  exit 1
fi
for tool in anvil lsof openssl rsync; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "DEV_DEPENDENCIES_MISSING:${tool}" >&2
    exit 1
  fi
done

stop_owned_dev_processes "$DEV_OWNER_FILE" "$DEV_PID_DIR" "$ROOT_DIR"
assert_dev_ports_clear "$DEV_PID_DIR" "$DEV_OWNER_FILE" \
  "$RPC_PORT" "$RPC2_PORT" "$WEB_PORT" "$WEB_HTTP_PORT" "$API_PORT" \
  "$CUSTODY_PORT" "$CUSTODY_DAEMON_PORT" "$WATCHTOWER_PORT" "$UI_PORT" \
  "$((API_PORT + 10))" "$((API_PORT + 11))" "$((API_PORT + 12))" "$((API_PORT + 13))" \
  "$((API_PORT + 14))"
rm -f "$DEV_OWNER_FILE" "$DEV_PID_DIR"/*.pid

"$ROOT_DIR/scripts/sync-contract-artifacts.sh"
# The local dev stack is an ephemeral testnet. Runtime state and Anvil state
# form one consistency domain, so preserving either side across `bun run dev`
# can pair a fresh Entity nonce with an old Depository nonce (or vice versa).
# Always recreate both together; operator/durable environments do not use this
# dev setup script.
echo "[dev:setup] resetting ephemeral local JDB/RDB"
rm -rf -- "$DEV_RDB_ROOT" "$DEV_JDB_ROOT"
rm -f -- "$ROOT_DIR/frontend/static/runtime.js" "$ROOT_DIR/frontend/static/account-worker.js"

mkdir -p "$DEV_RDB_ROOT" "$DEV_JDB_ROOT" "$DEV_PID_DIR"
cp "$CANONICAL_J_PATH" "$DEV_RDB_ROOT/jurisdictions.json"
echo "[dev:setup] fresh local contract/runtime state ready"
