# Hanko Bytes: Hierarchical Signature Architecture

## 🎯 **Executive Summary**

**Hanko Bytes** is a revolutionary signature system that enables any entity of arbitrary complexity to sign any hash with a single, self-contained data structure. Unlike traditional multi-signature schemes limited to flat EOA lists, Hanko supports unlimited hierarchical nesting - DAOs signing on behalf of other DAOs, with full composability and gas efficiency.

## 🏗️ **Core Innovation**

### **The Problem**
- Traditional multisig: Limited to flat EOA lists (e.g., 3-of-5 addresses)
- Enterprise needs: Complex governance (Board → Committees → Individuals)  
- Blockchain reality: Gas costs scale poorly with signature verification complexity
- Interoperability: No standard for hierarchical entity signatures across protocols

### **The Solution**
Hanko Bytes separates **signature recovery** from **hierarchical verification**:

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   EOA Layer     │    │  Hierarchy Layer │    │  Verification   │
│                 │    │                  │    │                 │
│ Raw 65b sigs    │ -> │ Bottom-up claims │ -> │ EntityProvider  │
│ Pure crypto     │    │ Voting logic     │    │ State validation│
└─────────────────┘    └──────────────────┘    └─────────────────┘
```

## 📊 **Technical Architecture**

### **Data Structure**
```solidity
struct HankoBytes {
  bytes32[] placeholders;    // Entity IDs that failed to sign (index 0..N-1)
  bytes packedSignatures;    // EOA signatures → yesEntities (index N..M-1)
  HankoClaim[] claims;       // Entity claims to verify (index M..∞)
}

struct HankoClaim {
  bytes32 entityId;          // Entity being verified
  uint256[] entityIndexes;   // Indexes covering ALL 3 stacks: placeholders[0..N-1], yesEntities[N..M-1], claims[M..∞]
  uint256[] weights;         // Voting power distribution matching entityIndexes
  uint256 threshold;         // Required voting power
  bytes32 expectedQuorumHash; // Expected quorum hash for real-time validation
}
```

### **Signature Packing Innovation**
Instead of storing 65 bytes per signature, we pack efficiently:
- **R,S values**: 32+32 bytes concatenated: `rsrsrsrs...`
- **V values**: Single byte array: `vvvvv...` (1 bit per signature + padding)
- **8 signatures**: 8×64 + 1 = 513 bytes (vs 8×65 = 520 bytes)
- **100 signatures**: 100×64 + 13 = 6413 bytes (vs 6500 bytes) = 1.34% savings

### **Verification Flow**
1. **Unpack signatures**: Extract R,S,V from packed format
2. **Recover EOA addresses**: Build `yesEntities[]` from valid signatures  
3. **Process claims bottom-up**: Start with primitive entities (pure EOAs)
4. **EntityProvider verification**: Validate quorum hashes against live state
5. **Hierarchical composition**: Each successful claim enables higher-level entities

## 🔄 **Merge-ability & Completion Tracking**

### **Hanko Merging**
During entity consensus, partial signatures can be merged:
```typescript
function mergeHankos(hanko1: HankoBytes, hanko2: HankoBytes): HankoBytes {
  // Combine unique signatures
  // Merge entity completion states  
  // Preserve claim hierarchy
}
```

### **Completion Percentage**
```typescript
function getCompletionPercentage(hanko: HankoBytes): number {
  // Calculate voting power achieved vs required
  // Account for hierarchical dependencies
  // Return 0-100% completion status
}
```

## 💡 **Key Advantages**

### **1. Unlimited Hierarchy**
```
🏢 MegaCorp DAO (3-of-5 Board)
├── 🏛️ Engineering Committee (2-of-3 Board)
│   ├── 👤 Alice (CTO)
│   ├── 👤 Bob (Lead Dev)  
│   └── 🤖 CI/CD System
├── 🏛️ Finance Committee (2-of-3 Board)
│   ├── 👤 Carol (CFO)
│   └── 🏛️ Audit Sub-Committee (2-of-2 Board)
│       ├── 👤 Dave (Auditor)
│       └── 👤 Eve (Compliance)
└── 👤 Frank (Board Member)
```

### **2. Gas Efficiency**
- **Single verification**: One call vs N nested calls
- **Packed signatures**: ~1.4% space savings scaling with signature count
- **Batch processing**: Verify multiple hankos in single transaction
- **Stateless**: No replay protection overhead

### **3. Composability**
- **Cross-protocol**: Same hanko works on any EVM chain
- **Interoperable**: Standard format for all DeFi protocols
- **Future-proof**: Extensible for new signature schemes

### **4. Security**
- **Live state verification**: Validates against current EntityProvider governance
- **Single source of truth**: One active board hash per entity (no dual power)
- **Cryptographic integrity**: Each signature mathematically verified
- **Replay protection**: Handled by consuming contracts (stateless design)

### **5. Clean Board Design**
- **Parallel arrays**: `bytes32[] entityIds` + `uint16[] votingPowers` for gas efficiency
- **Type safety**: Fixed `bytes32` vs variable `bytes` eliminates parsing errors
- **Lazy entities**: Auto-validation when `entityId == keccak256(board)` (no registration)
- **TradFi transitions**: Embedded delays prevent channel proof expiration
- **BCD governance**: Control > Board > Dividend priority hierarchy

## 🎯 **Use Cases**

### **DeFi Protocols**
- **Treasury management**: DAO → Committee → Individual approval chains
- **Risk parameters**: Multi-level approval for critical changes
- **Protocol governance**: Hierarchical approval workflows

### **Enterprise Adoption**
- **Corporate governance**: Board → Department → Individual workflows  
- **Regulatory compliance**: Multi-party approval with audit trails
- **Cross-chain operations**: Unified signature across all networks

### **Infrastructure**
- **Multisig wallets**: Beyond flat EOA limitations
- **Protocol governance**: Complex voting mechanisms
- **Identity systems**: Hierarchical delegation of authority

## 📈 **Market Opportunity**

### **Technical Metrics**
- **Gas efficiency**: Single call vs O(n) recursive verification
- **Signature density**: 1.34% space savings vs naive encoding
- **Verification complexity**: O(n) linear processing





---

**Hanko Bytes transforms signature verification from a technical constraint into an organizational superpower.** 