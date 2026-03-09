#!/bin/bash

JURISDICTIONS_PATH="jurisdictions/jurisdictions.json"

echo "🚀 XLN Development Setup"

# Check if networks are running
echo "1️⃣ Checking network status..."
networks_running=0
for port in 8545 8546 8547; do
    if curl -s -X POST -H "Content-Type: application/json" \
       --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
       "http://localhost:$port" > /dev/null 2>&1; then
        echo "   ✅ Network on port $port is running"
        ((networks_running++))
    else
        echo "   ❌ Network on port $port is down"
    fi
done

# Start networks if needed
if [ $networks_running -lt 3 ]; then
    echo ""
    echo "2️⃣ Starting missing networks..."
    ./start-networks.sh
    echo "   ⏳ Waiting for networks to stabilize..."
    sleep 5
else
    echo ""
    echo "2️⃣ All networks are running ✅"
fi

# Check jurisdiction configuration
echo ""
echo "3️⃣ Checking jurisdiction configuration..."
if [ -f "$JURISDICTIONS_PATH" ]; then
    echo "   ✅ $JURISDICTIONS_PATH exists"
    
    # Check if contracts are deployed (get ethereum entityProvider address)
    ethereum_addr=$(jq -r '.ethereum.contracts.entityProvider // .jurisdictions.ethereum.contracts.entityProvider // "null"' "$JURISDICTIONS_PATH" 2>/dev/null)
    
    # Check for placeholder/default Hardhat addresses
    default_hardhat="0x5FbDB2315678afecb367f032d93F642f64180aa3"
    
    if [ "$ethereum_addr" = "$default_hardhat" ]; then
        echo "   ⚠️  Using default Hardhat addresses (contracts not deployed)"
        echo "   📄 Ethereum: $ethereum_addr"
        echo "   💡 Run './deploy-contracts.sh' to deploy proper contracts"
    elif [ "$ethereum_addr" != "null" ]; then
        echo "   ✅ Contracts deployed to Ethereum"
        echo "   📄 Ethereum: $ethereum_addr"
    else
        echo "   ⚠️  Contracts need deployment"
        echo "   💡 Run './deploy-contracts.sh' to deploy"
    fi
else
    echo "   ❌ $JURISDICTIONS_PATH missing"
    echo "   ⚠️  Contracts must be deployed first!"
    echo "   💡 Run './deploy-contracts.sh' to deploy and create $JURISDICTIONS_PATH"
    echo "   🚫 Cannot run server without proper contract deployments"
fi

# Check server build
echo ""
echo "4️⃣ Checking server build..."
if [ -f "dist/server.js" ]; then
    echo "   ✅ dist/server.js exists"
else
    echo "   ❌ dist/server.js missing"
    echo "   🔧 Building server..."
    npm run build 2>/dev/null || bun run build 2>/dev/null || echo "   ⚠️  Build failed - check package.json"
fi

echo ""
echo "🎯 Development Setup Complete!"
echo ""
echo "📋 Quick Commands:"
echo "   • Start server: bun run src/server.ts"
echo "   • Reset everything: ./reset-networks.sh"
echo "   • Deploy contracts: ./deploy-contracts.sh"
echo "   • Start frontend: cd frontend && npm run dev"
echo ""
echo "🌐 Available at:"
echo "   • Svelte Frontend: http://localhost:5173 (cd frontend && npm run dev)"
echo "   • Server API: http://localhost:8080 (if needed)"
echo ""
echo "🔧 Networks:"
echo "   • Ethereum: http://localhost:8545"
echo "   • Polygon: http://localhost:8546"
echo "   • Arbitrum: http://localhost:8547"
