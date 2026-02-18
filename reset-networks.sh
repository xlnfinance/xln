#!/bin/bash

echo "🔄 Resetting XLN Network (Ethereum only) and Redeploying Contracts..."

echo "1️⃣ Full clean slate..."
./scripts/dev/clean-slate.sh

echo ""
echo "2️⃣ Cleaning contract build/deploy artifacts..."
rm -rf jurisdictions/ignition/deployments/* 2>/dev/null || true
rm -rf jurisdictions/cache/ 2>/dev/null || true
rm -rf jurisdictions/artifacts/ 2>/dev/null || true
rm -rf jurisdictions/typechain-types/ 2>/dev/null || true
echo "✅ Contract artifacts cleaned"

# Start fresh networks
echo ""
echo "3️⃣ Starting fresh network..."
./scripts/dev/start-networks.sh

# Wait for networks to stabilize
echo ""
echo "4️⃣ Waiting for network to stabilize..."
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
