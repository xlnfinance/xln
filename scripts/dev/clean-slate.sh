#!/bin/bash
set -euo pipefail

echo "[dev:clean] xln clean slate: stopping stale processes and wiping local state"

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd -P)"
cd "$ROOT_DIR"
source "$ROOT_DIR/scripts/lib/port-layout.sh"
source "$ROOT_DIR/scripts/dev/process-owner.sh"
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

assert_port_clear() {
  local port="$1"
  local attempts=50
  local pids=""
  while [ "$attempts" -gt 0 ]; do
    pids="$(lsof -ti TCP:${port} -sTCP:LISTEN 2>/dev/null || true)"
    if [ -z "$pids" ]; then
      return 0
    fi
    sleep 0.1
    attempts=$((attempts - 1))
  done
  local commands
  commands="$(ps -p "$(echo "$pids" | tr '\n' ',')" -o pid=,command= 2>/dev/null || true)"
  echo "DEV_PORT_BUSY_UNOWNED:port=${port} pids=$(echo "$pids" | tr '\n' ',') commands=${commands}" >&2
  return 1
}

stop_owned_dev_processes "$DEV_OWNER_FILE" "$DEV_PID_DIR" "$ROOT_DIR"

assert_port_clear "$RPC_PORT"
assert_port_clear "$RPC2_PORT"
assert_port_clear "$WEB_PORT"
assert_port_clear "$WEB_HTTP_PORT"
assert_port_clear "$API_PORT"
assert_port_clear "$CUSTODY_PORT"
assert_port_clear "$CUSTODY_DAEMON_PORT"
assert_port_clear "$WATCHTOWER_PORT"
assert_port_clear "$((API_PORT + 10))"
assert_port_clear "$((API_PORT + 11))"
assert_port_clear "$((API_PORT + 12))"
assert_port_clear "$((API_PORT + 13))"

echo "[dev:clean] removing only the canonical dev shard"
rm -rf "$DEV_DATA_ROOT"

mkdir -p "$DEV_RDB_ROOT" "$DEV_DATA_ROOT/jdb" "$DEV_PID_DIR"
cp "$CANONICAL_J_PATH" "$DEV_J_PATH"

echo "[dev:clean] clean slate ready"
