#!/bin/bash
# Start XLN Production Hub (Testnet)
# Uses existing p2p-node.ts runtime

set -euo pipefail

cd /root/xln
source /root/xln/scripts/lib/start-common.sh

# Hub configuration
export HUB_SEED=${HUB_SEED:-$(xln_read_or_create_operator_seed /root/xln/db/secrets/legacy-hub.seed)}
export ANVIL_RPC="http://localhost:8545"

# Start hub node via p2p-node.ts
bun runtime/scenarios/p2p-node.ts \
  --role hub \
  --seed "$HUB_SEED" \
  --relay-port 9000 \
  --relay-host 0.0.0.0 \
  --hub
