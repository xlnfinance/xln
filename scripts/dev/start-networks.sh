#!/bin/bash

echo "🚀 Starting XLN Demo Networks (Anvil)..."

# Create directories for logs and pids first
mkdir -p logs pids

# Kill any existing local chain nodes
pkill -f "anvil --host 127.0.0.1 --port 8545" 2>/dev/null || true
pkill -f "anvil --host 0.0.0.0 --port 8545" 2>/dev/null || true

# Wait a bit for cleanup
sleep 1

# Start single Anvil node in background
echo "📡 Starting Anvil Network (port 8545, chainId=31337)..."
anvil --host 127.0.0.1 --port 8545 --chain-id 31337 --block-gas-limit 60000000 --code-size-limit 65536 > logs/ethereum-8545.log 2>&1 &
echo "$!" > pids/ethereum.pid

echo "⏳ Waiting for networks to start..."
sleep 3

# Check if networks are responding
check_network() {
    curl -s -X POST -H "Content-Type: application/json" \
         --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
         http://localhost:$1 > /dev/null 2>&1
    return $?
}

echo "🔍 Checking network status..."
if check_network 8545; then
    echo "✅ Network on port 8545 is running"
else
    echo "❌ Network on port 8545 failed to start"
    exit 1
fi

echo ""
echo "🎯 Anvil network started!"
echo "   Anvil: http://localhost:8545 (chainId=31337)"
echo ""
echo "📝 Logs available in logs/ directory"
echo "🛑 Use './stop-networks.sh' to stop all networks" 
