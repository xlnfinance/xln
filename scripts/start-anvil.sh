#!/bin/bash
# XLN Anvil - Persistent Testnet Blockchain
# Usage: ./start-anvil.sh [--reset]

set -e

ANVIL_STATE="/root/xln/data/anvil-state.json"
ANVIL_LOG="/root/xln/logs/anvil.log"

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
export PATH="$HOME/.bun/bin:$HOME/.local/share/pnpm:/root/.foundry/bin:$PATH"

# Create directories if missing
mkdir -p /root/xln/data /root/xln/logs

# Reset flag
if [ "$1" = "--reset" ]; then
    echo "🔄 Resetting anvil state..."
    rm -f "$ANVIL_STATE"
fi

kill_by_port 8545

# Start anvil
if [ -f "$ANVIL_STATE" ]; then
    echo "📂 Loading state from $ANVIL_STATE"
    anvil --host 0.0.0.0 --port 8545 \
          --chain-id 31337 \
          --block-gas-limit 60000000 \
          --code-size-limit 65536 \
          --load-state "$ANVIL_STATE" \
          --dump-state "$ANVIL_STATE" \
          2>&1 | tee -a "$ANVIL_LOG"
else
    echo "🆕 Starting fresh anvil (no state file)"
    anvil --host 0.0.0.0 --port 8545 \
          --chain-id 31337 \
          --block-gas-limit 60000000 \
          --code-size-limit 65536 \
          --dump-state "$ANVIL_STATE" \
          2>&1 | tee -a "$ANVIL_LOG"
fi
