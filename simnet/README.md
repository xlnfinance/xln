# Simnet - XLN Simulation Network

**In-browser blockchain environment powered by @ethereumjs/vm**

## Purpose

Simnet is XLN's offline testing ground - a complete blockchain running in your browser with zero external dependencies.

## Features

- ✅ **Offline**: No localhost:8545, no cloud RPC, works on airplane
- ✅ **Instant Reset**: Refresh page = new economy
- ✅ **Deterministic**: Same genesis every time (perfect for tutorials)
- ✅ **Persistent**: Optional IndexedDB storage (resume sessions)
- ✅ **Fast**: 1ms blocks, instant finality

## Configuration

**genesis.json** - Initial state:
- Network params (chainId, gasLimit, blockTime)
- Contract deployments (DepositorySimple)
- Prefunded accounts (deployer)
- Entity prefunding (500 entities × 2 tokens)

## Usage

```typescript
import { browserVMProvider } from '../view/utils/browserVMProvider';

// Initialize simnet
await browserVMProvider.init(); // Uses genesis.json

// Query state
const reserves = await browserVMProvider.getReserves('0x01', 1);

// Execute operations
await browserVMProvider.debugFundReserves('0x05', 1, 1000000n);
```

## Persistence

State saves to IndexedDB automatically:
- `xln-simnet-state` - VM state (blocks, receipts, storage)
- Survives page refresh
- Export/import for sharing

## Comparison to Real Networks

| Feature | Simnet | Testnet | Mainnet |
|---------|--------|---------|---------|
| Speed | 1ms blocks | ~12s | ~12s |
| Cost | Free | Free | $$$ |
| Reset | Instant | Never | Never |
| Shared | No | Yes | Yes |
| Risk | Zero | Zero | High |

## Advanced

**Custom Genesis:**
```javascript
import customGenesis from './my-genesis.json';
await browserVMProvider.init({ genesis: customGenesis });
```

**Export State:**
```javascript
const state = await browserVMProvider.exportState();
localStorage.setItem('my-simulation', JSON.stringify(state));
```

**Import State:**
```javascript
const state = JSON.parse(localStorage.getItem('my-simulation'));
await browserVMProvider.importState(state);
```

## Future: Multi-Network Tabs

```
[Simnet] [Testnet (Sepolia)] [Mainnet (Ethereum)]
   ↑          ↓                      ↓
Local    Shared state          Production
```

Same UI, different data source. Switch with one click.
