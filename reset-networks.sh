#!/bin/bash

echo "🔄 Resetting XLN Network (Ethereum only) and Redeploying Contracts..."

# Stop existing networks
echo "1️⃣ Stopping existing networks..."
./scripts/dev/stop-networks.sh

# Clean up old data
echo ""
echo "2️⃣ Cleaning up old data..."
rm -rf jurisdictions/ignition/deployments/* 2>/dev/null || true
rm -rf jurisdictions/cache/ 2>/dev/null || true
rm -rf jurisdictions/artifacts/ 2>/dev/null || true
rm -rf jurisdictions/typechain-types/ 2>/dev/null || true
rm -rf logs/*.log 2>/dev/null || true
rm -rf db 2>/dev/null || true
echo "✅ Cleanup complete (cleared ignition, hardhat cache, artifacts)"

# Start fresh networks
echo ""
echo "3️⃣ Starting fresh networks..."
./scripts/dev/start-networks.sh

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
    echo "✅ Ethereum network running with fresh contracts"
    echo "📋 Contract addresses saved to jurisdictions.json"
    echo ""
    echo "🚀 Next steps:"
    echo "   • Run: bun run runtime/runtime.ts"
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