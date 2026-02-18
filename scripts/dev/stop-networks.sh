#!/bin/bash

echo "🛑 Stopping XLN Demo Networks..."

# Kill local chain processes
echo "🔄 Terminating anvil nodes..."
pkill -f "anvil --host 127.0.0.1 --port 8545" 2>/dev/null || true
pkill -f "anvil --host 0.0.0.0 --port 8545" 2>/dev/null || true

# Clean up PID files
if [ -d "pids" ]; then
    rm -f pids/*.pid
    echo "🧹 Cleaned up PID files"
fi

# Check if processes are actually stopped
sleep 2

if pgrep -f "anvil" > /dev/null; then
    echo "⚠️  Some chain processes still running, force killing..."
    pkill -9 -f "anvil" 2>/dev/null || true
else
    echo "✅ All networks stopped successfully"
fi

echo ""
echo "🏁 All XLN networks have been stopped"
echo "💡 Use './start-networks.sh' to restart networks" 
