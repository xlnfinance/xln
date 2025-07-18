#!/bin/bash

echo "🔄 Resetting XLN Networks and Redeploying Contracts..."

# Stop existing networks
echo "1️⃣ Stopping existing networks..."
./stop-networks.sh

# Clean up old data
echo ""
echo "2️⃣ Cleaning up old data..."
rm -rf contracts/ignition/deployments/* 2>/dev/null || true
rm -rf logs/*.log 2>/dev/null || true
rm -rf deployments/*.addr 2>/dev/null || true
rm -f contract-addresses.json 2>/dev/null || true
rm -rf xln-snapshots 2>/dev/null || true
echo "✅ Cleanup complete"

# Start fresh networks  
echo ""
echo "3️⃣ Starting fresh networks..."
./start-networks.sh

# Wait for networks to stabilize
echo ""
echo "4️⃣ Waiting for networks to stabilize..."
sleep 5

# Deploy contracts using dedicated script
echo ""
echo "5️⃣ Deploying contracts..."
./deploy-contracts.sh

if [ $? -eq 0 ]; then
    echo ""
    echo "🎉 Network reset complete!"
    echo ""
    echo "✅ All networks are running with fresh contracts"
    echo "📋 Contract addresses saved to contract-addresses.json"
    echo ""
    echo "🚀 Next steps:"
    echo "   • Run: bun run src/server.ts"
    echo "   • Open: index.html" 
    echo "   • Test: Create entities and check Jurisdictions tab"
    echo ""
    echo "📝 View logs: ls -la logs/"
else
    echo ""
    echo "❌ Contract deployment failed!"
    echo "📋 Check logs for details and try again"
    exit 1
fi 