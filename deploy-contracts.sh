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
    
    # COMPREHENSIVE cache clearing for this network
    echo "   🧹 Clearing ALL caches for $network_name..."
    rm -rf cache/ 2>/dev/null || true
    rm -rf artifacts/ 2>/dev/null || true
    rm -rf typechain-types/ 2>/dev/null || true
    rm -rf ignition/deployments/chain-1337/ 2>/dev/null || true
    echo "   ✅ All caches cleared"
    
    # Force fresh compilation
    echo "   🔧 Compiling contracts..."
    if ! npx hardhat compile --force 2>&1; then
        echo "   ❌ Contract compilation failed"
        cd ..
        return 1
    fi
    
    # Verify our function is in compiled ABI
    if grep -q "debugBulkFundEntities" artifacts/contracts/Depository.sol/Depository.json 2>/dev/null; then
        echo "   ✅ Pre-funding function found in compiled ABI"
    else
        echo "   ❌ Pre-funding function missing from compiled ABI"
        cd ..
        return 1
    fi

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
    
    # Wait for ignition to create deployment artifacts
    local deployment_file="ignition/deployments/chain-1337/deployed_addresses.json"
    echo "   🔍 Waiting for deployment file: $deployment_file"
    local tries=0
    while [ ! -f "$deployment_file" ] && [ $tries -lt 10 ]; do
        sleep 1
        tries=$((tries+1))
        echo "   ⏳ Waiting for deployment file... (try $tries/10)"
    done
    
    # Extract Depository address from deployed_addresses.json
    local depository_address
    if [ -f "$deployment_file" ]; then
        echo "   ✅ Deployment file found, extracting addresses..."
        cat "$deployment_file"
        depository_address=$(jq -r '.["DepositoryModule#DepositoryV2"] // .["DepositoryModule#Depository"]' "$deployment_file" 2>/dev/null || true)
        echo "   🔍 Extracted Depository: $depository_address"
    else
        echo "   ❌ Deployment file not found after waiting"
    fi
    if [ -z "$depository_address" ] || [ "$depository_address" = "null" ]; then
        # Fallback to old method
        depository_address=$(echo "$depository_output" | grep -o '0x[a-fA-F0-9]\{40\}' | tail -1 || true)
        echo "   🔍 Fallback extraction: $depository_address"
    fi
    if [ -z "$depository_address" ] || [ "$depository_address" = "null" ]; then
        echo "   ❌ Could not extract Depository address"
        return 1
    fi
    echo "   ✅ Depository: $depository_address"
    
    # SKIP old verification - run R2R test instead
    echo "   🧪 Running Reserve-to-Reserve (R2R) functionality test..."
    if bunx hardhat run test-r2r-post-deployment.cjs --network "$network_config" 2>&1; then
        echo "   ✅ R2R test passed - Depository contract working correctly"
    else
        echo "   ❌ R2R test failed - Contract deployment may have issues"
        echo "   ⚠️ Continuing anyway (you can debug later)"
    fi

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

# COMMENTED OUT: Focus on Ethereum only for now
# if deploy_to_network "8546" "$NETWORK_8546"; then
#     ((success_count++))
# fi

# if deploy_to_network "8547" "$NETWORK_8547"; then
#     ((success_count++))
# fi

echo ""
echo "📊 Deployment Summary:"
echo "   ✅ Successful: $success_count/1 networks (Ethereum only)"

if [ $success_count -gt 0 ]; then
    echo ""
    echo "📍 Contract Addresses:"

    if [ -n "$CONTRACT_8545_EP" ]; then
        echo "   $NETWORK_8545 (port 8545):"
        echo "     EntityProvider: $CONTRACT_8545_EP"
        echo "     Depository: $CONTRACT_8545_DEP"
    fi

    # Update server configuration
    echo ""
    echo "🔧 Creating unified jurisdiction configuration..."
    
    # DEBUG: Show what variables we actually have (Ethereum only)
    echo "🔍 DEBUG: Contract variables before jurisdictions.json generation:"
    echo "   CONTRACT_8545_EP='$CONTRACT_8545_EP'"
    echo "   CONTRACT_8545_DEP='$CONTRACT_8545_DEP'"
    echo ""

    # Create fresh jurisdictions.json with actual deployed addresses (NO placeholders!)
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
        "entityProvider": "$CONTRACT_8545_EP",
        "depository": "$CONTRACT_8545_DEP"
      },
      "explorer": "http://localhost:8545", 
      "currency": "ETH",
      "status": "active"
    }
  },
  "defaults": {
    "timeout": 30000,
    "retryAttempts": 3,
    "gasLimit": 1000000
  }
}
EOF

    echo "   ✅ Created fresh jurisdictions.json with:"
    echo "     EntityProvider: $CONTRACT_8545_EP"
    echo "     Depository: $CONTRACT_8545_DEP"



    echo "   ✅ Unified jurisdictions configuration saved"
    echo ""
    echo "🎯 Deployment complete!"
    echo "📋 Next: Restart server to use new contracts"

else
    echo ""
    echo "❌ No successful deployments. Check network status and try again."
    exit 1
fi