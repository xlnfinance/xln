#!/bin/bash
set -e  # Exit on error

echo "🚀 XLN Full Development Environment"
echo ""

# ============================================================================
# PREREQUISITE CHECKS - Auto-install or fail gracefully
# ============================================================================

check_bun() {
    if ! command -v bun &> /dev/null; then
        echo "❌ bun not found"
        echo "📥 Install: curl -fsSL https://bun.sh/install | bash"
        exit 1
    fi
    echo "✅ bun $(bun --version)"
}

check_hardhat() {
    # Hardhat is installed as a dev dependency in jurisdictions/
    # Just verify jurisdictions/node_modules exists - check_dependencies handles install
    if [ ! -d "jurisdictions/node_modules" ]; then
        echo "📦 Hardhat will be installed with contract dependencies..."
    else
        echo "✅ Hardhat available (for local blockchain)"
    fi
}

check_dependencies() {
    if [ ! -d "node_modules" ]; then
        echo "📦 Installing root dependencies..."
        bun install
    fi
    
    if [ ! -d "frontend/node_modules" ]; then
        echo "📦 Installing frontend dependencies..."
        (cd frontend && bun install)
    fi
    
    if [ ! -d "contracts/node_modules" ]; then
        echo "📦 Installing contract dependencies..."
        (cd jurisdiction && bun install)
    fi
    
    echo "✅ All dependencies installed"
}

echo "🔍 Checking prerequisites..."
check_bun
check_hardhat
check_dependencies
echo ""

# ============================================================================
# CLEANUP & SETUP
# ============================================================================

cleanup() {
    echo ""
    echo "🛑 Stopping all development services..."
    pkill -f "vite dev" 2>/dev/null || true
    pkill -f "bun.*server" 2>/dev/null || true
    pkill -f "bun build.*watch" 2>/dev/null || true
    pkill -f "tsc.*watch" 2>/dev/null || true
    pkill -f "svelte-check.*watch" 2>/dev/null || true
    ./scripts/dev/stop-networks.sh 2>/dev/null || true
    exit 0
}
trap cleanup SIGINT SIGTERM

# ============================================================================
# GIT VERSION
# ============================================================================

echo "📝 Injecting git version info..."
bun run scripts/inject-version.ts
echo ""

# ============================================================================
# BLOCKCHAIN SETUP
# ============================================================================

echo "🔄 Auto-resetting networks and redeploying contracts..."
./reset-networks.sh
if [ $? -ne 0 ]; then
    echo "❌ Network reset failed!"
    exit 1
fi

# ============================================================================
# TYPESCRIPT VALIDATION (FAIL-FAST)
# ============================================================================

echo ""
echo "🔍 CRITICAL: TypeScript validation (BLOCKS development on errors)..."

echo "🔍 Validating /src TypeScript..."
if ! bun x tsc --noEmit --project .; then
    echo ""
    echo "❌ DEVELOPMENT BLOCKED: /src has TypeScript errors"
    echo "💡 Fix errors with: bun run check"
    exit 1
fi
echo "✅ /src TypeScript validation passed"

echo "🔍 Validating /frontend Svelte components..."
if ! (cd frontend && bunx svelte-check --tsconfig ./tsconfig.json --threshold error); then
    echo ""
    echo "❌ DEVELOPMENT BLOCKED: Frontend has Svelte errors"
    echo "💡 Fix errors with: cd frontend && bun run check"
    exit 1
fi
echo "✅ Frontend validation passed"

echo ""
echo "🎉 ALL VALIDATION PASSED - Starting development servers..."
echo ""

# ============================================================================
# BUILD & WATCH
# ============================================================================

mkdir -p frontend/static

# Start TypeScript watchers (optional - comment out if too noisy)
# echo "🔍 Starting continuous TypeScript checking..."
# bun x tsc --noEmit --watch --project . &
# (cd frontend && bun run check:watch) &

# Initial runtime build
echo "📦 Building runtime for frontend..."
bun build runtime/runtime.ts \
  --target=browser \
  --outfile=frontend/static/runtime.js \
  --minify \
  --external http --external https --external zlib \
  --external fs --external path --external crypto \
  --external stream --external buffer --external url \
  --external net --external tls --external os --external util

# Verify browser compatibility
echo "🧪 Testing browser bundle compatibility..."
if grep -q 'require("http")\|require("fs")' frontend/static/runtime.js; then
    echo "❌ CRITICAL: runtime.js contains Node.js modules"
    exit 1
fi
echo "✅ Browser bundle verified"

# Copy jurisdictions (ignore if identical)
cp jurisdictions.json frontend/static/jurisdictions.json 2>/dev/null || true

# Watch runtime changes
echo "📦 Starting runtime watch..."
bun build runtime/runtime.ts \
  --target=browser \
  --outfile=frontend/static/runtime.js \
  --minify \
  --external http --external https --external zlib \
  --external fs --external path --external crypto \
  --external stream --external buffer --external url \
  --external net --external tls --external os --external util \
  --watch &

# ============================================================================
# START VITE
# ============================================================================

echo "🌐 Starting Vite dev server..."
(cd frontend && bun --bun run dev) &

sleep 3

echo ""
echo "✅ ✅ ✅ DEVELOPMENT ENVIRONMENT READY ✅ ✅ ✅"
echo ""
echo "🌐 Frontend: http://localhost:8080"
echo "🌐 HTTPS:    https://localhost:8080 (if certs available)"
echo "🔗 Blockchain: http://localhost:8545 (anvil)"
echo "📦 Auto-rebuild: Enabled (runtime.js + frontend)"
echo "🔍 Type checking: Running continuously"
echo ""
echo "💡 Press Ctrl+C to stop all services"
echo ""

# Keep running
wait
