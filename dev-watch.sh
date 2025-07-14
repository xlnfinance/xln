#!/bin/bash

# Development watch script for XLN consensus debugging
# Compiles TypeScript to JavaScript on-the-fly and serves files

echo "🔄 Starting XLN development watch mode..."

# Kill any existing processes
pkill -f "bun build.*watch" || true
pkill -f "bun.*server" || true

# Create dist directory
mkdir -p dist

# Start TypeScript watch compilation in background
echo "📦 Starting TypeScript watch compilation..."
bun build src/server.ts --target browser --outfile dist/server.js --watch &
BUILD_PID=$!

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
    echo "🛑 Stopping development server..."
    kill $BUILD_PID $SERVER_PID 2>/dev/null || true
    exit 0
}

# Set up signal handlers
trap cleanup SIGINT SIGTERM

echo "✅ Development environment ready!"
echo "   📦 TypeScript compilation: watching src/server.ts"
echo "   🌐 Development server: http://localhost:8080"
echo "   📄 Open browser to see debugging interface"
echo "   🔄 Files will auto-reload on changes"
echo ""
echo "Press Ctrl+C to stop..."

# Wait for processes
wait $BUILD_PID $SERVER_PID 