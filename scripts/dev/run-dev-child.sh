#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd -P)"
source "$SCRIPT_DIR/process-owner.sh"

role="${1:-}"
if [[ -z "$role" ]]; then
  echo "DEV_CHILD_ROLE_REQUIRED" >&2
  exit 2
fi

case "$role" in
  anvil|anvil2|rpc-ready|backend-ready|mesh|watchtower|runtime|vite|vite-http|ready)
    ;;
  *)
    echo "DEV_CHILD_ROLE_UNKNOWN:${role}" >&2
    exit 2
    ;;
esac

require_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "DEV_CHILD_ENV_REQUIRED:${name}" >&2
    exit 2
  fi
}

for name in RPC_PORT RPC2_PORT API_PORT WEB_PORT WEB_HTTP_PORT CUSTODY_PORT CUSTODY_DAEMON_PORT WATCHTOWER_PORT DEV_LOG_DIR MESH_LOG_LEVEL XLN_RDB_ROOT XLN_JDB_ROOT XLN_DEV_PID_DIR XLN_DEV_OWNER_ID; do
  require_env "$name"
done
if [[ "$role" == "ready" || "$role" == "backend-ready" ]]; then
  for name in DEV_RUNTIME_BUNDLE_PATH DEV_STARTED_AT_MS DEV_READY_TIMEOUT_MS DEV_RELAY_WEB_URLS; do
    require_env "$name"
  done
fi

ANVIL_BLOCK_TIME="${XLN_ANVIL_BLOCK_TIME:-1}"
RUNTIME_VERBOSE_LOGS="${RUNTIME_VERBOSE_LOGS:-0}"
DEV_VERBOSE="${DEV_VERBOSE:-0}"
DEV_RPC_READY_TIMEOUT_MS="${XLN_DEV_RPC_READY_TIMEOUT_MS:-15000}"
DEV_CHILD_TERM_TIMEOUT_MS="${XLN_DEV_CHILD_TERM_TIMEOUT_MS:-${XLN_DEV_SHUTDOWN_TIMEOUT_MS:-65000}}"
ANVIL_TMPDIR="${ANVIL_TMPDIR:-$XLN_JDB_ROOT/tmp/anvil}"
ANVIL_STATE_INTERVAL_SECONDS=60

if [[ ! "$DEV_CHILD_TERM_TIMEOUT_MS" =~ ^[1-9][0-9]*$ ]]; then
  echo "DEV_CHILD_TERM_TIMEOUT_INVALID:${DEV_CHILD_TERM_TIMEOUT_MS}" >&2
  exit 2
fi
register_owned_dev_process "$role" "$REPO_ROOT"
owned_child_pid=''

cleanup_owned_child() {
  remove_owned_dev_process_registration "$role" "$REPO_ROOT"
}

forward_owned_signal() {
  local signal="$1"
  trap - TERM INT EXIT
  if [[ -n "$owned_child_pid" ]] && kill -0 "$owned_child_pid" 2>/dev/null; then
    # Background processes may inherit SIGINT as ignored. Always request an
    # orderly child shutdown with SIGTERM, then enforce a finite upper bound.
    kill -TERM "$owned_child_pid" 2>/dev/null || true
    local attempts=$(( (DEV_CHILD_TERM_TIMEOUT_MS + 99) / 100 ))
    while kill -0 "$owned_child_pid" 2>/dev/null && [[ "$attempts" -gt 0 ]]; do
      local child_state
      child_state="$(LC_ALL=C ps -p "$owned_child_pid" -o stat= 2>/dev/null | sed -e 's/^[[:space:]]*//' || true)"
      [[ "$child_state" == Z* ]] && break
      sleep 0.1
      attempts=$((attempts - 1))
    done
    if kill -0 "$owned_child_pid" 2>/dev/null; then
      local child_state
      child_state="$(LC_ALL=C ps -p "$owned_child_pid" -o stat= 2>/dev/null | sed -e 's/^[[:space:]]*//' || true)"
      if [[ "$child_state" != Z* ]]; then
        echo "DEV_CHILD_FORCE_STOP:role=${role} pid=${owned_child_pid}" >&2
        kill -KILL "$owned_child_pid" 2>/dev/null || true
      fi
    fi
    wait "$owned_child_pid" 2>/dev/null || true
  fi
  cleanup_owned_child
  [[ "$signal" == 'TERM' ]] && exit 143
  exit 130
}

trap 'forward_owned_signal TERM' TERM
trap 'forward_owned_signal INT' INT
trap cleanup_owned_child EXIT

run_owned() {
  "$@" &
  owned_child_pid=$!
  local status=0
  wait "$owned_child_pid" || status=$?
  owned_child_pid=''
  return "$status"
}

run_anvil() {
  local port="$1"
  local chain_id="$2"
  local state_path="$XLN_JDB_ROOT/anvil-${chain_id}-state.json"
  local chain_tmp_dir="$ANVIL_TMPDIR/chain-${chain_id}"
  mkdir -p "$XLN_JDB_ROOT" "$chain_tmp_dir"
  local args=(
    anvil --silent --host 0.0.0.0 --port "$port" --chain-id "$chain_id"
    --mixed-mining --block-time "$ANVIL_BLOCK_TIME" --block-gas-limit 60000000 --code-size-limit 65536
    --state "$state_path" --state-interval "$ANVIL_STATE_INTERVAL_SECONDS"
  )
  if [[ "$DEV_VERBOSE" == "1" ]]; then
    run_owned env TMPDIR="$chain_tmp_dir" ANVIL_TMPDIR="$chain_tmp_dir" "${args[@]}"
    return
  fi
  run_owned env TMPDIR="$chain_tmp_dir" ANVIL_TMPDIR="$chain_tmp_dir" "${args[@]}" > "${DEV_LOG_DIR}/anvil-${port}.log" 2>&1
}

run_vite() {
  local port="$1"
  shift
  cd frontend
  echo "VITE_STARTING port=${port} api=http://127.0.0.1:${API_PORT} logLevel=warn"
  run_owned env \
    VITE_DEV_PORT="$port" \
    VITE_API_PROXY_TARGET="http://127.0.0.1:${API_PORT}" \
    VITE_XLN_WATCHTOWER_URL="http://127.0.0.1:${WATCHTOWER_PORT}" \
    ANVIL_RPC="http://localhost:${RPC_PORT}" \
    ANVIL_RPC2="http://localhost:${RPC2_PORT}" \
    RPC_ETHEREUM="http://localhost:${RPC_PORT}" \
    RPC_TRON="http://localhost:${RPC2_PORT}" \
    "$REPO_ROOT/frontend/node_modules/.bin/vite" dev "$@"
}

wait_for_dev_chains() {
  run_owned bun core/scripts/operations/development/wait-rpc-chain.ts \
    --url "http://127.0.0.1:${RPC_PORT}" \
    --chain-id 31337 \
    --timeout-ms "$DEV_RPC_READY_TIMEOUT_MS"
  run_owned bun core/scripts/operations/development/wait-rpc-chain.ts \
    --url "http://127.0.0.1:${RPC2_PORT}" \
    --chain-id 31338 \
    --timeout-ms "$DEV_RPC_READY_TIMEOUT_MS"
}

# Only the supervisor may release application roles after the one exact
# dual-chain barrier. Direct child invocation cannot bypass that phase.
if [[ "$role" != "anvil" && "$role" != "anvil2" && "$role" != "rpc-ready" \
  && "${XLN_DEV_CHAINS_READY:-}" != "1" ]]; then
  echo "DEV_CHAINS_NOT_READY:role=${role}" >&2
  exit 2
fi

case "$role" in
  anvil)
    run_anvil "$RPC_PORT" 31337
    ;;
  anvil2)
    run_anvil "$RPC2_PORT" 31338
    ;;
  rpc-ready)
    wait_for_dev_chains
    ;;
  backend-ready)
    run_owned bun scripts/dev/readiness/wait-dev-backend-ready.ts \
      --api-url "http://127.0.0.1:${API_PORT}" \
      --watchtower-url "http://127.0.0.1:${WATCHTOWER_PORT}" \
      --runtime-bundle "$DEV_RUNTIME_BUNDLE_PATH" \
      --started-at-ms "$DEV_STARTED_AT_MS" \
      --timeout-ms "$DEV_READY_TIMEOUT_MS"
    ;;
  mesh)
    run_owned env \
      USE_ANVIL=true \
      RUNTIME_VERBOSE_LOGS="$RUNTIME_VERBOSE_LOGS" \
      XLN_LOG_LEVEL="$MESH_LOG_LEVEL" \
      ANVIL_RPC="http://localhost:${RPC_PORT}" \
      ANVIL_RPC2="http://localhost:${RPC2_PORT}" \
      XLN_MESH_RESET_ALLOWED=1 \
      XLN_AUTO_PROVISION_EXTERNAL_FAUCET="${XLN_AUTO_PROVISION_EXTERNAL_FAUCET:-1}" \
      XLN_PUBLIC_FAUCET="${XLN_PUBLIC_FAUCET:-1}" \
      bun --no-orphans core/orchestrator/orchestrator.ts \
        --host 127.0.0.1 \
        --port "$API_PORT" \
        --public-ws-base-url "ws://127.0.0.1:${API_PORT}" \
        --relay-url "ws://127.0.0.1:${API_PORT}/relay" \
        --relay-web-urls "$DEV_RELAY_WEB_URLS" \
        --rpc-url "http://127.0.0.1:${RPC_PORT}" \
        --rpc2-url "http://127.0.0.1:${RPC2_PORT}" \
        --db-root "$XLN_RDB_ROOT/mesh" \
        --mm \
        --custody \
        --allow-reset \
        --custody-port "$CUSTODY_PORT" \
        --custody-daemon-port "$CUSTODY_DAEMON_PORT" \
        --wallet-url "http://localhost:${WEB_HTTP_PORT}/app"
    ;;
  watchtower)
    run_owned bun --no-orphans core/watchtower/standalone-server.ts \
      --host 127.0.0.1 \
      --port "$WATCHTOWER_PORT" \
      --db "$XLN_RDB_ROOT/watchtower" \
      --quota-bytes 4194304 \
      --max-bundles 3
    ;;
  runtime)
    run_owned ./scripts/dev/watch-runtime-build.sh
    ;;
  vite)
    run_vite "$WEB_PORT" --logLevel warn
    ;;
  vite-http)
    run_vite "$WEB_HTTP_PORT" --config vite.config.http.ts --logLevel warn
    ;;
  ready)
    run_owned bun scripts/dev/wait-dev-ready.ts \
      --api-url "http://127.0.0.1:${API_PORT}" \
      --web-url "http://localhost:${WEB_HTTP_PORT}" \
      --relay-web-urls "$DEV_RELAY_WEB_URLS" \
      --watchtower-url "http://127.0.0.1:${WATCHTOWER_PORT}" \
      --runtime-bundle "$DEV_RUNTIME_BUNDLE_PATH" \
      --started-at-ms "$DEV_STARTED_AT_MS" \
      --timeout-ms "$DEV_READY_TIMEOUT_MS"
    ;;
esac
