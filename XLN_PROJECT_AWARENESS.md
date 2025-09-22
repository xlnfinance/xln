# XLN Project Awareness: J/E/A Architecture

## Executive Summary

XLN implements a trilayer financial architecture with **bilateral sovereignty** as the fundamental primitive. Each layer (J/E/A) is sovereign with specific responsibilities, enabling infinite scale without global consensus bottlenecks.

## Architecture Overview

### J-Machine (Jurisdiction Layer)
**File:** `src/j-machine.ts`
**Purpose:** Blockchain event processing and public truth
**Scope:**
- Tracks blockchain events (reserves, collateral, disputes)
- Processes events into EntityInputs with type `j_event`
- Maintains reserve balances from on-chain deposits
- NO entity-to-entity routing
- NO consensus coordination

**Key Interfaces:**
```typescript
interface JMachineState {
  blockHeight: number;
  reserves: Map<string, bigint>;      // entityId -> reserves
  collateral: Map<string, bigint>;    // channelId -> collateral
  disputes: Map<string, DisputeState>;
}
```

### E-Machine (Entity Layer)
**File:** `src/entity-channel.ts`
**Purpose:** Direct entity-to-entity communication
**Scope:**
- Bilateral channels between entities
- Point-to-point message delivery
- NO global coordinator
- Each entity maintains channels to other entities

**Key Interfaces:**
```typescript
interface EntityChannel {
  localEntityId: string;
  remoteEntityId: string;
  outgoingMessages: EntityMessage[];
  incomingMessages: EntityMessage[];
  nextOutgoingSeq: number;
  connectionStatus: 'connected' | 'disconnected' | 'syncing';
}
```

### A-Machine (Account Layer)
**File:** `src/account-consensus.ts`
**Purpose:** Bilateral financial consensus
**Scope:**
- Manages ondelta/offdelta state between entity pairs
- Executes bilateral consensus without global ordering
- Handles direct payments and channel updates

**Key Interfaces:**
```typescript
interface AccountMachine {
  deltas: Map<number, Delta>;  // tokenId -> Delta
  // Delta = ondelta + offdelta (public + private components)
}
```

## Critical Insights

### 1. Server.ts is NOT Consensus
The `server.ts` file is **just routing infrastructure**. It:
- Routes messages between entities
- Manages the tick-based processing loop
- Does NOT implement global consensus
- Does NOT create bottlenecks

### 2. Bilateral Sovereignty at Account Level
- Each AccountMachine is a **bilateral state machine** between two entities
- No global state coordination required
- Entities can process in parallel without synchronization
- Scale: N×(N-1) bilateral channels vs 1 global bottleneck

### 3. Message Flow Architecture
```
Blockchain Events
      ↓
   J-Machine (processes events)
      ↓
   j_event EntityInputs
      ↓
   Entity (receives j_events)
      ↕ (bilateral channels)
   Entity (peer entities)
      ↓
   AccountMachine (bilateral consensus)
```

### 4. No Global Coordinator Pattern
Traditional (WRONG):
```
Entity A → Coordinator → Entity B
         ← Coordinator ←
```

XLN (CORRECT):
```
Entity A ←→ Direct Channel ←→ Entity B
    ↓                            ↓
AccountMachine            AccountMachine
(A's view)                (B's view)
```

## Implementation Status

### ✅ Working
- J-Machine blockchain event processing
- Entity-to-entity routing (fixed with dynamic signer discovery)
- Account opening between entities
- Bilateral channel creation
- Single-signer entity execution

### 🚧 Integration Points
- J-event watcher for real blockchain events (currently mocked)
- P2P networking for actual entity-to-entity communication
- Dispute resolution flow through J-Machine

## Key Files

### Core Architecture
- `/src/j-machine.ts` - Jurisdiction layer (blockchain events)
- `/src/entity-channel.ts` - Entity communication layer
- `/src/account-consensus.ts` - Account bilateral consensus
- `/src/server.ts` - Message routing infrastructure

### Entity Transaction Handlers
- `/src/entity-tx/handlers/account.ts` - Account operations
- `/src/entity-tx/handlers/j-event.ts` - Jurisdiction event processing
- `/src/entity-tx/apply.ts` - Transaction application logic

### Tests
- `/src/test-j-e-a-clean.ts` - Complete J→E→A flow test
- `/test-routing.ts` - Entity routing verification

## Architecture Principles

1. **Sovereignty is Bilateral**: No entity depends on global consensus
2. **Channels are First-Class**: Direct communication without intermediaries
3. **State is Local**: Each entity maintains its own state
4. **Consensus is Pairwise**: Only the two parties in a channel need to agree
5. **Scale is Horizontal**: Add entities without affecting existing channels

## Recent Fixes

### Entity-to-Entity Routing (FIXED)
**Problem:** AccountInput messages were addressed to 'system' signer which doesn't exist
**Solution:** Dynamically find target entity's actual signer from env.replicas
```typescript
// Find a signer for the target entity from the replicas
let targetSignerId = 's1'; // Default fallback
for (const [key, replica] of env.replicas) {
  if (key.startsWith(`${entityTx.data.targetEntityId}:`)) {
    targetSignerId = replica.signerId;
    break;
  }
}
```

### Async/Await Bug (FIXED)
**Problem:** handleAccountInput was synchronous but being awaited, causing infinite loop
**Solution:** Removed await when calling the synchronous function

## Next Steps

1. **Production Readiness**
   - Implement real blockchain event watchers
   - Add P2P networking layer for entity channels
   - Implement dispute resolution through J-Machine

2. **Performance Optimization**
   - Batch j-events for efficiency
   - Implement channel state compression
   - Add message deduplication

3. **Security Hardening**
   - Add signature verification for entity messages
   - Implement replay protection
   - Add rate limiting for channels

## Conclusion

XLN's J/E/A architecture achieves true bilateral sovereignty by separating concerns:
- **J** provides objective truth from blockchain
- **E** enables sovereign entity communication
- **A** implements bilateral financial consensus

This separation enables infinite horizontal scale without the bottlenecks of global consensus systems.