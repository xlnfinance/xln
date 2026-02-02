#!/bin/bash
# XLN Production Diagnostics
# Run this on production server to diagnose server issues
# Usage: ssh root@136.244.85.89 'bash -s' < scripts/diagnose-prod.sh

set -e

echo "=== XLN Production Diagnostics ==="
echo "Date: $(date)"
echo ""

echo "=== 1. Process Check ==="
echo "pm2 processes:"
pm2 list 2>/dev/null || echo "pm2 not running"
echo ""
echo "Bun processes on port 8080:"
lsof -i :8080 2>/dev/null || echo "Nothing on port 8080"
echo ""
echo "All bun processes:"
ps aux | grep -E "bun|server.ts" | grep -v grep || echo "No bun processes"
echo ""

echo "=== 2. pm2 Logs (last 50 lines) ==="
pm2 logs xln-server --lines 50 --nostream 2>/dev/null || echo "No pm2 logs"
echo ""

echo "=== 3. Environment Check ==="
cd /root/xln 2>/dev/null || { echo "ERROR: /root/xln not found"; exit 1; }
echo "Current directory: $(pwd)"
echo ""
echo "Files present:"
ls -la ecosystem.config.cjs jurisdictions.json 2>/dev/null || echo "Missing critical files"
echo ""
echo "Anvil running?"
pgrep anvil && echo "Anvil is running" || echo "Anvil NOT running"
echo ""
echo "Anvil port check:"
lsof -i :8545 2>/dev/null || echo "Nothing on port 8545"
echo ""

echo "=== 4. Try Direct Start ==="
echo "Stopping pm2..."
pm2 delete xln-server 2>/dev/null || true
pkill -f "bun.*server.ts" 2>/dev/null || true
sleep 2
echo ""
echo "Starting server directly with anvil env..."
export USE_ANVIL=true
export ANVIL_RPC=http://localhost:8545
export PATH="$HOME/.bun/bin:$PATH"
cd /root/xln

echo "Starting bun server in background..."
nohup bun runtime/server.ts --port 8080 > /tmp/xln-direct.log 2>&1 &
SERVER_PID=$!
echo "Server PID: $SERVER_PID"

echo "Waiting 10 seconds for startup..."
sleep 10

echo ""
echo "=== 5. Health Check ==="
if curl -s http://localhost:8080/api/health > /tmp/health.json 2>&1; then
    echo "SUCCESS! Server responding:"
    cat /tmp/health.json
else
    echo "FAILED - Server not responding"
    echo ""
    echo "Server log (last 100 lines):"
    tail -100 /tmp/xln-direct.log
fi
echo ""

echo "=== 6. Final Status ==="
ps aux | grep -E "bun|server.ts" | grep -v grep
echo ""
lsof -i :8080 2>/dev/null || echo "Nothing on port 8080"

echo ""
echo "=== Diagnostics Complete ==="
echo "If direct start worked but pm2 doesn't:"
echo "1. Run: pm2 delete all"
echo "2. Run: pm2 start ecosystem.config.cjs"
echo "3. Run: pm2 save"
echo ""
echo "If direct start also failed, check:"
echo "1. Is anvil running? Run: anvil &"
echo "2. Check /tmp/xln-direct.log for errors"
