#!/bin/bash
# XLN standalone watchtower startup script.
# Runs as a separate process from the main runtime/orchestrator so backup and
# rescue logs stay isolated from consensus/runtime logs.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$REPO_ROOT"
source "$REPO_ROOT/scripts/lib/start-common.sh"

export PATH="${HOME}/.bun/bin:$PATH"
export XLN_WATCHTOWER_PORT="${XLN_WATCHTOWER_PORT:-9100}"
export XLN_WATCHTOWER_HOST="${XLN_WATCHTOWER_HOST:-127.0.0.1}"
export XLN_WATCHTOWER_DB_PATH="${XLN_WATCHTOWER_DB_PATH:-$REPO_ROOT/db/watchtower/prod-main}"
export XLN_WATCHTOWER_MAX_BYTES="${XLN_WATCHTOWER_MAX_BYTES:-4194304}"
export XLN_WATCHTOWER_MAX_BUNDLES="${XLN_WATCHTOWER_MAX_BUNDLES:-3}"
export XLN_WATCHTOWER_ID="${XLN_WATCHTOWER_ID:-xln-official-watchtower}"
export XLN_WATCHTOWER_SWEEP_INTERVAL_MS="${XLN_WATCHTOWER_SWEEP_INTERVAL_MS:-30000}"
export XLN_WATCHTOWER_ALLOWED_RPC_URLS="${XLN_WATCHTOWER_ALLOWED_RPC_URLS:-http://127.0.0.1:8545/,http://127.0.0.1:8546/,https://xln.finance/rpc,https://xln.finance/rpc2,https://xln.finance/rpc3,https://xln.finance/rpc4,https://xln.finance/rpc5,https://xln.finance/rpc6,https://xln.finance/rpc7,https://xln.finance/rpc8}"
export XLN_WATCHTOWER_ENABLE_LAST_RESORT="${XLN_WATCHTOWER_ENABLE_LAST_RESORT:-1}"
export XLN_WATCHTOWER_OPERATOR_API="${XLN_WATCHTOWER_OPERATOR_API:-0}"
export XLN_WATCHTOWER_PRIVATE_KEY_FILE="${XLN_WATCHTOWER_PRIVATE_KEY_FILE:-$REPO_ROOT/db/watchtower/private-key}"

# Push-wake (detect DisputeStarted -> notify victim device). Default OFF so the
# tower keeps its current behavior until an operator opts in and wires a sender.
export XLN_PUSH_ENABLE="${XLN_PUSH_ENABLE:-0}"
export XLN_PUSH_DB_PATH="${XLN_PUSH_DB_PATH:-$REPO_ROOT/db/watchtower/push-main}"
export XLN_PUSH_SWEEP_INTERVAL_MS="${XLN_PUSH_SWEEP_INTERVAL_MS:-15000}"
# When XLN_PUSH_WEBHOOK_URL is set the tower POSTs notifications there (fan out to
# APNs/FCM); otherwise it falls back to a console sender (logs only).
export XLN_PUSH_WEBHOOK_URL="${XLN_PUSH_WEBHOOK_URL:-}"
export XLN_PUSH_WEBHOOK_TOKEN="${XLN_PUSH_WEBHOOK_TOKEN:-}"

mkdir -p "$(dirname "$XLN_WATCHTOWER_DB_PATH")"
if [ -z "${XLN_WATCHTOWER_PRIVATE_KEY:-}" ]; then
  mkdir -p "$(dirname "$XLN_WATCHTOWER_PRIVATE_KEY_FILE")"
  if [ ! -f "$XLN_WATCHTOWER_PRIVATE_KEY_FILE" ]; then
    umask 077
    "${HOME}/.bun/bin/bun" -e "const { Wallet } = await import('ethers'); console.log(Wallet.createRandom().privateKey)" > "$XLN_WATCHTOWER_PRIVATE_KEY_FILE"
  fi
  export XLN_WATCHTOWER_PRIVATE_KEY="$(tr -d '\r\n' < "$XLN_WATCHTOWER_PRIVATE_KEY_FILE")"
fi
xln_kill_by_port "$XLN_WATCHTOWER_PORT" start-watchtower

WATCHTOWER_ARGS=(
  runtime/watchtower/standalone-server.ts
  --host "$XLN_WATCHTOWER_HOST"
  --port "$XLN_WATCHTOWER_PORT"
  --db "$XLN_WATCHTOWER_DB_PATH"
  --quota-bytes "$XLN_WATCHTOWER_MAX_BYTES"
  --max-bundles "$XLN_WATCHTOWER_MAX_BUNDLES"
  --sweep-interval-ms "$XLN_WATCHTOWER_SWEEP_INTERVAL_MS"
)

if [ "$XLN_WATCHTOWER_ENABLE_LAST_RESORT" = "1" ]; then
  WATCHTOWER_ARGS+=(--enable-last-resort-agent)
fi

if [ "$XLN_WATCHTOWER_OPERATOR_API" = "1" ]; then
  WATCHTOWER_ARGS+=(--enable-operator-api)
fi

if [ "$XLN_PUSH_ENABLE" = "1" ]; then
  WATCHTOWER_ARGS+=(--enable-push-wake)
fi

exec "${HOME}/.bun/bin/bun" "${WATCHTOWER_ARGS[@]}"
