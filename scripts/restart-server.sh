#!/bin/bash
# Simple XLN server restart script (no pm2)
# Usage: ./scripts/restart-server.sh
# Can run on prod: ssh root@136.244.85.89 'cd /root/xln && ./scripts/restart-server.sh'

set -e

cd "$(dirname "$0")/.."
export PATH="$HOME/.bun/bin:$HOME/.local/share/pnpm:/root/.foundry/bin:$PATH"

echo "=== Restarting XLN Server ==="

# Kill existing processes
echo "[1/4] Stopping existing processes..."
pm2 delete xln-server 2>/dev/null || true
pkill -f "bun.*server.ts" 2>/dev/null || true
sleep 2

# Set environment
echo "[2/4] Setting environment..."
export USE_ANVIL=true
export ANVIL_RPC=http://localhost:8545

# Check anvil
echo "[3/4] Checking anvil..."
if ! pgrep -x anvil > /dev/null; then
    echo "WARNING: Anvil not running! Starting it..."
    cd /root/xln/jurisdictions 2>/dev/null || cd jurisdictions 2>/dev/null || true
    nohup anvil --port 8545 --block-gas-limit 60000000 --code-size-limit 65536 > /tmp/anvil.log 2>&1 &
    sleep 3
    cd ..
fi

# Start server
echo "[4/4] Starting XLN server..."
mkdir -p logs
nohup bun runtime/server.ts --port 8080 > logs/xln.log 2>&1 &
SERVER_PID=$!
echo "Server started with PID: $SERVER_PID"

# Wait and verify
echo "Waiting for server startup..."
sleep 8

if curl -s http://localhost:8080/api/health > /dev/null 2>&1; then
    echo ""
    echo "=== SUCCESS ==="
    curl -s http://localhost:8080/api/health | head -c 200
    echo ""
    echo ""
    echo "Server is running at http://localhost:8080"
    echo "Logs: tail -f logs/xln.log"
else
    echo ""
    echo "=== FAILED ==="
    echo "Server not responding. Check logs:"
    tail -50 logs/xln.log
    exit 1
fi
