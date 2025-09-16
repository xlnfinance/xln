#!/usr/bin/env bash
set -u
set -o pipefail
IFS=$'\n\t'

echo "📝 Deploying EntityProvider contracts to all networks..."

# Create deployment log directory
mkdir -p logs

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

    # Check if network is available, retry for up to 30s
    local tries=0
    local max_tries=10
    local ok=1
    while [ $tries -lt $max_tries ]; do
        if curl -s -X POST -H "Content-Type: application/json" \
             --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
             "$rpc_url" > /dev/null 2>&1; then
            ok=0
            break
        fi
        tries=$((tries+1))
        sleep 3
    done
    if [ $ok -ne 0 ]; then
        echo "   ❌ Network not available at $rpc_url after $((max_tries*3))s"
        return 1
    fi

    cd contracts

    # Ensure logs directory exists
    mkdir -p ../logs

    # Verify script exists before attempting deployment
    if [ ! -f "scripts/deploy-entity-provider.cjs" ]; then
        echo "   ❌ scripts/deploy-entity-provider.cjs not found in $(pwd)"
        echo "   📂 Contents of scripts directory:"
        ls -la scripts/ || echo "   scripts/ directory not found"
        cd ..
        return 1
    fi

    # Deploy both EntityProvider and Depository
    echo "   🔧 Deploying EntityProvider..."
    # Run deployment and capture logs
    if ! entityprovider_output=$(bunx hardhat run scripts/deploy-entity-provider.cjs --network "$network_config" 2>&1); then
        echo "   ❌ EntityProvider deployment failed"
        echo "$entityprovider_output"
        echo "$entityprovider_output" > "../logs/deploy-entityprovider-$port.log" 2>/dev/null || true
        cd ..
        return 1
    fi
    echo "$entityprovider_output" > "../logs/deploy-entityprovider-$port.log" 2>/dev/null || true

    if ! echo "$entityprovider_output" | grep -q "DEPLOYED_ADDRESS="; then
        echo "   ❌ EntityProvider deployment did not return DEPLOYED_ADDRESS"
        cd ..
        return 1
    fi
    # Extract EntityProvider address
    local entityprovider_address
    entityprovider_address=$(echo "$entityprovider_output" | grep "DEPLOYED_ADDRESS=" | cut -d'=' -f2)
    echo "   ✅ EntityProvider: $entityprovider_address"

    echo "   🔧 Deploying Depository..."
    # Deploy Depository using ignition; accept prompts if any
    if ! depository_output=$(printf "y\n" | bunx hardhat ignition deploy ignition/modules/Depository.cjs --network "$network_config" 2>&1); then
        echo "   ❌ Depository deployment failed"
        echo "$depository_output"
        echo "$depository_output" > "../logs/deploy-depository-$port.log" 2>/dev/null || true
        cd ..
        return 1
    fi
    echo "$depository_output" > "../logs/deploy-depository-$port.log" 2>/dev/null || true
    # Extract final address from Hardhat Ignition output (last line with 0x address)
    local depository_address
    depository_address=$(echo "$depository_output" | grep -o '0x[a-fA-F0-9]\{40\}' | tail -1 || true)
    if [ -z "$depository_address" ]; then
        echo "   ❌ Could not extract Depository address"
        return 1
    fi
    echo "   ✅ Depository: $depository_address"

    # Store both addresses in variables for later use
    case $port in
        8545)
            CONTRACT_8545_EP="$entityprovider_address"
            CONTRACT_8545_DEP="$depository_address"
            ;;
        8546)
            CONTRACT_8546_EP="$entityprovider_address"
            CONTRACT_8546_DEP="$depository_address"
            ;;
        8547)
            CONTRACT_8547_EP="$entityprovider_address"
            CONTRACT_8547_DEP="$depository_address"
            ;;
    esac

    echo "   ✅ $network_name deployment complete"

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

    if [ -n "$CONTRACT_8545_EP" ]; then
        echo "   $NETWORK_8545 (port 8545):"
        echo "     EntityProvider: $CONTRACT_8545_EP"
        echo "     Depository: $CONTRACT_8545_DEP"
    fi
    if [ -n "$CONTRACT_8546_EP" ]; then
        echo "   $NETWORK_8546 (port 8546):"
        echo "     EntityProvider: $CONTRACT_8546_EP"
        echo "     Depository: $CONTRACT_8546_DEP"
    fi
    if [ -n "$CONTRACT_8547_EP" ]; then
        echo "   $NETWORK_8547 (port 8547):"
        echo "     EntityProvider: $CONTRACT_8547_EP"
        echo "     Depository: $CONTRACT_8547_DEP"
    fi

    # Update server configuration
    echo ""
    echo "🔧 Creating unified jurisdiction configuration..."

    # Create unified jurisdictions.json with actual deployed addresses
    cat > jurisdictions.json << EOF
{
  "version": "1.0.0",
  "lastUpdated": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "jurisdictions": {
    "ethereum": {
      "name": "Ethereum",
      "chainId": 1337,
      "rpc": "http://localhost:8545",
      "contracts": {
        "entityProvider": "${CONTRACT_8545_EP:-"NOT_DEPLOYED"}",
        "depository": "${CONTRACT_8545_DEP:-"NOT_DEPLOYED"}"
      },
      "explorer": "http://localhost:8545",
      "currency": "ETH",
      "status": "${CONTRACT_8545_EP:+active}"
    },
    "polygon": {
      "name": "Polygon",
      "chainId": 1337,
      "rpc": "http://localhost:8546",
      "contracts": {
        "entityProvider": "${CONTRACT_8546_EP:-"NOT_DEPLOYED"}",
        "depository": "${CONTRACT_8546_DEP:-"NOT_DEPLOYED"}"
      },
      "explorer": "http://localhost:8546",
      "currency": "MATIC",
      "status": "${CONTRACT_8546_EP:+active}"
    },
    "arbitrum": {
      "name": "Arbitrum",
      "chainId": 1337,
      "rpc": "http://localhost:8547",
      "contracts": {
        "entityProvider": "${CONTRACT_8547_EP:-"NOT_DEPLOYED"}",
        "depository": "${CONTRACT_8547_DEP:-"NOT_DEPLOYED"}"
      },
      "explorer": "http://localhost:8547",
      "currency": "ETH",
      "status": "${CONTRACT_8547_EP:+active}"
    }
  },
  "defaults": {
    "timeout": 30000,
    "retryAttempts": 3,
    "gasLimit": 1000000
  }
}
EOF



    echo "   ✅ Unified jurisdictions configuration saved"
    echo ""
    echo "🎯 Deployment complete!"
    echo "📋 Next: Restart server to use new contracts"

else
    echo ""
    echo "❌ No successful deployments. Check network status and try again."
    exit 1
fi