#!/bin/bash

echo "🚀 XLN Consensus Visual Debugger - Development Mode"
echo "👁️  Watching for changes in src/server-browser.ts..."

# Initial build
./build-browser.sh

# Watch for changes and rebuild
while true; do
    # Watch for changes in the source file
    if [[ "src/server-browser.ts" -nt "dist/server-browser.js" ]]; then
        echo "🔄 Source changed, rebuilding..."
        ./build-browser.sh
    fi
    
    # Wait 1 second before checking again
    sleep 1
done 