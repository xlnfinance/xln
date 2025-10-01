#!/bin/bash

echo "🚀 XLN CI Development Environment"
echo "   Optimized for Playwright/E2E testing"

# Note: We don't use 'set -e' because bun install warnings return non-zero
# but we handle critical errors manually

# Function to cleanup on exit
cleanup() {
    echo ""
    echo "🛑 Stopping CI services..."
    # Kill known pids written to pids/ first
    if [ -d pids ]; then
        for f in pids/*.pid; do
            [ -f "$f" ] || continue
            pid=$(cat "$f" 2>/dev/null || true)
            if [ -n "$pid" ]; then
                kill "$pid" 2>/dev/null || true
            fi
            rm -f "$f" || true
        done
    fi
    pkill -f "hardhat node" 2>/dev/null || true
    pkill -f "bun.*server" 2>/dev/null || true
    pkill -f "bunx serve" 2>/dev/null || true
}

# Set up signal handlers
trap cleanup SIGINT SIGTERM

# Parse optional arguments
RUN_CMD="${RUN_CMD:-}"
while (( "$#" )); do
    case "$1" in
        --run)
            shift
            RUN_CMD="$1"
            shift
            ;;
        --help|-h)
            echo "Usage: $0 [--run \"command\"]"
            exit 0
            ;;
        *)
            echo "Unknown argument: $1"
            exit 1
            ;;
    esac
done

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

# Polygon and Arbitrum removed

echo "⏳ Waiting for networks to initialize..."
# give processes a head start then actively wait per-port
sleep 4

# Check if networks are responding (retry up to 60s per port)
for port in 8545 8546 8547; do
    timeout=60
    echo "Checking RPC on port $port..."
    until curl -s -X POST -H "Content-Type: application/json" --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' "http://localhost:$port" > /dev/null 2>&1; do
        timeout=$((timeout-3))
        if [ $timeout -le 0 ]; then
            echo "❌ Network on port $port failed to start"
            echo "--- Last 200 lines of logs for port $port ---"
            case $port in
                8545) tail -n 200 logs/ethereum-8545.log || true ;;
            esac
            cleanup
            exit 1
        fi
        sleep 3
    done
    echo "✅ RPC responding on port $port"
done
echo "📦 Deploying contracts..."
if [ ! -x ./deploy-contracts.sh ]; then
    echo "❌ ./deploy-contracts.sh not found or not executable"
    exit 1
fi

set -x
bash ./deploy-contracts.sh
DEPLOY_RC=$?
set +x

if [ $DEPLOY_RC -ne 0 ]; then
  echo "❌ Contract deployment failed (rc=$DEPLOY_RC)"
  # helpful logs:
  tail -n 200 logs/* 2>/dev/null || true
  exit $DEPLOY_RC
fi

echo "🔨 Building TypeScript..."
bun build src/server.ts --target=browser --outdir=dist --minify --external http --external https --external zlib --external fs --external path --external crypto --external stream --external buffer --external url --external net --external tls --external os --external util || {
    echo "❌ TypeScript build failed"
    exit 1
}
cp dist/server.js frontend/static/server.js

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
    cleanup
    exit 1
fi

echo ""
echo "✅ CI Development Environment Ready!"
echo "🌐 Frontend: http://localhost:8080"
echo "🔗 Networks: 8545 (Ethereum), 8546 (Polygon), 8547 (Arbitrum)"
echo ""

# In CI mode, don't wait - let the script exit successfully
# The services will continue running in background
if [ -n "$RUN_CMD" ]; then
    echo "🧪 Running command while services are up: $RUN_CMD"
    # run the command in the same shell so child processes stay alive
    eval "$RUN_CMD"
    rc=$?
    echo "Command exited with status $rc"
    cleanup
    exit $rc
fi

# If running in CI but no RUN_CMD requested, keep compatibility with older behaviour:
if [ "$CI" = "true" ]; then
    echo "🤖 CI mode detected - services started successfully (no run command provided)"
    exit 0
fi

# For local development, wait for user interrupt
echo "💡 Press Ctrl+C to stop all services"
wait
