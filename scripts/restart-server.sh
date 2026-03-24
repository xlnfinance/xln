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
pkill -f "bun.*runtime/orchestrator/orchestrator.ts" 2>/dev/null || true
pkill -f "bun.*runtime/server.ts" 2>/dev/null || true
sleep 2

# Set environment
echo "[2/4] Setting environment..."
export USE_ANVIL=true
export ANVIL_RPC=http://localhost:8545
export PUBLIC_RPC=${PUBLIC_RPC:-https://xln.finance/rpc}
export XLN_MESH_RESET_ALLOWED=${XLN_MESH_RESET_ALLOWED:-1}

# Check anvil
echo "[3/4] Checking anvil..."
if ! pgrep -x anvil > /dev/null; then
    echo "WARNING: Anvil not running! Starting it..."
    cd /root/xln/jurisdictions 2>/dev/null || cd jurisdictions 2>/dev/null || true
    nohup anvil --port 8545 --block-gas-limit 60000000 --code-size-limit 65536 > /tmp/anvil.log 2>&1 &
    sleep 3
    cd ..
fi

# Start orchestrator
echo "[4/4] Starting XLN mesh orchestrator..."
mkdir -p logs
nohup bun runtime/orchestrator/orchestrator.ts --host 127.0.0.1 --port 8080 --public-ws-base-url ws://127.0.0.1:8080 --rpc-url http://127.0.0.1:8545 --db-root ./db/local/mesh --mm --custody --allow-reset --custody-port 8087 --custody-daemon-port 8088 --wallet-url https://localhost:8084/app > logs/xln.log 2>&1 &
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
