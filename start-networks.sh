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
pushd "$CONTRACTS_DIR" >/dev/null
bun install >/dev/null 2>&1 || true
bunx hardhat node --port 8545 --hostname 0.0.0.0 > "$LOG_DIR/ethereum-8545.log" 2>&1 &
echo "$!" > "$PIDS_DIR/ethereum.pid"
popd >/dev/null

# Verify process started
if ! kill -0 "$(cat "$PIDS_DIR/ethereum.pid")" 2>/dev/null; then
  echo "❌ Failed to start Hardhat node on 8545"
  echo "----- last 50 lines of ethereum-8545.log -----"
  tail -n 50 "$LOG_DIR/ethereum-8545.log" || true
  exit 1
fi

echo "📡 Starting Polygon Network (port 8546)..."
pushd "$CONTRACTS_DIR" >/dev/null
bunx hardhat node --port 8546 --hostname 0.0.0.0 > "$LOG_DIR/polygon-8546.log" 2>&1 &
echo "$!" > "$PIDS_DIR/polygon.pid"
popd >/dev/null

if ! kill -0 "$(cat "$PIDS_DIR/polygon.pid")" 2>/dev/null; then
  echo "❌ Failed to start Hardhat node on 8546"
  echo "----- last 50 lines of polygon-8546.log -----"
  tail -n 50 "$LOG_DIR/polygon-8546.log" || true
  exit 1
fi

echo "📡 Starting Arbitrum Network (port 8547)..."
pushd "$CONTRACTS_DIR" >/dev/null
bunx hardhat node --port 8547 --hostname 0.0.0.0 > "$LOG_DIR/arbitrum-8547.log" 2>&1 &
echo "$!" > "$PIDS_DIR/arbitrum.pid"
popd >/dev/null

if ! kill -0 "$(cat "$PIDS_DIR/arbitrum.pid")" 2>/dev/null; then
  echo "❌ Failed to start Hardhat node on 8547"
  echo "----- last 50 lines of arbitrum-8547.log -----"
  tail -n 50 "$LOG_DIR/arbitrum-8547.log" || true
  exit 1
fi

echo "⏳ Waiting for networks to start..."

wait_for_port() {
  local port=$1
  local timeout=120
  local tick=0
  while [ $timeout -gt 0 ]; do
    if check_network "$port"; then
      return 0
    fi
    sleep 1
    timeout=$((timeout-1))
    tick=$((tick+1))
    if (( tick % 5 == 0 )); then
      echo "   … waiting for port $port (${timeout}s left)"
    fi
    # Every 20s, show a few lines from the log to help debug
    if (( tick % 20 == 0 )); then
      case "$port" in
        8545) LOG_FILE="$LOG_DIR/ethereum-8545.log" ;;
        8546) LOG_FILE="$LOG_DIR/polygon-8546.log" ;;
        8547) LOG_FILE="$LOG_DIR/arbitrum-8547.log" ;;
      esac
      if [ -f "$LOG_FILE" ]; then
        echo "----- last 5 lines of $(basename "$LOG_FILE") -----"
        tail -n 5 "$LOG_FILE" || true
      fi
    fi
  done
  return 1
}

# Check if networks are responding
check_network() {
    curl -s --max-time 1 -X POST -H "Content-Type: application/json" \
         --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
         http://127.0.0.1:$1 > /dev/null 2>&1
    return $?
}

# echo "🔍 Checking network status..."
# for port in 8545 8546 8547; do
#     if wait_for_port $port; then
#         echo "✅ Network on port $port is running"
#     else
#         echo "❌ Network on port $port failed to start within timeout"
#         exit 1
#     fi
# done

echo ""
echo "🎯 All networks started!"
echo "   Ethereum: http://localhost:8545"
echo "   Polygon:  http://localhost:8546"
echo "   Arbitrum: http://localhost:8547"
echo ""
echo "📝 Logs available in logs/ directory"
echo "🛑 Use './stop-networks.sh' to stop all networks"