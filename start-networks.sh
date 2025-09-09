#!/bin/bash

echo "🚀 Starting XLN Demo Networks..."

# Create directories for logs and pids first
mkdir -p logs pids

# Kill any existing hardhat nodes
pkill -f "hardhat node" 2>/dev/null || true

# Wait a bit for cleanup
sleep 1

# Start three hardhat nodes in background
echo "📡 Starting Ethereum Network (port 8545)..."
cd contracts && npx hardhat node --port 8545 --hostname 127.0.0.1 > ../logs/ethereum-8545.log 2>&1 &
echo "$!" > ../pids/ethereum.pid

echo "📡 Starting Polygon Network (port 8546)..."
cd contracts && npx hardhat node --port 8546 --hostname 127.0.0.1 > ../logs/polygon-8546.log 2>&1 &
echo "$!" > ../pids/polygon.pid

echo "📡 Starting Arbitrum Network (port 8547)..."
cd contracts && npx hardhat node --port 8547 --hostname 127.0.0.1 > ../logs/arbitrum-8547.log 2>&1 &
echo "$!" > ../pids/arbitrum.pid

cd ..

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
for port in 8545 8546 8547; do
    if check_network $port; then
        echo "✅ Network on port $port is running"
    else
        echo "❌ Network on port $port failed to start"
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