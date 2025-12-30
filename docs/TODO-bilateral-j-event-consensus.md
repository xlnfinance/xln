# TODO: Bilateral J-Event Consensus

## Current State (Functional but Not Byzantine-Resistant)

AccountSettled events from J-Machine are applied **unilaterally** - each entity receives event and directly updates `account.delta.collateral/ondelta` without bilateral verification (runtime/entity-tx/j-events.ts:356-397).

This works functionally but violates bilateral consensus principle.

## Required Implementation

### Pattern (Same as Entity J-Block Consensus)

```
Entity Level (DONE):
  signers[] observe j-block → jBlockObservations[] → threshold match → finalize

Account Level (TODO):
  left/right entities observe j-block → leftJObservations[]/rightJObservations[] → 2-of-2 match → finalize
```

### Flow

```
1. Alice observes AccountSettled (jHeight=12, jBlockHash=0xabc...)
   → Stores in Alice's account.leftJObservations[]
   → Creates AccountTx: { type: 'j_event_claim', data: { jHeight, jBlockHash, events } }
   → Adds to account.mempool

2. Account frame proposal processes mempool
   → Routes j_event_claim to Hub via accountInput

3. Hub receives j_event_claim from Alice
   → Handler adds to Hub's account.leftJObservations[]
   → Calls tryFinalizeAccountJEvents()

4. Hub observes same AccountSettled
   → Stores in Hub's account.rightJObservations[]
   → Creates j_event_claim → routes to Alice

5. Alice receives Hub's j_event_claim
   → Handler adds to Alice's account.rightJObservations[]
   → Calls tryFinalizeAccountJEvents()

6. tryFinalizeAccountJEvents()
   → Finds matching (jHeight=12, jBlockHash=0xabc...) in left + right
   → Verifies events identical
   → Applies to account.deltas (collateral, ondelta)
   → Adds to account.jEventChain (replay prevention)
   → Prunes observations
```

### Required Changes

**1. AccountMachine type (types.ts) - DONE**
```typescript
leftJObservations: Array<{ jHeight, jBlockHash, events, observedAt }>;
rightJObservations: Array<{ jHeight, jBlockHash, events, observedAt }>;
jEventChain: Array<{ jHeight, jBlockHash, events, finalizedAt }>;
lastFinalizedJHeight: number;
```

**2. AccountTx type (types.ts) - DONE**
```typescript
| { type: 'j_event_claim'; data: { jHeight, jBlockHash, events, observedAt } }
```

**3. AccountMachine initialization (account.ts) - DONE**
Initialize fields when creating account.

**4. applyFinalizedJEvent (j-events.ts) - PARTIAL**
- Store own observation in left/rightJObservations ✅
- Add j_event_claim to account.mempool ✅
- tryFinalizeAccountJEvents() implementation ✅
- **MISSING:** Proper routing (account.mempool doesn't automatically route to counterparty!)

**5. j_event_claim handler (account.ts) - TODO**
```typescript
// In handleAccountInput or account frame processing
if (tx.type === 'j_event_claim') {
  // Counterparty sent their observation
  const { jHeight, jBlockHash, events, observedAt } = tx.data;

  // Determine which side they are
  const theyAreLeft = counterpartyEntityId < state.entityId;

  const observation = { jHeight, jBlockHash, events, observedAt };

  if (theyAreLeft) {
    account.leftJObservations.push(observation);
  } else {
    account.rightJObservations.push(observation);
  }

  // Try finalize now that we have their observation
  tryFinalizeAccountJEvents(state, account, counterpartyEntityId);
}
```

**6. Export tryFinalizeAccountJEvents (j-events.ts) - TODO**
Make it public for account.ts to call.

## Why This Matters

**Attack Vectors Without Bilateral Consensus:**

1. **State Divergence**: If one entity's j-watcher misses event → permanent disagreement
2. **Equivocation**: Malicious j-watcher emits fake event to one entity
3. **Race Condition**: Two settlements ordered differently by different j-watchers

## Notes from Implementation Attempt

- Direct account.mempool.push() does NOT route to counterparty (stays local)
- Need to go through account frame proposal → accountInput routing
- OR use mempoolOps return pattern (requires refactoring entire call chain)
- Account transactions ARE already processed through frame consensus
- j_event_claim is just another AccountTx type (no special handling needed)

## Estimated Effort

- 2-3 hours for careful implementation
- Requires understanding account-consensus.ts frame proposal flow
- Test thoroughly with all 3 scenarios
