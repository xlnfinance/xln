# Merkle Tree System

## Overview
The Merkle tree implementation provides efficient state management with configurable parameters for optimizing performance and memory usage.

## Configuration
```typescript
interface TreeConfig {
  bitWidth: number;      // 1-16 bits per chunk (default: 4)
  leafThreshold: number; // 1-1024 entries before splitting (default: 16)
}
```

## Key Features

## Tree Layers
- Signer Layer (4-bit nibbles)
- Entity Layer (4-bit nibbles)
- Storage Layer (8-bit nibbles)

## Optimizations
- Configurable nibble sizes
- Padding flags in control bytes
- Separate trees per storage type
- Memory overlays for pending state

## Performance Targets
- Support 10k+ signers efficiently
- Handle 10k+ entities per signer
- Manage 1M+ channels per entity

### Node Structure
- Branch nodes with dynamic children
- Leaf nodes with value maps
- Automatic splitting based on threshold
- Hash caching for performance

### Path Processing
- Configurable bit width for path chunks
- Efficient path traversal
- Reduced logging verbosity for recursive operations

### Visualization
- ASCII tree representation
- Node type identification (Branch/Leaf)
- Value count display
- Truncated hash display

## Performance Considerations
- Leaf threshold affects tree depth and query performance
- Bit width impacts branching factor
- Hash caching reduces redundant calculations
- Path chunk size affects memory usage

## Usage Example
```typescript
const store = createMerkleStore({ 
  bitWidth: 4, 
  leafThreshold: 16 
});

store.updateEntityState(signerId, entityId, {
  status: 'idle',
  entityPool: new Map(),
  finalBlock: {
    blockNumber: 0,
    storage: { value: 0 },
    channelRoot: Buffer.from([]),
    channelMap: new Map(),
    inbox: []
  }
});
```

## Testing
- Reduced test data (10 signers, 10 entities each)
- Random operations for state changes
- Full tree verification
- Visual progress tracking

## Known Limitations
- Maximum bit width of 16
- Maximum leaf threshold of 1024
- Path processing overhead for deep trees 