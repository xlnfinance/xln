# Account Master Plan: Multi-Layer Consensus Architecture

**Author:** Claude Code  
**Date:** 2025-01-18  
**Status:** Implementation in Progress  

## Overview

This document outlines the comprehensive plan for implementing a multi-layered consensus architecture that enables off-chain account settlement between entities with on-chain anchoring. The system creates a hierarchy of consensus layers from smart contracts down to bilateral account agreements.

## Architecture Vision

```
┌─────────────────────────────────────────────────────────────┐
│                    SMART CONTRACT LAYER                     │
│  Depository.sol - Final settlement authority and disputes  │
└─────────────────┬───────────────────────────────────────────┘
                  │ SettlementProcessed events
                  │
┌─────────────────▼───────────────────────────────────────────┐
│                    J-MACHINE LAYER                         │
│   J-Event Watcher - Blockchain event monitoring           │
└─────────────────┬───────────────────────────────────────────┘
                  │ j_event transactions
                  │
┌─────────────────▼───────────────────────────────────────────┐
│                    E-MACHINE LAYER                         │
│   Entity Consensus - BFT consensus among validators       │
└─────────────────┬───────────────────────────────────────────┘
                  │ accountInput messages
                  │
┌─────────────────▼───────────────────────────────────────────┐
│                    A-MACHINE LAYER                         │
│   Account Machine - Bilateral consensus per account       │
└─────────────────────────────────────────────────────────────┘
```

## Layer Breakdown

### 1. Smart Contract Layer (Depository.sol)

**Purpose:** Final settlement authority and dispute resolution

**Key Components:**
- `settle()` function - processes settlement diffs between entities
- `SettlementProcessed` event - emits final values after settlement
- Settlement invariant: `leftDiff + rightDiff + collateralDiff = 0`

**Settlement Structure:**
```solidity
struct SettlementDiff {
    uint tokenId;
    int leftDiff;        // Change for left entity 
    int rightDiff;       // Change for right entity
    int collateralDiff;  // Change in collateral
    int ondeltaDiff;     // Change in ondelta
}
```

**Current Status:** ✅ COMPLETED
- settle() function implemented as public method
- SettlementProcessed event defined and emitted
- Can be called independently or via processBatch
- No ReserveUpdated events emitted (settlement events sufficient)

### 2. J-Machine Layer (J-Event Watcher)

**Purpose:** Monitor blockchain events and feed them to entity machines

**Key Components:**
- Listens for `SettlementProcessed` events from Depository
- Creates j_event transactions for both left and right entities
- Handles deduplication based on jBlock tracking

**Event Flow:**
```
SettlementProcessed(leftEntity, rightEntity, tokenId, ...)
    ↓
j_event → leftEntity (side='left', counterparty=rightEntity)
j_event → rightEntity (side='right', counterparty=leftEntity)
```

**Current Status:** ✅ COMPLETED
- SettlementProcessed event listener added
- handleSettlementProcessedEvent() feeds to both entities
- Historical event processing included
- Proper jBlock deduplication

### 3. E-Machine Layer (Entity Consensus)

**Purpose:** Byzantine Fault Tolerant consensus among entity validators

**Key Components:**
- Processes j_events via handleJEvent()
- Creates accountInput messages for a-machine
- Maintains entity state and reserves

**Settlement Event Processing:**
```typescript
if (event.type === 'SettlementProcessed') {
    // Process settlement data
    // Update entity understanding
    // Generate accountInput for a-machine ← NEXT STEP
}
```

**Current Status:** 🔄 IN PROGRESS
- SettlementProcessed j_event handler added to j-events.ts
- Message formatting completed
- Need to add accountInput generation logic

### 4. A-Machine Layer (Account Machine)

**Purpose:** Bilateral consensus between two entities for specific accounts

**Key Components:**
- Per-token delta states (based on old_src architecture)
- Account frames for state snapshots
- Bilateral agreement mechanism

**Target Architecture (from old_src):**
```typescript
interface Delta {
    tokenId: number;
    collateral: bigint;
    ondelta: bigint;      // On-chain delta
    offdelta: bigint;     // Off-chain delta  
    leftCreditLimit: bigint;
    rightCreditLimit: bigint;
    leftAllowance: bigint;
    rightAllowance: bigint;
}

interface AccountMachine {
    counterpartyEntityId: string;
    mempool: AccountTx[];
    currentFrame: AccountFrame;
    sentTransitions: number;
    deltas: Map<number, Delta>; // tokenId → Delta
    proofHeader: { cooperativeNonce: number; disputeNonce: number };
    proofBody: { tokenIds: number[]; deltas: bigint[] };
    hankoSignature?: string;
}
```

**Current Status:** ❌ PENDING
- Types defined in types.ts
- Giant per-token table needs implementation
- Bilateral consensus mechanism needed

## Implementation Roadmap

### Phase 1: Complete E→A Machine Integration ⏳ CURRENT
1. **Feed SettlementProcessed events to A-Machine**
   - Add logic in handleJEvent to create accountInput messages
   - Route settlement events to appropriate account machines
   - Ensure bilateral processing (both entities get the event)

### Phase 2: A-Machine Giant Per-Token Table 📋 NEXT
1. **Implement AccountMachine state management**
   - Add giant per-token table like old_src had
   - Map: tokenId → Delta (collateral, ondelta, offdelta, credit limits)
   - Account frame management for state snapshots

### Phase 3: UI Integration 🎨 FUTURE
1. **Update Accounts Panel**
   - List all entities with "Open Account" buttons
   - Cross-entity accountInput messaging workflow
   - Account opening creates entity-tx → outputs re-fed as accountInput

### Phase 4: End-to-End Testing 🧪 FUTURE
1. **Multi-layer consensus testing**
   - Smart contract settlement → j-watcher → e-machine → a-machine
   - Bilateral account agreement verification
   - Dispute resolution pathways

## Key Design Decisions

### 1. Event-Driven Architecture
- Each layer communicates through events/messages
- No direct coupling between layers
- Enables independent testing and development

### 2. Bilateral Consensus
- Each account has exactly two participants
- Both entities must agree on settlement
- A-machine enforces bilateral agreement

### 3. Deterministic Settlement
- Settlement invariant: total value change = 0
- Prevents value creation/destruction
- Enables trustless verification

### 4. Per-Token Granularity
- Each token has independent account state
- Supports multi-asset accounts
- Enables complex collateral arrangements

## Data Flow Example

```
1. Entities agree off-chain on settlement:
   - Entity1: -100 ETH, +10 collateral
   - Entity2: +100 ETH, -10 collateral
   - Net: 0 (invariant satisfied)

2. Hub calls Depository.settle():
   - Updates reserves: Entity1 -= 100, Entity2 += 100
   - Updates collateral: +10 Entity1, -10 Entity2
   - Emits: SettlementProcessed(Entity1, Entity2, tokenId=1, ...)

3. J-Watcher processes event:
   - Creates j_event for Entity1 (side='left')
   - Creates j_event for Entity2 (side='right')

4. E-Machine processes j_events:
   - Updates entity understanding of settlement
   - Creates accountInput messages for both entities

5. A-Machine processes accountInputs:
   - Updates bilateral account state
   - Validates settlement against credit limits
   - Updates account frame if both parties agree

6. UI shows updated account balances:
   - Per-token delta visualization
   - Collateral and credit limit status
```

## Technical Challenges & Solutions

### Challenge 1: Event Deduplication
**Problem:** Same blockchain event processed multiple times  
**Solution:** jBlock tracking in entity state prevents reprocessing

### Challenge 2: Bilateral Synchronization  
**Problem:** Both entities must process settlement events consistently  
**Solution:** J-watcher feeds identical event data to both entities with proper side marking

### Challenge 3: State Consistency
**Problem:** Multi-layer state could diverge  
**Solution:** Event sourcing with deterministic processing at each layer

### Challenge 4: Credit Limit Enforcement
**Problem:** Preventing over-extension beyond agreed limits  
**Solution:** A-machine validates all changes against Delta credit limits

## Future Enhancements

### 1. Dispute Resolution
- Escalate disagreements to smart contract layer
- Hanko signature verification for proof submission
- Automated dispute timeout mechanisms

### 2. Account Discovery
- Automatic account opening workflows
- Cross-entity account proposals
- Hub-mediated account introductions

### 3. Advanced Settlement Patterns
- Multi-hop settlements through intermediaries
- Netting across multiple accounts
- Time-locked settlement commitments

## Conclusion

This multi-layered consensus architecture provides a robust foundation for off-chain account settlement while maintaining on-chain security guarantees. The separation of concerns across layers enables:

1. **Scalability:** Most activity happens off-chain
2. **Security:** On-chain anchoring prevents disputes
3. **Flexibility:** Each layer can evolve independently
4. **Usability:** Simple UI for complex multi-party agreements

The next immediate step is completing the E→A machine integration to enable full end-to-end settlement processing.