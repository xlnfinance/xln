#!/bin/bash
# XLN Anvil - Persistent Testnet Blockchain
# Usage: ./start-anvil.sh [--reset]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
source "$REPO_ROOT/scripts/lib/port-layout.sh"
JDB_ROOT="${XLN_JDB_ROOT:-$REPO_ROOT/data}"
ANVIL_STATE="${ANVIL_STATE:-$JDB_ROOT/anvil-state.json}"
ANVIL_LOG="${ANVIL_LOG:-$REPO_ROOT/logs/anvil.log}"
# Transactions mine immediately; only idle heartbeat blocks use this interval.
# This keeps testnet UX fast without emitting 86,400 empty blocks per day.
ANVIL_BLOCK_TIME=10
ANVIL_PORT="${ANVIL_PORT:-$(xln_rpc_port)}"
ANVIL_CHAIN_ID="${ANVIL_CHAIN_ID:-31337}"
ANVIL_TMPDIR="${ANVIL_TMPDIR:-$JDB_ROOT/tmp}"
ANVIL_PRUNE_HISTORY="${ANVIL_PRUNE_HISTORY:-128}"
ANVIL_STATE_INTERVAL="${ANVIL_STATE_INTERVAL:-60}"

assert_port_available() {
    local port="$1"
    local pids
    pids="$(lsof -ti TCP:${port} -sTCP:LISTEN 2>/dev/null || true)"
    if [ -n "$pids" ]; then
        echo "ANVIL_PORT_ALREADY_BOUND:port=${port}:pids=${pids}" >&2
        return 1
    fi
}

RESET_REQUESTED=0
case "${1:-}" in
    '') ;;
    --reset) RESET_REQUESTED=1 ;;
    *)
        echo "ANVIL_ARGUMENT_INVALID:${1}" >&2
        exit 1
        ;;
esac
if [ "$#" -gt 1 ]; then
    echo "ANVIL_ARGUMENT_COUNT_INVALID:${#}" >&2
    exit 1
fi

# A process supervisor persists argv across host reboots. Never let a production
# PM2 entry retain --reset and silently erase the chain whenever the host starts.
if [ "$RESET_REQUESTED" = "1" ] && [[ "$ANVIL_STATE" == /var/lib/xln/* ]] && [ "${XLN_ALLOW_ANVIL_RESET_ONCE:-0}" != "1" ]; then
    echo "ANVIL_PRODUCTION_RESET_REQUIRES_ONE_SHOT_AUTHORIZATION:state=${ANVIL_STATE}" >&2
    exit 1
fi

# Ensure foundry binaries are available
export PATH="$HOME/.bun/bin:$HOME/.local/share/pnpm:$HOME/.foundry/bin:$PATH"
export TMPDIR="$ANVIL_TMPDIR"

# Create directories if missing
mkdir -p "$(dirname "$ANVIL_STATE")" "$(dirname "$ANVIL_LOG")" "$ANVIL_TMPDIR"
"$REPO_ROOT/scripts/enforce-anvil-storage-budget.sh"

# Reset is intended for local development. Production deploys delete an exact
# state file before creating PM2 entries without destructive arguments.
if [ "$RESET_REQUESTED" = "1" ]; then
    echo "🔄 Resetting anvil state..."
    rm -f "$ANVIL_STATE"
fi

assert_port_available "$ANVIL_PORT"

if [ -f "$ANVIL_STATE" ]; then
    echo "📂 Loading state from $ANVIL_STATE"
else
    echo "🆕 Starting fresh anvil (no state file)"
fi

# exec makes Anvil the supervised process. A logging pipeline would leave PM2
# monitoring this shell, so max_memory_restart could never observe Anvil RSS.
exec anvil --host 0.0.0.0 --port "$ANVIL_PORT" \
      --chain-id "$ANVIL_CHAIN_ID" \
      --quiet \
      --mixed-mining \
      --block-time "$ANVIL_BLOCK_TIME" \
      --block-gas-limit 60000000 \
      --code-size-limit 65536 \
      --prune-history "$ANVIL_PRUNE_HISTORY" \
      --state "$ANVIL_STATE" \
      --state-interval "$ANVIL_STATE_INTERVAL" \
      >> "$ANVIL_LOG" 2>&1
