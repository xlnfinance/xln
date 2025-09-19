#!/bin/bash

echo "🚀 XLN Full Development Environment"
echo "   This will reset networks, watch files, and serve the UI"
echo ""

# Function to cleanup on exit
cleanup() {
    echo ""
    echo "🛑 Stopping all development services..."
    pkill -f "vite dev" 2>/dev/null || true
    pkill -f "bun.*server" 2>/dev/null || true
    pkill -f "bun build.*watch" 2>/dev/null || true
    ./stop-networks.sh 2>/dev/null || true
    exit 0
}

# Set up signal handlers
trap cleanup SIGINT SIGTERM

# Step 1: Auto-reset networks and redeploy
echo "🔄 Auto-resetting networks and redeploying contracts..."
./reset-networks.sh
if [ $? -ne 0 ]; then
    echo "❌ Network reset failed!"
    exit 1
fi

echo ""
echo "📦 Starting TypeScript watch compilation..."

# Step 2: Start file watching in background
mkdir -p dist
mkdir -p frontend/static

# Build server once for frontend
echo "📦 Building server for frontend..."
bun build src/server.ts --target browser --outfile frontend/static/server.js --bundle

# Copy fresh jurisdictions to frontend
cp jurisdictions.json frontend/static/jurisdictions.json

# Watch ONLY src/server.ts for changes (NEVER touch jurisdictions.json)
echo "📦 Starting server watch (ONLY src/server.ts)..."
echo "   ⚠️  NOTE: This will ONLY rebuild server.js when src/server.ts changes"
echo "   ⚠️  NOTE: jurisdictions.json is NEVER overwritten by this watcher"
bun build src/server.ts --target browser --outfile frontend/static/server.js --bundle --watch &
WATCH_PID=$!

echo "🌐 Starting Svelte development server..."

# Step 3: Start Svelte dev server in background
cd frontend && bun run dev &
SERVE_PID=$!

# Wait for server to start
sleep 3

echo ""
echo "✅ Full Development Environment Ready!"
echo ""
echo "🌐 Open: http://localhost:8080 (Svelte frontend)"
echo "🌐 API: http://localhost:8080 (unified on same port)"
echo "📦 TypeScript: Auto-compiling on file changes"
echo "🔗 Networks: Running on ports 8545, 8546, 8547"
echo "📝 Contracts: Fresh deployment completed"
echo ""
echo "💡 All services running - Press Ctrl+C to stop everything"
echo ""

# Wait for both processes (this keeps the script running)
wait $WATCH_PID $SERVE_PID