#!/bin/bash
# XLN Anvil - Persistent Testnet Blockchain
# Usage: ./start-anvil.sh [--reset]

set -e

ANVIL_STATE="/root/xln/data/anvil-state.json"
ANVIL_LOG="/root/xln/logs/anvil.log"

# Ensure foundry binaries are available
export PATH="$HOME/.bun/bin:$HOME/.local/share/pnpm:/root/.foundry/bin:$PATH"

# Create directories if missing
mkdir -p /root/xln/data /root/xln/logs

# Reset flag
if [ "$1" = "--reset" ]; then
    echo "🔄 Resetting anvil state..."
    rm -f "$ANVIL_STATE"
fi

# Start anvil
if [ -f "$ANVIL_STATE" ]; then
    echo "📂 Loading state from $ANVIL_STATE"
    anvil --host 0.0.0.0 --port 8545 \
          --block-gas-limit 60000000 \
          --code-size-limit 65536 \
          --load-state "$ANVIL_STATE" \
          --dump-state "$ANVIL_STATE" \
          2>&1 | tee -a "$ANVIL_LOG"
else
    echo "🆕 Starting fresh anvil (no state file)"
    anvil --host 0.0.0.0 --port 8545 \
          --block-gas-limit 60000000 \
          --code-size-limit 65536 \
          --dump-state "$ANVIL_STATE" \
          2>&1 | tee -a "$ANVIL_LOG"
fi
