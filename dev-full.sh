#!/bin/bash

echo "🚀 XLN Full Development Environment"
echo "   This will reset networks, watch files, and serve the UI"
echo ""

# Inject git version info
echo "📝 Injecting git version info..."
bun run scripts/inject-version.ts
echo ""

# Function to cleanup on exit
cleanup() {
    echo ""
    echo "🛑 Stopping all development services..."
    pkill -f "vite dev" 2>/dev/null || true
    pkill -f "bun.*server" 2>/dev/null || true
    pkill -f "bun build.*watch" 2>/dev/null || true
    pkill -f "tsc.*watch" 2>/dev/null || true
    pkill -f "svelte-check.*watch" 2>/dev/null || true
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
echo "🔍 CRITICAL: TypeScript validation (BLOCKS development on errors)..."

# FAIL-FAST: Block development if TypeScript errors exist
echo "🔍 Validating /src TypeScript (STRICT MODE)..."
if ! bun x tsc --noEmit --project .; then
    echo ""
    echo "❌ DEVELOPMENT BLOCKED: /src has TypeScript errors"
    echo "💡 Fix all TypeScript errors before starting development"
    echo "💡 Run: bun run check:src"
    exit 1
fi
echo "✅ /src TypeScript validation passed"

echo "🔍 Validating /frontend Svelte components (STRICT MODE)..."
if ! (cd frontend && bun run check); then
    echo ""
    echo "❌ DEVELOPMENT BLOCKED: Frontend has TypeScript/Svelte errors"
    echo "💡 Fix all component errors before starting development"
    echo "💡 Run: bun run check:frontend"
    exit 1
fi
echo "✅ Frontend validation passed"

echo ""
echo "🎉 ALL TYPESCRIPT VALIDATION PASSED - Starting development servers..."

# Step 2: Start file watching in background
mkdir -p dist
mkdir -p frontend/static

echo "🔍 Starting continuous TypeScript checking for /src..."
bun x tsc --noEmit --watch --project . &
SRC_TS_PID=$!

echo "🔍 Starting continuous TypeScript checking for /frontend..."
(cd frontend && bun run check:watch) &
FRONTEND_TS_PID=$!

# Build server once for frontend (use same command as build.sh)
echo "📦 Building server for frontend..."
bun build src/server.ts --target=browser --outdir=dist --minify --external http --external https --external zlib --external fs --external path --external crypto --external stream --external buffer --external url --external net --external tls --external os --external util
cp dist/server.js frontend/static/server.js

# FINTECH PIPELINE: Test browser compatibility immediately
echo "🧪 CRITICAL: Testing browser bundle compatibility..."
if ! node -e "
try {
  const fs = require('fs');
  const bundle = fs.readFileSync('frontend/static/server.js', 'utf8');
  if (bundle.includes('require(\"http\")') || bundle.includes('import \"http\"') || bundle.includes('from \"http\"')) {
    console.error('❌ CRITICAL: server.js contains Node.js http module - will crash in browser');
    process.exit(1);
  }
  if (bundle.includes('require(\"fs\")') || bundle.includes('import \"fs\"') || bundle.includes('from \"fs\"')) {
    console.error('❌ CRITICAL: server.js contains Node.js fs module - will crash in browser');
    process.exit(1);
  }
  console.log('✅ Browser bundle compatibility verified');
} catch (e) {
  console.error('❌ Bundle validation failed:', e.message);
  process.exit(1);
}
"; then
    echo "❌ DEVELOPMENT BLOCKED: server.js contains Node.js modules"
    echo "💡 Fix: Add proper --target=browser polyfills"
    echo "💡 Check: vite.config.ts resolve.alias settings"
    exit 1
fi

# Copy fresh jurisdictions to frontend
cp jurisdictions.json frontend/static/jurisdictions.json

# Watch ONLY src/server.ts for changes (NEVER touch jurisdictions.json)
echo "📦 Starting server watch (ONLY src/server.ts)..."
echo "   ⚠️  NOTE: This will ONLY rebuild server.js when src/server.ts changes"
echo "   ⚠️  NOTE: jurisdictions.json is NEVER overwritten by this watcher"
echo "   🔧 NOTE: Using same build command as build.sh for consistency"
bun build src/server.ts --target=browser --outdir=dist --minify --external http --external https --external zlib --external fs --external path --external crypto --external stream --external buffer --external url --external net --external tls --external os --external util --watch &
WATCH_PID=$!
# Note: Auto-copy handled by bun build --watch to dist, then manual copy

echo "🌐 Starting Svelte development server..."

# Step 3: Start Svelte dev server in background
(cd frontend && bun --bun run dev) &
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

# Wait for all processes (this keeps the script running)
wait $SRC_TS_PID $FRONTEND_TS_PID $WATCH_PID $SERVE_PID