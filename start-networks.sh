#!/bin/bash

set -e

echo "🚀 Starting XLN Demo Networks..."

# Resolve paths relative to this script to be robust in any CWD
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$SCRIPT_DIR"
LOG_DIR="$ROOT_DIR/logs"
PIDS_DIR="$ROOT_DIR/pids"
CONTRACTS_DIR="$ROOT_DIR/contracts"

# Create directories for logs and pids first
mkdir -p "$LOG_DIR" "$PIDS_DIR"

# Kill any existing hardhat nodes
pkill -f "hardhat node" 2>/dev/null || true

# Wait a bit for cleanup
sleep 1

# Start three hardhat nodes in background
echo "📡 Starting Ethereum Network (port 8545)..."
(cd "$CONTRACTS_DIR" && bun install >/dev/null 2>&1 || true)
(cd "$CONTRACTS_DIR" && bunx hardhat node --port 8545 --hostname 127.0.0.1 > "$LOG_DIR/ethereum-8545.log" 2>&1 &)
echo "$!" > "$PIDS_DIR/ethereum.pid"

echo "📡 Starting Polygon Network (port 8546)..."
(cd "$CONTRACTS_DIR" && bunx hardhat node --port 8546 --hostname 127.0.0.1 > "$LOG_DIR/polygon-8546.log" 2>&1 &)
echo "$!" > "$PIDS_DIR/polygon.pid"

echo "📡 Starting Arbitrum Network (port 8547)..."
(cd "$CONTRACTS_DIR" && bunx hardhat node --port 8547 --hostname 127.0.0.1 > "$LOG_DIR/arbitrum-8547.log" 2>&1 &)
echo "$!" > "$PIDS_DIR/arbitrum.pid"

echo "⏳ Waiting for networks to start..."

wait_for_port() {
  local port=$1
  local timeout=60
  while [ $timeout -gt 0 ]; do
    if check_network "$port"; then
      return 0
    fi
    sleep 1
    timeout=$((timeout-1))
  done
  return 1
}

# Check if networks are responding
check_network() {
    curl -s -X POST -H "Content-Type: application/json" \
         --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
         http://localhost:$1 > /dev/null 2>&1
    return $?
}

echo "🔍 Checking network status..."
for port in 8545 8546 8547; do
    if wait_for_port $port; then
        echo "✅ Network on port $port is running"
    else
        echo "❌ Network on port $port failed to start within timeout"
        exit 1
    fi
done

echo ""
echo "🎯 All networks started!"
echo "   Ethereum: http://localhost:8545"
echo "   Polygon:  http://localhost:8546" 
echo "   Arbitrum: http://localhost:8547"
echo ""
echo "📝 Logs available in logs/ directory"
echo "🛑 Use './stop-networks.sh' to stop all networks" 