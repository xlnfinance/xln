#!/bin/bash

set -e

# Resolve paths relative to this script to be robust in any CWD (e.g., CI)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "🚀 XLN Full Development Environment"
echo "   This will reset networks, watch files, and serve the UI"
echo ""

# Function to cleanup on exit
cleanup() {
    echo ""
    echo "🛑 Stopping all development services..."
    pkill -f "bun build.*watch" 2>/dev/null || true
    pkill -f "bun.*server" 2>/dev/null || true
    pkill -f "fswatch" 2>/dev/null || true
    pkill -f "bunx serve" 2>/dev/null || true
    "$SCRIPT_DIR/stop-networks.sh" 2>/dev/null || true
    exit 0
}

# Set up signal handlers
trap cleanup SIGINT SIGTERM

# Step 1: Auto-reset networks and redeploy
echo "🔄 Auto-resetting networks and redeploying contracts..."
"$SCRIPT_DIR/reset-networks.sh"
if [ $? -ne 0 ]; then
    echo "❌ Network reset failed!"
    exit 1
fi

echo ""
echo "📦 Starting TypeScript watch compilation..."

# Step 2: Start file watching in background
mkdir -p "$SCRIPT_DIR/dist"
mkdir -p "$SCRIPT_DIR/frontend/static"

# Start TypeScript watch compilation - build to frontend/static so vite can serve it
(cd "$SCRIPT_DIR" && bun build src/server.ts --target browser --outfile frontend/static/server.js --watch --bundle &)
WATCH_PID=$!

# Wait a moment for initial build
sleep 2

echo "🌐 Starting Svelte development server..."
(cd "$SCRIPT_DIR/frontend" && bun run dev)
SERVER_STATUS=$?

# Step 3: Start Svelte dev server in FOREGROUND (so Ctrl+C stops it)
echo ""
echo "✅ Full Development Environment Ready!"
echo ""
echo "🌐 Open: http://localhost:8080 (Svelte frontend)"
echo "🌐 API: http://localhost:8080 (unified on same port)"
echo "📦 TypeScript: Auto-compiling on file changes"
echo "🔗 Networks: Running on ports 8545, 8546, 8547"
echo "📝 Contracts: Fresh deployment completed"
echo ""
echo "💡 Press Ctrl+C to stop everything"
echo ""

echo "🛑 Dev server exited (code: $SERVER_STATUS). Stopping watcher and networks..."
kill "$WATCH_PID" 2>/dev/null || true
wait "$WATCH_PID" 2>/dev/null || true

"$SCRIPT_DIR/stop-networks.sh" 2>/dev/null || true
exit $SERVER_STATUS
