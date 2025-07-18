#!/bin/bash

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

# Check contract configuration
echo ""
echo "3️⃣ Checking contract configuration..."
if [ -f "contract-config.js" ]; then
    echo "   ✅ contract-config.js exists"
    
    # Check if addresses look deployed (not all the same)
    ethereum_addr=$(grep -A5 '"8545"' contract-config.js | grep entityProvider | cut -d'"' -f4)
    polygon_addr=$(grep -A5 '"8546"' contract-config.js | grep entityProvider | cut -d'"' -f4)
    
    if [ "$ethereum_addr" != "$polygon_addr" ]; then
        echo "   ✅ Contracts appear to be individually deployed"
    else
        echo "   ⚠️  Contracts might need redeployment (all same address)"
        echo "   💡 Run './deploy-contracts.sh' to redeploy"
    fi
else
    echo "   ❌ contract-config.js missing"
    echo "   🔧 Creating fallback configuration..."
    
    # Create a basic fallback config
    cat > contract-config.js << 'EOF'
// Fallback contract configuration for development
export const CONTRACT_CONFIG = {
  networks: {
    "8545": {
      name: "Ethereum",
      rpc: "http://localhost:8545",
      chainId: 1337,
      entityProvider: "0x5FbDB2315678afecb367f032d93F642f64180aa3"
    },
    "8546": {
      name: "Polygon", 
      rpc: "http://localhost:8546",
      chainId: 1337,
      entityProvider: "0x5FbDB2315678afecb367f032d93F642f64180aa3"
    },
    "8547": {
      name: "Arbitrum",
      rpc: "http://localhost:8547", 
      chainId: 1337,
      entityProvider: "0x5FbDB2315678afecb367f032d93F642f64180aa3"
    }
  },
  deployedAt: 0,
  version: "fallback"
};

export const getContractAddress = (port) => {
  return CONTRACT_CONFIG.networks[port]?.entityProvider;
};

export const getNetworkConfig = (port) => {
  return CONTRACT_CONFIG.networks[port];
};
EOF
    
    echo "   ✅ Fallback config created"
    echo "   💡 Run './deploy-contracts.sh' for fresh deployments"
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
echo "   • Open UI: open index.html"
echo ""
echo "🌐 Available at:"
echo "   • Main UI: index.html"
echo "   • Svelte UI: svelte.html"
echo "   • Gemini UI: gemini.html"
echo ""
echo "🔧 Networks:"
echo "   • Ethereum: http://localhost:8545"
echo "   • Polygon: http://localhost:8546"
echo "   • Arbitrum: http://localhost:8547" 