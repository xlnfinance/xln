#!/bin/bash

echo "🔨 Building XLN Consensus for Browser..."

# Create dist directory
mkdir -p dist

# Build the browser-compatible version using bun
echo "📦 Bundling src/server-browser.ts..."
bun build src/server-browser.ts \
    --outdir dist \
    --outfile server-browser.js \
    --format esm \
    --target browser \
    --minify

if [ $? -eq 0 ]; then
    echo "✅ Build successful!"
    echo "📁 Output: dist/server-browser.js"
    echo "🌐 Ready for browser import!"
else
    echo "❌ Build failed!"
    exit 1
fi 