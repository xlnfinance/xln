# Entity System

## Overview
The entity system manages individual state machines within the network, handling transactions, state transitions, and block creation.

## Core Types

### Entity State
```typescript
interface EntityRoot {
  status: 'idle' | 'precommit' | 'commit'
  finalBlock?: EntityBlock
  consensusBlock?: EntityBlock
  entityPool: Map<string, Buffer>
}

interface EntityBlock {
  blockNumber: number
  storage: EntityStorage
  channelRoot: Buffer
  channelMap: Map<string, Buffer>
  inbox: Buffer[]
  validatorSet?: Buffer[]
}
```

### Input Types
```typescript
type EntityInput =
  | { type: 'AddEntityTx', tx: Buffer }
  | { type: 'AddChannelInput', channelId: string, input: ChannelInput }
  | { type: 'Flush' }
  | { type: 'Sync', blocks: Buffer[], signature: Buffer }
  | { type: 'Consensus', signature: Buffer, blockNumber: number }
```

## State Management

### Storage Types
```typescript
enum StorageType {
  // State types
  CURRENT_BLOCK = 0x01,
  CONSENSUS_BLOCK = 0x02,
  CHANNEL_MAP = 0x03,
  
  // Board & Validator types
  CURRENT_BOARD = 0x10,
  PROPOSED_BOARD = 0x11,
  VALIDATOR_STAKES = 0x12,
  
  // Consensus types
  PRECOMMITS = 0x20,
  VOTES = 0x21,
  
  // Padding flags for nibble alignment
  PADDING_1 = 0x81,  // 1 padding bit
  PADDING_2 = 0x82,  // 2 padding bits
  // ... up to PADDING_7
}
```

### Board Management
```typescript
interface EntityBoard {
  threshold: number
  delegates: Array<{
    entityId: Buffer  // 20 bytes for EOA, longer for nested entity
    votingPower: number
  }>
}

interface EntityConfig {
  depositoryId: Buffer    // Token/depository contract
  name: string
  board: EntityBoard
}
```

### Creation Flow
```typescript
interface CreateEntityTx {
  type: 'CreateEntity'
  config: EntityConfig
  signature: Buffer        // Depository signature
}
```

### State Transitions
1. Input validation
2. State update
3. Block creation (if needed)
4. Storage update

## Type Safety and Buffer Handling

### Buffer Conversions
```typescript
// Always use Buffer.from() for RLP encoding results
const encoded = Buffer.from(encode(data));

// When decoding, validate the result
const decoded = decode(data) as unknown;
if (!Array.isArray(decoded) || decoded.length !== expectedLength) {
  throw new Error('Invalid encoded data');
}
```

### Type Guards
```typescript
function isValidTx(input: EntityInput): input is { type: 'AddEntityTx', tx: Buffer } {
  return input.type === 'AddEntityTx' && Buffer.isBuffer(input.tx);
}
```

## ESM Compatibility

### Import/Export
```typescript
// Use .js extensions in imports
import { StorageType } from './storage/merkle.js';
import { EntityRoot } from './types/entity.js';

// Export with type annotations
export type { EntityRoot, EntityBlock };
export { executeEntityTx, createEntityBlock };
```

## Transaction Processing

## Additional Considerations

### Nested Entity Validation
- Recursive signature verification
- Support for DAO delegates
- Cycle detection in validation
- Efficient signature caching

### State Overlays
- Memory-only pending changes
- Efficient state reconstruction
- Lazy merkle computation
- Batch update support

### Recovery Mechanisms
- Rebuild from entity inbox
- Recompute merkle trees
- Recover channel states
- Resync with validators

### Commands
- Create: Initialize entity
- Increment: Update value
- Custom: Application-specific logic

### Execution Flow
1. Decode transaction
2. Execute command
3. Update storage
4. Create block (if needed)

## Testing
- Reduced test scope (10 entities)
- Random value updates
- State verification
- Block creation validation

## Known Issues and Best Practices

### Type Safety
- Always use explicit Buffer conversions
- Add type guards for runtime validation
- Validate all decoded data structures

### State Management
- Use immutable state updates
- Validate state before persistence
- Handle RLP encoding/decoding carefully

### Performance
- Cache frequently accessed state
- Batch database operations
- Use efficient encoding methods

### Error Handling
- Add descriptive error messages
- Validate inputs thoroughly
- Handle edge cases explicitly

## Known Issues
- Need better error handling for invalid transactions
- Improve transaction validation
- Add more storage types as needed 

# Recovery Procedures

## State Recovery
- Rebuild from entity inbox
- Recompute merkle trees
- Channel state recovery
- Validator resync process

## Safety Measures
- Historical block access
- Proof verification
- Signature validation
- State consistency checks

# Hanko Signature System

## Hierarchical Signature Verification
- **Hanko Bytes**: Self-contained signature system supporting unlimited hierarchy
- **Flashloan Governance**: Optimistic verification of circular dependencies  
- **Real-time Quorum Validation**: Live state verification against EntityProvider
- **Gas Optimized**: Single verification call vs recursive nested verification

## Signature Types
- **EOA signatures**: Standard secp256k1 signatures (65 bytes each)
- **Nested entity signatures**: Via Hanko claims referencing other entities
- **Packed format**: rsrsrs...vvv encoding for gas efficiency
- **Board-based validation**: Threshold voting with configurable quorum

## Board Rules
- **Configurable thresholds**: Required voting power per entity
- **Delegate voting power**: Weighted signatures based on governance
- **Real-time validation**: Current board hash verification
- **Hierarchical composition**: Bottom-up claim processing

## Integration Points
- **EntityProvider.verifyHankoSignature()**: Core verification function
- **Depository.processBatchWithHanko()**: Hanko-authorized batch processing
- **Sequential nonces**: EVM-style replay protection per entity
- **Domain separation**: EIP-712 style hash isolation

Proposer                    Validators
   |                           |
   |-- Aggregate Mempool       |
   |-- Apply Changes           |
   |   - Channel inputs        |
   |   - Entity transactions   |
   |                          |
   |-- Propose Block --------->|
   |                          |
   |<---- Precommits ---------|
   |                          |
   |-- Check Threshold        |
   |-- Finalize Block         | 