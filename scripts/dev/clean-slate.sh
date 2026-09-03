#!/bin/bash
set -euo pipefail

echo "[dev:clean] xln clean slate: stopping stale processes and wiping local state"

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd -P)"
cd "$ROOT_DIR"
source "$ROOT_DIR/scripts/lib/port-layout.sh"
source "$ROOT_DIR/scripts/dev/process-owner.sh"
assert_dev_launcher_capability "$ROOT_DIR"
unset XLN_DEV_LAUNCHER_PORT XLN_DEV_LAUNCHER_TOKEN
CANONICAL_J_PATH="$ROOT_DIR/jurisdictions/jurisdictions.json"
DEV_DATA_ROOT="$ROOT_DIR/db/dev"
DEV_RDB_ROOT="$DEV_DATA_ROOT/rdb"
DEV_J_PATH="$DEV_RDB_ROOT/jurisdictions.json"
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

stop_owned_dev_processes "$DEV_OWNER_FILE" "$DEV_PID_DIR" "$ROOT_DIR"
assert_dev_ports_clear "$DEV_PID_DIR" "$DEV_OWNER_FILE" \
  "$RPC_PORT" "$RPC2_PORT" "$WEB_PORT" "$WEB_HTTP_PORT" "$API_PORT" \
  "$CUSTODY_PORT" "$CUSTODY_DAEMON_PORT" "$WATCHTOWER_PORT" "$UI_PORT" \
  "$((API_PORT + 10))" "$((API_PORT + 11))" "$((API_PORT + 12))" "$((API_PORT + 13))"

echo "[dev:clean] removing only the canonical dev shard"
rm -rf "$DEV_DATA_ROOT"

mkdir -p "$DEV_RDB_ROOT" "$DEV_DATA_ROOT/jdb" "$DEV_PID_DIR"
cp "$CANONICAL_J_PATH" "$DEV_J_PATH"

echo "[dev:clean] clean slate ready"
