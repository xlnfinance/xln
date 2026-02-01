#!/bin/bash
# Start XLN Production Hub (Testnet)
# Uses existing p2p-node.ts runtime

set -e

cd /root/xln

# Hub configuration
export HUB_SEED="xln-main-hub-2026"
export ANVIL_RPC="http://localhost:8545"

# Start hub node via p2p-node.ts
bun runtime/scenarios/p2p-node.ts \
  --role hub \
  --seed "$HUB_SEED" \
  --relay-port 9000 \
  --relay-host 0.0.0.0 \
  --hub
