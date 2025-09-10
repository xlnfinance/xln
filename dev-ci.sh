#!/bin/bash

echo "🚀 XLN CI Development Environment"
echo "   Optimized for Playwright/E2E testing"

# Note: We don't use 'set -e' because bun install warnings return non-zero
# but we handle critical errors manually

# Function to cleanup on exit
cleanup() {
    echo ""
    echo "🛑 Stopping CI services..."
    pkill -f "hardhat node" 2>/dev/null || true
    pkill -f "bun.*server" 2>/dev/null || true
    pkill -f "bunx serve" 2>/dev/null || true
    exit 0
}

# Set up signal handlers
trap cleanup SIGINT SIGTERM

# Create necessary directories
mkdir -p dist
mkdir -p frontend/static
mkdir -p logs
mkdir -p pids

# echo "🔧 Building contracts..."
# cd contracts
# bun install --silent || echo "⚠️  Warning: bun install had warnings (continuing...)"
# bunx hardhat compile --quiet
# cd ..

echo "🚀 Starting networks..."
# Start networks in background with logging
(cd contracts && bunx hardhat node --port 8545 --hostname 0.0.0.0) > logs/ethereum-8545.log 2>&1 &
ETHEREUM_PID=$!
echo $ETHEREUM_PID > pids/ethereum.pid

(cd contracts && bunx hardhat node --port 8546 --hostname 0.0.0.0) > logs/polygon-8546.log 2>&1 &
POLYGON_PID=$!
echo $POLYGON_PID > pids/polygon.pid

(cd contracts && bunx hardhat node --port 8547 --hostname 0.0.0.0) > logs/arbitrum-8547.log 2>&1 &
ARBITRUM_PID=$!
echo $ARBITRUM_PID > pids/arbitrum.pid

echo "⏳ Waiting for networks to initialize..."
sleep 8

# Check if networks are responding
for port in 8545 8546 8547; do
    if ! curl -s -X POST -H "Content-Type: application/json" --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' http://localhost:$port > /dev/null; then
        echo "❌ Network on port $port failed to start"
        exit 1
    fi
done

echo "📦 Deploying contracts..."
if [ ! -x ./deploy-contracts.sh ]; then
    echo "❌ ./deploy-contracts.sh not found or not executable"
    exit 1
fi
./deploy-contracts.sh || {
    echo "❌ Contract deployment failed"
    exit 1
}

echo "🔨 Building TypeScript..."
bun build src/server.ts --target browser --outfile frontend/static/server.js --bundle || {
    echo "❌ TypeScript build failed"
    exit 1
}

echo "🌐 Starting frontend server..."
cd frontend
bun install --silent || echo "⚠️  Warning: frontend bun install had warnings (continuing...)"
bun run dev --host 0.0.0.0 --port 8080 > ../logs/frontend.log 2>&1 &
FRONTEND_PID=$!
echo $FRONTEND_PID > ../pids/frontend.pid
cd ..

echo "⏳ Waiting for frontend to be ready..."
timeout=60
while [ $timeout -gt 0 ]; do
    if curl -f http://localhost:8080 > /dev/null 2>&1; then
        echo "✅ Frontend server is ready on port 8080!"
        break
    fi
    sleep 2
    timeout=$((timeout-2))
done

if [ $timeout -le 0 ]; then
    echo "❌ Frontend failed to start within 60 seconds"
    cat logs/frontend.log || true
    exit 1
fi

echo ""
echo "✅ CI Development Environment Ready!"
echo "🌐 Frontend: http://localhost:8080"
echo "🔗 Networks: 8545 (Ethereum), 8546 (Polygon), 8547 (Arbitrum)"
echo ""

# In CI mode, don't wait - let the script exit successfully
# The services will continue running in background
if [ "$CI" = "true" ]; then
    echo "🤖 CI mode detected - services started successfully"
    exit 0
fi

# For local development, wait for user interrupt
echo "💡 Press Ctrl+C to stop all services"
wait
