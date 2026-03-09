#!/bin/bash
# XLN Server Startup Script for pm2
# This wraps the bun server with proper environment setup

cd /root/xln

export USE_ANVIL=true
export ANVIL_RPC=http://localhost:8545
export PUBLIC_RPC=${PUBLIC_RPC:-https://xln.finance/rpc}
# Prod should start as a plain daemon unless bootstrap is explicitly requested.
export BOOTSTRAP_LOCAL_HUBS=${BOOTSTRAP_LOCAL_HUBS:-0}
export PATH="/root/.bun/bin:$PATH"

./scripts/sync-contract-artifacts.sh

exec /root/.bun/bin/bun runtime/server.ts --port 8080
