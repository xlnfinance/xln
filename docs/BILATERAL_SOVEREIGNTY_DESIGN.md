# XLN Bilateral Sovereignty Architecture

## Problem Statement

Current `server.ts` implements global consensus pattern - all entity communication routes through central coordinator. This violates bilateral sovereignty principle and creates artificial bottlenecks.

## Solution: Three-Layer Separation

### J-Machine (Jurisdiction Layer)
**Purpose**: Public truth, reserves, dispute resolution
**Scope**: Blockchain events only
**Communication**: J-events bubble UP from blockchain to entities

```typescript
interface JMachine {
  // Only handles blockchain state
  blockHeight: number;
  reserves: Map<string, bigint>;      // entityId -> reserve amount
  collateral: Map<string, bigint>;    // channelId -> collateral

  // NO entity-to-entity routing
  // NO consensus coordination
  // NO message passing
}
```

### E-Machine (Entity Layer)
**Purpose**: Sovereign entity operations
**Scope**: Direct entity-to-entity communication
**Communication**: Bilateral channels between entities

```typescript
interface EMachine {
  entityId: string;

  // Direct channels to other entities (no global coordinator)
  channels: Map<string, EntityChannel>;  // targetEntityId -> channel

  // Local state only
  state: EntityState;
  accounts: Map<string, AccountMachine>;  // Per-counterparty accounts
}

interface EntityChannel {
  targetEntityId: string;
  outgoingMessages: EntityMessage[];     // Messages TO target
  incomingMessages: EntityMessage[];     // Messages FROM target
  lastSyncHeight: number;
}
```

### A-Machine (Account Layer)
**Purpose**: Bilateral financial channels
**Scope**: Already correctly implemented in `account-consensus.ts`
**Communication**: Direct bilateral consensus (ondelta/offdelta)

```typescript
// ALREADY CORRECT - no changes needed
interface AccountMachine {
  deltas: Map<number, Delta>;  // tokenId -> Delta
  // Bilateral consensus between two entities
}
```

## Implementation Plan

### 1. Remove Global Coordinator
- **Delete**: Central message routing in `server.ts`
- **Delete**: Global mempool merging
- **Keep**: J-machine blockchain event processing only

### 2. Implement Direct Entity Channels
- **Add**: `EntityChannel` for direct entity-to-entity communication
- **Add**: P2P message delivery (no central server)
- **Add**: Per-entity message queues

### 3. Separate Concerns
- **J-Machine**: Only blockchain events → entities
- **E-Machine**: Only entity ↔ entity direct channels
- **A-Machine**: Only bilateral account consensus (unchanged)

## Message Flow (New Architecture)

```
Blockchain → J-Machine → Individual Entities
                ↓
Entity A ←→ EntityChannel ←→ Entity B
    ↓              ↓
AccountMachine ←→ AccountMachine
(A's view)     (B's view)
```

## Key Benefits

1. **True Scalability**: N×(N-1) bilateral channels vs 1 global bottleneck
2. **Sovereignty**: Each entity controls its own state
3. **Fault Isolation**: Entity failures don't cascade
4. **Parallelism**: All entity-pairs can process simultaneously

## Migration Strategy

1. **Phase 1**: Extract J-machine blockchain processing
2. **Phase 2**: Add EntityChannel direct communication
3. **Phase 3**: Remove global coordinator routing
4. **Phase 4**: Test bilateral sovereignty end-to-end

## Critical Insight

> "Organizations are state machines, not contracts. Sovereignty is bilateral, not global."

The current global coordinator treats entities like nodes in a consensus network. But entities ARE sovereign organizations that should communicate directly, not through a shared coordinator.

This isn't about optimizing consensus - it's about implementing organizational physics where bilateral relationships are the fundamental primitive.