#!/bin/bash
# Frontend-only dev (no blockchain) - useful if you just want to work on UI

echo "🎨 Starting Frontend-Only Development"
echo "   (No blockchain - using mock data)"
echo ""

# Check if deps installed
if [ ! -d "node_modules" ]; then
    echo "📦 Installing dependencies..."
    bun install
fi

# Set flag to skip blockchain features
export NO_BLOCKCHAIN=1

echo "🌐 Starting Vite..."
bun --bun run dev

