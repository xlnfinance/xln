#!/bin/bash

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
    ./stop-networks.sh 2>/dev/null || true
    exit 0
}

# Set up signal handlers
trap cleanup SIGINT SIGTERM

# Step 1: Reset networks (if requested)
read -p "🔄 Reset networks and redeploy contracts? (y/N): " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo "🔄 Resetting networks..."
    ./reset-networks.sh
    if [ $? -ne 0 ]; then
        echo "❌ Network reset failed!"
        exit 1
    fi
else
    echo "⏭️  Skipping network reset"
    # Just ensure networks are running
    ./start-networks.sh
fi

echo ""
echo "📦 Starting TypeScript watch compilation..."

# Step 2: Start file watching in background
mkdir -p dist

# Start TypeScript watch compilation
bun build src/server.ts --target browser --outfile dist/server.js --watch &
WATCH_PID=$!

# Wait a moment for initial build
sleep 2

echo "🌐 Starting development server..."

# Step 3: Start HTTP server in background  
bunx serve . -p 8080 &
SERVE_PID=$!

# Wait for server to start
sleep 1

echo ""
echo "✅ Full Development Environment Ready!"
echo ""
echo "🌐 Open: http://localhost:8080"
echo "📦 TypeScript: Auto-compiling on file changes"
echo "🔗 Networks: Running on ports 8545, 8546, 8547"
echo "📝 Contracts: Fresh deployment completed"
echo ""
echo "💡 All services running - Press Ctrl+C to stop everything"
echo ""

# Wait for processes (this keeps the script running)
wait $WATCH_PID $SERVE_PID 