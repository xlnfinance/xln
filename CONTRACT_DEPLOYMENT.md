# Contract Deployment & Browser Synchronization System

## 🎯 Overview

The XLN system now features a robust contract deployment and browser synchronization system that ensures fresh contract addresses are automatically available to both server and browser components.

## 🏗️ Architecture

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│  Deploy Script  │ ─► │  Config Files    │ ─► │  Browser/Server │
└─────────────────┘    └──────────────────┘    └─────────────────┘
                             │
                    ┌────────┼────────┐
                    │                 │
        contract-addresses.json   contract-config.js
           (Server Config)      (Browser Config)
```

## 📁 Generated Files

### `contract-addresses.json` (Server)
- JSON format for server-side Node.js consumption
- Used by `loadContractAddresses()` function
- Fallback to defaults if missing

### `contract-config.js` (Browser) 
- ES6 module for browser import
- Auto-loaded by browser with cache-busting
- Includes deployment timestamp for change detection

## 🚀 Quick Commands

### Complete Reset
```bash
./reset-networks.sh
```
- Stops all networks
- Cleans old data  
- Starts fresh networks
- Deploys contracts to all 3 networks
- Generates both config files

### Individual Operations
```bash
./start-networks.sh      # Start blockchain networks
./stop-networks.sh       # Stop all networks  
./deploy-contracts.sh    # Deploy to running networks
./dev.sh                 # Development setup check
```

## 🔧 Network Configuration

### Three Parallel Networks
- **Ethereum** (port 8545) - Primary network
- **Polygon** (port 8546) - Secondary network  
- **Arbitrum** (port 8547) - Tertiary network

### Contract Deployment
- Each network gets individual EntityProvider contract
- Addresses automatically extracted and saved
- Browser gets fresh addresses on every deployment

## 🌐 Browser Integration

### Dynamic Address Loading
```javascript
// Auto-imported in index.html
import { CONTRACT_CONFIG } from './contract-config.js';

// Usage
const address = CONTRACT_CONFIG.networks["8545"].entityProvider;
const config = getNetworkConfig("8545");
```

### Auto-Refresh System
- Detects fresh contract deployments
- Compares deployment timestamps
- Automatically refreshes browser when addresses change
- 5-second polling for deployment changes
- 10-second polling for code changes

### Fallback Strategy
```javascript
// If contract-config.js fails to load:
CONTRACT_CONFIG = {
  networks: {
    "8545": { entityProvider: "0x..." }, // defaults
    // ... other networks
  }
};
```

## 🔄 Synchronization Flow

1. **Deployment**: `./deploy-contracts.sh` runs
2. **Generation**: Creates both config files with fresh addresses
3. **Detection**: Browser polls for config changes every 5s
4. **Refresh**: Automatic browser reload when new deployment detected
5. **Loading**: Fresh page loads with new contract addresses

## 📝 Config File Examples

### Server Config (`contract-addresses.json`)
```json
{
  "networks": {
    "8545": {
      "name": "Ethereum",
      "rpc": "http://localhost:8545", 
      "chainId": 1337,
      "entityProvider": "0xa513E6E4b8f2a923D98304ec87F64353C4D5C853"
    }
  }
}
```

### Browser Config (`contract-config.js`)
```javascript
export const CONTRACT_CONFIG = {
  networks: {
    "8545": {
      name: "Ethereum",
      rpc: "http://localhost:8545",
      chainId: 1337, 
      entityProvider: "0xa513E6E4b8f2a923D98304ec87F64353C4D5C853"
    }
  },
  deployedAt: 1721316516,
  version: "abc123f"
};
```

## 🛠️ Development Workflow

### Starting Development
```bash
./dev.sh                 # Check and setup everything
bun run src/server.ts    # Start the server
open index.html          # Open in browser
```

### Fresh Deployment
```bash
./reset-networks.sh      # Complete reset
# Browser automatically refreshes with new addresses
```

### Contract-Only Redeploy
```bash
./deploy-contracts.sh    # Keep networks, redeploy contracts
# Browser detects change and refreshes in ~5 seconds
```

## 🔍 Troubleshooting

### Contract Addresses Not Loading
1. Check `contract-config.js` exists
2. Verify networks are running: `./dev.sh`
3. Redeploy contracts: `./deploy-contracts.sh`

### Browser Not Refreshing
1. Check browser console for config loading errors
2. Verify contract-config.js is accessible  
3. Check deployment timestamp in config file

### Networks Not Starting
1. Kill existing processes: `./stop-networks.sh`
2. Check ports 8545-8547 are free
3. Start fresh: `./start-networks.sh`

## 🎯 Benefits

### ✅ Simplified
- Single command: `./reset-networks.sh`
- No manual address copying
- No hardcoded addresses in browser code

### ✅ Automatic
- Browser syncs automatically
- Server loads fresh addresses
- Change detection and refresh

### ✅ Robust  
- Fallback configurations
- Error handling
- Development status checks

### ✅ Multi-Network
- Three parallel jurisdictions
- Individual contract addresses
- Cross-jurisdiction testing

## 🔮 Future Improvements

- WebSocket notifications for instant refresh
- Contract verification integration
- Multi-environment configurations (dev/staging/prod)
- Automatic contract interaction testing
- Gas optimization tracking 