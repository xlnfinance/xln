#!/bin/bash

echo "🚀 Quick XLN Development (no network reset)"
echo "   Starting file watcher and server..."

# Function to cleanup on exit
cleanup() {
    echo ""
    echo "🛑 Stopping development services..."
    pkill -f "bunx serve" 2>/dev/null || true
    pkill -f "dev-watch" 2>/dev/null || true
    exit 0
}

trap cleanup SIGINT SIGTERM

# Start file watcher in background
./dev-watch.sh &
WATCH_PID=$!

# Wait for TypeScript to build initially
sleep 3

# Start HTTP server
echo "🌐 Starting HTTP server on port 8080..."
bunx serve . -p 8080 &
SERVE_PID=$!

sleep 1

echo ""
echo "✅ Quick Development Ready!"
echo "🌐 Open: http://localhost:8080"
echo "📦 Auto-compilation: ON"
echo ""
echo "💡 Press Ctrl+C to stop"

# Keep script running
wait $WATCH_PID $SERVE_PID 