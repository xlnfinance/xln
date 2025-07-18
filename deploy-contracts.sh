#!/bin/bash

echo "📝 Deploying EntityProvider contracts to all networks..."

# Create deployment log directory
mkdir -p logs deployments

# Network configurations (using simple variables instead of associative arrays)
NETWORK_8545="Ethereum"
NETWORK_8546="Polygon" 
NETWORK_8547="Arbitrum"

# Store contract addresses in files
CONTRACT_8545=""
CONTRACT_8546=""
CONTRACT_8547=""

deploy_to_network() {
    local port=$1
    local network_name=$2
    local network_config=""
    
    # Map port to network config name
    case $port in
        8545) network_config="ethereum" ;;
        8546) network_config="polygon" ;;
        8547) network_config="arbitrum" ;;
        *) echo "   ❌ Unknown port: $port"; return 1 ;;
    esac
    
    local rpc_url="http://localhost:$port"
    
    echo ""
    echo "🔄 Deploying to $network_name (port $port)..."
    
    # Check if network is available
    if ! curl -s -X POST -H "Content-Type: application/json" \
         --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
         "$rpc_url" > /dev/null 2>&1; then
        echo "   ❌ Network not available at $rpc_url"
        return 1
    fi
    
    cd contracts
    
    # Deploy EntityProvider using simple hardhat script
    echo "   🔧 Running deployment script..."
    local deploy_output=$(npx hardhat run scripts/deploy-entity-provider.js \
                         --network "$network_config" 2>&1)
    
    local deploy_status=$?
    echo "$deploy_output" > "../logs/deploy-$port.log"
    
    if [ $deploy_status -eq 0 ] && echo "$deploy_output" | grep -q "DEPLOYED_ADDRESS="; then
        # Extract contract address from deployment output
        local contract_address=$(echo "$deploy_output" | grep "DEPLOYED_ADDRESS=" | cut -d'=' -f2)
        
        if [ -n "$contract_address" ]; then
            echo "   ✅ $network_name: $contract_address"
            
            # Save address to file for reference
            echo "$contract_address" > "../deployments/entityprovider-$port.addr"
            
            # Store in variable for later use
            case $port in
                8545) CONTRACT_8545="$contract_address" ;;
                8546) CONTRACT_8546="$contract_address" ;;
                8547) CONTRACT_8547="$contract_address" ;;
            esac
        else
            echo "   ⚠️  Deployed successfully but couldn't extract address"
            echo "   📋 Full output saved to logs/deploy-$port.log"
        fi
    else
        echo "   ❌ Deployment failed (exit code: $deploy_status)"
        echo "   📋 Check logs/deploy-$port.log for details"
        cd ..
        return 1
    fi
    
    cd ..
    return 0
}

# Deploy to all networks
success_count=0

if deploy_to_network "8545" "$NETWORK_8545"; then
    ((success_count++))
fi

if deploy_to_network "8546" "$NETWORK_8546"; then
    ((success_count++))
fi

if deploy_to_network "8547" "$NETWORK_8547"; then
    ((success_count++))
fi

echo ""
echo "📊 Deployment Summary:"
echo "   ✅ Successful: $success_count/3 networks"

if [ $success_count -gt 0 ]; then
    echo ""
    echo "📍 Contract Addresses:"
    
    if [ -n "$CONTRACT_8545" ]; then
        echo "   $NETWORK_8545 (port 8545): $CONTRACT_8545"
    fi
    if [ -n "$CONTRACT_8546" ]; then
        echo "   $NETWORK_8546 (port 8546): $CONTRACT_8546"
    fi
    if [ -n "$CONTRACT_8547" ]; then
        echo "   $NETWORK_8547 (port 8547): $CONTRACT_8547"
    fi
    
    # Update server configuration
    echo ""
    echo "🔧 Creating contract configuration..."
    
    # Create a contract addresses file that server can read
    cat > contract-addresses.json << EOF
{
  "networks": {
    "8545": {
      "name": "Ethereum",
      "rpc": "http://localhost:8545",
      "chainId": 1337,
      "entityProvider": "${CONTRACT_8545:-"0x9A676e781A523b5d0C0e43731313A708CB607508"}"
    },
    "8546": {
      "name": "Polygon", 
      "rpc": "http://localhost:8546",
      "chainId": 1337,
      "entityProvider": "${CONTRACT_8546:-"0x9A676e781A523b5d0C0e43731313A708CB607508"}"
    },
    "8547": {
      "name": "Arbitrum",
      "rpc": "http://localhost:8547", 
      "chainId": 1337,
      "entityProvider": "${CONTRACT_8547:-"0x9A676e781A523b5d0C0e43731313A708CB607508"}"
    }
  }
}
EOF

    # Create a browser-compatible JavaScript config file
    cat > contract-config.js << EOF
// Auto-generated contract configuration
// Generated on: $(date)
export const CONTRACT_CONFIG = {
  networks: {
    "8545": {
      name: "Ethereum",
      rpc: "http://localhost:8545",
      chainId: 1337,
      entityProvider: "${CONTRACT_8545:-"0x9A676e781A523b5d0C0e43731313A708CB607508"}"
    },
    "8546": {
      name: "Polygon", 
      rpc: "http://localhost:8546",
      chainId: 1337,
      entityProvider: "${CONTRACT_8546:-"0x9A676e781A523b5d0C0e43731313A708CB607508"}"
    },
    "8547": {
      name: "Arbitrum",
      rpc: "http://localhost:8547", 
      chainId: 1337,
      entityProvider: "${CONTRACT_8547:-"0x9A676e781A523b5d0C0e43731313A708CB607508"}"
    }
  },
  deployedAt: $(date +%s),
  version: "$(git rev-parse --short HEAD 2>/dev/null || echo 'unknown')"
};

// Helper function to get contract address by port
export const getContractAddress = (port) => {
  return CONTRACT_CONFIG.networks[port]?.entityProvider;
};

// Helper function to get network config by port
export const getNetworkConfig = (port) => {
  return CONTRACT_CONFIG.networks[port];
};
EOF
    
    echo "   ✅ Contract addresses saved to contract-addresses.json"
    echo ""
    echo "🎯 Deployment complete!"
    echo "📋 Next: Restart server to use new contracts"
    
else
    echo ""
    echo "❌ No successful deployments. Check network status and try again."
    exit 1
fi 