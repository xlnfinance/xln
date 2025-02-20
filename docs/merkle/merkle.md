# Storage Implementation

## Core Types

### MerkleNode
- nibbles: number[]
- value?: NodeValue
- hash?: Buffer
- children?: Map<number, MerkleNode>
- padding?: number (1-7 for byte alignment)

### StorageType
- CURRENT_BLOCK = 0x01
- CONSENSUS_BLOCK = 0x02
- CHANNEL_MAP = 0x03
- CURRENT_BOARD = 0x10
- PROPOSED_BOARD = 0x11
- VALIDATOR_STAKES = 0x12
- PRECOMMITS = 0x20
- VOTES = 0x21
- PADDING_1-7 = 0x81-0x87

### Layer Configuration
- SIGNER: 4-bit nibbles (16 branches)
- ENTITY: 4-bit nibbles (16 branches)
- STORAGE: 8-bit nibbles (256 branches)

## Required Features

1. Nibble Operations
   - Convert buffers to nibbles
   - Handle different sizes (2,4,8 bits)
   - Manage padding and alignment

2. Tree Operations
   - Lazy hash computation
   - Batch merkle updates
   - Memory overlays for changes

3. Debug Support
   - tree: merkle tree operations
   - node: node manipulation
   - nibble: nibble conversions
   - storage: state updates

## Implementation Steps

1. Core Structure
   - MerkleNode implementation
   - StorageType handling
   - Nibble size configuration

2. Operations
   - Node manipulation
   - Hash computation
   - Batch updates

3. Testing
   - Nibble conversion
   - Tree operations
   - Performance benchmarks

## Testing Requirements

1. Basic Tests
   - Nibble conversion
   - Node operations
   - Hash computation

2. Integration Tests
   - Full tree operations
   - Storage type handling
   - Layer interaction

3. Performance Tests
   - Large tree handling
   - Batch update speed
   - Memory usage

## Next Steps

1. Implement core merkle.ts
2. Add comprehensive tests
3. Create debug utilities