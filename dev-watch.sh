#!/bin/bash

# Development watch script for XLN consensus debugging
# Compiles TypeScript to JavaScript on-the-fly and serves files

echo "🔄 Starting XLN development watch mode..."

# Kill any existing processes
pkill -f "bun build.*watch" || true
pkill -f "bun.*server" || true
pkill -f "fswatch" || true

# Create dist directory
mkdir -p dist

# Function to show rebuild notification
show_rebuild() {
    echo ""
    echo "🔄 $(date '+%H:%M:%S') - Rebuilding server.ts..."
    echo "⚡ Changes detected, compiling..."
}

# Function to show rebuild complete
show_rebuild_complete() {
    echo "✅ $(date '+%H:%M:%S') - Server rebuilt successfully!"
    echo "🚀 Latest version ready at http://localhost:8080"
    echo ""
}

# Start TypeScript watch compilation with enhanced logging
echo "📦 Starting TypeScript watch compilation..."

# Initial build with notification
show_rebuild
bun build src/server.ts --target browser --outfile dist/server.js
if [ $? -eq 0 ]; then
    show_rebuild_complete
else
    echo "❌ $(date '+%H:%M:%S') - Build failed!"
    echo ""
fi

# Start file watcher for continuous rebuilds
if command -v fswatch >/dev/null 2>&1; then
    # Use fswatch if available (more reliable)
    fswatch -o src/server.ts src/state-encoder.ts src/state-serde.ts src/snapshot-coder.ts 2>/dev/null | while read num; do
        show_rebuild
        bun build src/server.ts --target browser --outfile dist/server.js
        if [ $? -eq 0 ]; then
            show_rebuild_complete
        else
            echo "❌ $(date '+%H:%M:%S') - Build failed!"
            echo ""
        fi
    done &
    WATCH_PID=$!
    echo "📁 Using fswatch for file monitoring"
else
    # Fallback to bun's built-in watch with custom monitoring
    (
        bun build src/server.ts --target browser --outfile dist/server.js --watch 2>&1 | while IFS= read -r line; do
            if [[ "$line" == *"[watch]"* ]] || [[ "$line" == *"Rebuilt"* ]] || [[ "$line" == *"Built"* ]]; then
                show_rebuild_complete
            fi
        done
    ) &
    WATCH_PID=$!
    echo "📁 Using bun's built-in watch mode"
fi

# Start simple HTTP server in background
echo "🌐 Starting development server on http://localhost:8080..."
bun run -e "
const server = Bun.serve({
  port: 8080,
  fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname === '/' ? '/index.html' : url.pathname;
    
    try {
      const file = Bun.file('.' + path);
      return new Response(file);
    } catch (error) {
      return new Response('Not found', { status: 404 });
    }
  },
});
console.log('Server running on http://localhost:8080');
" &
SERVER_PID=$!

# Function to cleanup on exit
cleanup() {
    echo ""
    echo "🛑 Stopping development server..."
    kill $WATCH_PID $SERVER_PID 2>/dev/null || true
    pkill -f "fswatch" 2>/dev/null || true
    exit 0
}

# Set up signal handlers
trap cleanup SIGINT SIGTERM

echo "✅ Development environment ready!"
echo "   📦 TypeScript compilation: watching src/server.ts + dependencies"
echo "   🌐 Development server: http://localhost:8080"
echo "   📄 Open browser to see debugging interface"
echo "   🔄 Files will auto-reload on changes with timestamp notifications"
echo ""
echo "💡 Look for rebuild messages with timestamps when you save files"
echo "Press Ctrl+C to stop..."

# Wait for processes
wait $WATCH_PID $SERVER_PID 