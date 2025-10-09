#!/bin/bash

echo "🛑 Stopping XLN Demo Networks..."

# Kill hardhat processes
echo "🔄 Terminating hardhat nodes..."
pkill -f "hardhat node" 2>/dev/null || true

# Clean up PID files
if [ -d "pids" ]; then
    rm -f pids/*.pid
    echo "🧹 Cleaned up PID files"
fi

# Check if processes are actually stopped
sleep 2

if pgrep -f "hardhat node" > /dev/null; then
    echo "⚠️  Some hardhat processes still running, force killing..."
    pkill -9 -f "hardhat node" 2>/dev/null || true
else
    echo "✅ All networks stopped successfully"
fi

echo ""
echo "🏁 All XLN networks have been stopped"
echo "💡 Use './start-networks.sh' to restart networks" 