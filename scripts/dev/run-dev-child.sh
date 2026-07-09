#!/bin/bash
set -euo pipefail

role="${1:-}"
if [[ -z "$role" ]]; then
  echo "DEV_CHILD_ROLE_REQUIRED" >&2
  exit 2
fi

case "$role" in
  anvil|anvil2|mesh|watchtower|vite|vite-http)
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

for name in RPC_PORT RPC2_PORT API_PORT WEB_PORT WEB_HTTP_PORT CUSTODY_PORT CUSTODY_DAEMON_PORT WATCHTOWER_PORT DEV_LOG_DIR MESH_LOG_LEVEL; do
  require_env "$name"
done

ANVIL_BLOCK_TIME="${XLN_ANVIL_BLOCK_TIME:-1}"
RUNTIME_VERBOSE_LOGS="${RUNTIME_VERBOSE_LOGS:-0}"
DEV_VERBOSE="${DEV_VERBOSE:-0}"

run_anvil() {
  local port="$1"
  local chain_id="$2"
  if [[ "$DEV_VERBOSE" == "1" ]]; then
    exec anvil --silent --host 0.0.0.0 --port "$port" --chain-id "$chain_id" --mixed-mining --block-time "$ANVIL_BLOCK_TIME" --block-gas-limit 60000000 --code-size-limit 65536
  fi
  exec anvil --silent --host 0.0.0.0 --port "$port" --chain-id "$chain_id" --mixed-mining --block-time "$ANVIL_BLOCK_TIME" --block-gas-limit 60000000 --code-size-limit 65536 > "${DEV_LOG_DIR}/anvil-${port}.log" 2>&1
}

run_vite() {
  local port="$1"
  shift
  cd frontend
  echo "VITE_DEV_SERVER_START port=${port} api=http://127.0.0.1:${API_PORT} logLevel=warn"
  exec env \
    VITE_DEV_PORT="$port" \
    VITE_API_PROXY_TARGET="http://127.0.0.1:${API_PORT}" \
    VITE_XLN_WATCHTOWER_URL="http://127.0.0.1:${WATCHTOWER_PORT}" \
    ANVIL_RPC="http://localhost:${RPC_PORT}" \
    ANVIL_RPC2="http://localhost:${RPC2_PORT}" \
    RPC_ETHEREUM="http://localhost:${RPC_PORT}" \
    RPC_TRON="http://localhost:${RPC2_PORT}" \
    vite dev "$@"
}

case "$role" in
  anvil)
    run_anvil "$RPC_PORT" 31337
    ;;
  anvil2)
    run_anvil "$RPC2_PORT" 31338
    ;;
  mesh)
    exec env \
      USE_ANVIL=true \
      RUNTIME_VERBOSE_LOGS="$RUNTIME_VERBOSE_LOGS" \
      XLN_LOG_LEVEL="$MESH_LOG_LEVEL" \
      ANVIL_RPC="http://localhost:${RPC_PORT}" \
      ANVIL_RPC2="http://localhost:${RPC2_PORT}" \
      XLN_MESH_RESET_ALLOWED=1 \
      XLN_AUTO_PROVISION_EXTERNAL_FAUCET="${XLN_AUTO_PROVISION_EXTERNAL_FAUCET:-1}" \
      bun runtime/orchestrator/orchestrator.ts \
        --host 127.0.0.1 \
        --port "$API_PORT" \
        --public-ws-base-url "ws://127.0.0.1:${API_PORT}" \
        --rpc-url "http://127.0.0.1:${RPC_PORT}" \
        --rpc2-url "http://127.0.0.1:${RPC2_PORT}" \
        --db-root ./db/dev/mesh \
        --mm \
        --custody \
        --allow-reset \
        --custody-port "$CUSTODY_PORT" \
        --custody-daemon-port "$CUSTODY_DAEMON_PORT" \
        --wallet-url "http://localhost:${WEB_HTTP_PORT}/app"
    ;;
  watchtower)
    exec bun runtime/watchtower/standalone-server.ts \
      --host 127.0.0.1 \
      --port "$WATCHTOWER_PORT" \
      --db ./db/dev/watchtower \
      --quota-bytes 4194304 \
      --max-bundles 3
    ;;
  vite)
    run_vite "$WEB_PORT" --logLevel warn
    ;;
  vite-http)
    run_vite "$WEB_HTTP_PORT" --config vite.config.http.ts --logLevel warn
    ;;
esac
