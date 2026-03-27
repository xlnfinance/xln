#!/bin/bash
# XLN Anvil - Persistent Testnet Blockchain
# Usage: ./start-anvil.sh [--reset]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
source "$REPO_ROOT/scripts/lib/port-layout.sh"
ANVIL_STATE="${ANVIL_STATE:-$REPO_ROOT/data/anvil-state.json}"
ANVIL_LOG="${ANVIL_LOG:-$REPO_ROOT/logs/anvil.log}"
ANVIL_BLOCK_TIME="${ANVIL_BLOCK_TIME:-1}"
ANVIL_PORT="${ANVIL_PORT:-$(xln_rpc_port)}"
ANVIL_TMPDIR="${ANVIL_TMPDIR:-$REPO_ROOT/data/anvil-tmp}"
ANVIL_MAX_PERSISTED_STATES="${ANVIL_MAX_PERSISTED_STATES:-2}"

kill_by_port() {
    local port="$1"
    local pids
    pids="$(lsof -ti TCP:${port} -sTCP:LISTEN 2>/dev/null || true)"
    if [ -n "$pids" ]; then
        echo "[start-anvil] killing stale listeners on :${port} -> ${pids}"
        echo "$pids" | xargs kill -9 2>/dev/null || true
    fi
}

# Ensure foundry binaries are available
export PATH="$HOME/.bun/bin:$HOME/.local/share/pnpm:$HOME/.foundry/bin:$PATH"
export TMPDIR="$ANVIL_TMPDIR"

# Create directories if missing
mkdir -p "$(dirname "$ANVIL_STATE")" "$(dirname "$ANVIL_LOG")" "$ANVIL_TMPDIR"
find "$ANVIL_TMPDIR" -mindepth 1 -mmin +180 -exec rm -rf {} + 2>/dev/null || true

# Reset flag
if [ "$1" = "--reset" ]; then
    echo "🔄 Resetting anvil state..."
    rm -f "$ANVIL_STATE"
fi

kill_by_port "$ANVIL_PORT"

# Start anvil
if [ -f "$ANVIL_STATE" ]; then
    echo "📂 Loading state from $ANVIL_STATE"
    anvil --host 0.0.0.0 --port "$ANVIL_PORT" \
          --chain-id 31337 \
          --mixed-mining \
          --quiet \
          --block-time "$ANVIL_BLOCK_TIME" \
          --block-gas-limit 60000000 \
          --code-size-limit 65536 \
          --max-persisted-states "$ANVIL_MAX_PERSISTED_STATES" \
          --load-state "$ANVIL_STATE" \
          --dump-state "$ANVIL_STATE" \
          2>&1 | tee -a "$ANVIL_LOG"
else
    echo "🆕 Starting fresh anvil (no state file)"
    anvil --host 0.0.0.0 --port "$ANVIL_PORT" \
          --chain-id 31337 \
          --mixed-mining \
          --quiet \
          --block-time "$ANVIL_BLOCK_TIME" \
          --block-gas-limit 60000000 \
          --code-size-limit 65536 \
          --max-persisted-states "$ANVIL_MAX_PERSISTED_STATES" \
          --dump-state "$ANVIL_STATE" \
          2>&1 | tee -a "$ANVIL_LOG"
fi
