# RJEA Architecture: Runtime → Entity → Account → Jurisdiction

**Runtime-Entity-Account-Jurisdiction** is XLN's four-layer consensus architecture for deterministic, debuggable financial state machines.

## 🎯 Core Design Goals

### 1. Determinism (Same Inputs → Same Outputs, Always)
```
(prevState, inputs) → nextState  // Pure function, no randomness
```

**Why:** Financial systems must be replayable for audits, dispute resolution, and testing.

**How:**
- ✅ Use `env.timestamp` (controlled), never `Date.now()` (wall clock)
- ✅ Use deterministic PRNG with seed, never `Math.random()`
- ✅ Use tick-based delays (`env.timestamp` checks), never `setTimeout`
- ✅ Sort all loops/maps for deterministic ordering

**Example Bug:** J-event finalization used `Date.now()` → replay gave different results → fixed by adding `env` parameter.

### 2. Debuggability (Every State Transition Visible)
```
Frame N → [transactions] → Frame N+1
   ↓                           ↓
Snapshot                   Snapshot  (time-travel debugging)
```

**Why:** When consensus fails, you need to see EXACTLY which transaction at which height caused divergence.

**How:**
- ✅ Snapshot every frame (env.frames)
- ✅ Log every state mutation
- ✅ Preserve frame history (last 10 frames per account)
- ✅ Emit events at key transitions

**Example Bug:** Bilateral finalization happened on clone (invisible!) → fixed by skipping during validation.

### 3. Hierarchy (Clear Containment, No Leaky Abstractions)

```
Runtime (Orchestrator)
  ↓ contains
Entity (BFT Consensus - 2-of-3 validators)
  ↓ contains
Account (Bilateral - 2-of-2 agreement)
  ↓ settles on
Jurisdiction (Blockchain - final truth)
```

**Why:** Separation of concerns. Entity failures don't corrupt Account state. Account disputes don't break Entity consensus.

**How:**
- Runtime orchestrates, never mutates Entity/Account state directly
- Entities contain accounts, never reach into Jurisdiction internals
- Accounts are bilateral islands - no cross-account dependencies
- Jurisdiction is terminal settlement layer (immutable blockchain)

---

## 📦 Message Passing: Tx/Input/Frame Similarity

**All layers use same pattern:** Propose → Validate → Commit

| Layer | Transaction | Input (Batch) | Frame (Snapshot) |
|-------|-------------|---------------|------------------|
| **Runtime** | RuntimeTx | RuntimeInput | RuntimeFrame |
| **Entity** | EntityTx | EntityInput | EntityFrame |
| **Account** | AccountTx | AccountInput | AccountFrame |
| **Jurisdiction** | JTx | JInput | JBlock |

### Pattern: Pure Events (MempoolOps)

```typescript
// Handler (pure function)
function handlePayment(state, payment): {
  newState: State,           // Cloned and modified
  mempoolOps: [{             // Pure events (not yet applied)
    accountId: 'alice',
    tx: { type: 'htlc_lock', data: {...} }
  }]
}

// Orchestrator (applies pure events)
for (const { accountId, tx } of mempoolOps) {
  account.mempool.push(tx);  // Apply after all handlers run
}
```

**Why:** Handlers stay pure (testable, deterministic). Orchestrator controls when/how state mutates.

**Example Bug:** J-event handler called tryFinalizeAccountJEvents directly → finalized on clone → fixed by returning mempoolOps instead.

---

## 🔄 Bilateral Consensus Pattern (Account Layer)

**Analogy:** Two people balancing a checkbook together. Both must agree on every entry before it's final.

### Flow

```
Alice (LEFT entity)              Hub (RIGHT entity)
     |                                |
1. Propose frame h1                   |
   (txs: [payment -$100])            |
     |-------- frame h1 ------------>|
     |                           2. Validate frame h1
     |                              (re-execute txs on clone)
     |                              (verify state hash matches)
     |<-------- ACK h1 --------------|
3. Commit frame h1                   3. Commit frame h1
   (re-execute on real state)        (already done during validation)
   (clear pendingFrame)
     |                                |
4. Check mempool                  4. Check mempool
   (has new tx? batch with ACK)      (has new tx? batch with ACK)
```

### Key Invariants

**One Frame at a Time:** Account can have max 1 `pendingFrame` (waiting for ACK). New frames blocked until ACK received.

**Exception:** BATCH-OPTIMIZATION (Channel.ts pattern) allows batching ACK + new frame in SAME message:
```typescript
// Receive their frame h2
response = {
  height: 2,
  prevSignatures: [ACK_FOR_h2],  // ACK their frame
  newAccountFrame: our_h3,        // AND propose our next frame
  counter: 3
}
```

**Non-Blocking Duplex:** Both sides can have pendingFrames simultaneously (different heights). LEFT-WINS tiebreaker resolves collisions deterministically.

---

## ⚠️ Common Pitfalls (Lessons from This Session)

### Pitfall 1: Finalization on Validation Clone

**Bug Pattern:**
```typescript
// WRONG
function validateFrame(frame) {
  const clone = cloneAccountMachine(accountMachine);
  processTransactions(clone);  // Modifies clone (lockBook, deltas, etc.)
  // Clone discarded here!
}

function commitFrame(frame) {
  processTransactions(accountMachine);  // Different state → different result!
}
```

**Fix: `isValidation` Parameter**
```typescript
function processAccountTx(..., isValidation: boolean) {
  if (!isValidation) {
    // Only update persistent state during commit
    tryFinalizeAccountJEvents(...);
    accountMachine.locks.set(lockId, lock);
  }
}
```

**Impact:** R2C bilateral J-event consensus, HTLC lockBook, swap offers all required this fix.

### Pitfall 2: Double State Cloning

**Bug Pattern:**
```typescript
// Entity layer
for (const entityTx of entityTxs) {
  const { newState } = await applyEntityTx(entityState, entityTx);  // Clone #1
  entityState = newState;
}

// Handler layer
function handleAccountInput(entityState, input) {
  const newState = cloneEntityState(entityState);  // Clone #2 (unnecessary!)
  // Mutations to newState lost between sequential calls!
}
```

**Fix:**
```typescript
// Handler uses state directly (already cloned at entity level)
function handleAccountInput(entityState, input) {
  const newState = entityState;  // No second clone
  // Mutations persist across sequential calls in same entity frame
}
```

**Impact:** ackedTransitions updates now persist, counter validation works.

### Pitfall 3: Undefined Variables from Refactoring

**Bug Pattern:**
```typescript
// After refactoring canonical keys → counterparty IDs
const depositAccountKey = canonicalAccountKey(...);  // Variable removed
// ...
if (!entityState.accounts.has(depositAccountKey)) {  // UNDEFINED!
```

**Fix:**
```typescript
if (!entityState.accounts.has(counterpartyEntityId)) {  // Use actual ID
```

**Impact:** deposit_collateral, j_event_claim, HTLC payments all had these bugs.

### Pitfall 4: Missing Import File

**Bug Pattern:**
```typescript
const { createFrameHash } = await import('./frame-utils');  // File doesn't exist!
// Silently crashes, execution stops
```

**Fix:**
```typescript
// Use local function (already defined in same file)
const recomputedHash = await createFrameHash({...});
```

**Impact:** ALL frame acceptance was blocked by this import error.

### Pitfall 5: Receiver fullDeltaStates Mismatch

**Bug Pattern:**
```typescript
// Proposer
const fullDeltaStates = sortedTokens.map(([_, delta]) => ({...delta}));
const hash = createFrameHash({..., fullDeltaStates});

// Receiver
const hash = createFrameHash({..., fullDeltaStates: []});  // Empty!
// Hash mismatch → frame rejected
```

**Fix:**
```typescript
// Receiver computes fullDeltaStates identically to proposer
const fullDeltaStates = sortedTokens.map(([_, delta]) => ({...delta}));
const hash = createFrameHash({..., fullDeltaStates});
```

**Impact:** Credit extensions, collateral frames now verify correctly.

---

## 🏗️ State Machine Hierarchy

### Runtime (Layer 1)
**Role:** Orchestrator - routes messages between entities and jurisdictions
**State:** `{ eReplicas: Map, jReplicas: Map, pendingOutputs: [] }`
**Tick:** Process all queued inputs → produce outputs for next tick

```typescript
function applyRuntimeInput(env, runtimeInput): {
  entityOutbox: EntityInput[],  // Messages to entities
  jOutbox: JInput[]             // Messages to jurisdictions
}
```

**Key Insight:** ONE TICK = ONE ITERATION. No cascades. E→E communication always requires new tick.

### Entity (Layer 2)
**Role:** BFT consensus among N validators (or single-signer fast path)
**State:** `{ accounts: Map, reserves: Map, jBlockObservations: [] }`
**Frame:** Batch of EntityTxs agreed upon by threshold

```typescript
function applyEntityFrame(env, entityState, entityTxs): {
  newState: EntityState,
  outputs: EntityInput[],  // Account frames to other entities
  jOutputs: JInput[]       // Batches to jurisdiction
}
```

**Key Insight:** Entity CONTAINS accounts. Entity consensus (BFT) is separate from account consensus (bilateral).

### Account (Layer 3)
**Role:** Bilateral 2-of-2 agreement between two entities
**State:** `{ deltas: Map, locks: Map, swapOffers: Map }`
**Frame:** Batch of AccountTxs - BOTH sides must agree on state hash

```typescript
function proposeAccountFrame(env, accountMachine): {
  accountInput: {
    height: currentHeight + 1,
    newAccountFrame: {...},
    newSignatures: [sig],
    counter: ++cooperativeNonce
  }
}
```

**Key Insight:** Each entity has its OWN AccountMachine for the bilateral account. Consensus = both independently compute same state hash.

### Jurisdiction (Layer 4)
**Role:** Terminal settlement layer (blockchain)
**State:** On-chain smart contracts (immutable)
**Block:** Batches of JTxs (R2C, C2R, settlements, rebalancing)

```typescript
function broadcastBatch(jBatch): JInput {
  jurisdictionName: 'Sepolia',
  jTxs: [{
    type: 'batch',
    entityId: alice,
    data: { batch: {r2c: [...], settlements: [...]} }
  }]
}
```

**Key Insight:** J-layer is WRITE-ONLY from entities. Entities READ via j-event watchers (eventually consistent).

---

## 🔁 Validation vs Commit: The Critical Pattern

**Why separate?** Need to verify frame correctness WITHOUT mutating state, then commit only if valid.

### Channel.ts 2024 Reference
```typescript
await this.applyBlock(block, true);   // dryRun=true (validate on clone)
const hash = encode(this.dryRunState);
// ...verify signatures...
await this.applyBlock(block, false);  // dryRun=false (commit on real)
if (encode(this.state) !== hash) {
  throw new Error('Consensus failure');  // States must match!
}
```

### XLN 2025 Implementation

**Proposer:**
```typescript
// No validation needed - we created the frame
// Just re-execute to ensure determinism
for (const tx of pendingFrame.accountTxs) {
  await processAccountTx(accountMachine, tx, true, env.timestamp, currentHeight);
}
```

**Receiver:**
```typescript
// 1. VALIDATION (on clone)
const clonedMachine = cloneAccountMachine(accountMachine);
for (const tx of receivedFrame.accountTxs) {
  await processAccountTx(clonedMachine, tx, false, env.timestamp, currentHeight, isValidation=true);
}
// Verify state hash matches
if (computeHash(clonedMachine) !== receivedFrame.stateHash) {
  return { success: false, error: 'Consensus failure' };
}

// 2. COMMIT (on real state)
for (const tx of receivedFrame.accountTxs) {
  await processAccountTx(accountMachine, tx, false, env.timestamp, currentHeight, isValidation=false);
}
```

**The isValidation Parameter:**
```typescript
function processAccountTx(..., isValidation: boolean) {
  // Always update transient state (deltas for validation)
  delta.ondelta += amount;

  // Only update persistent state during commit
  if (!isValidation) {
    tryFinalizeAccountJEvents(...);      // Bilateral finalization (prunes observations!)
    accountMachine.locks.set(id, lock);  // HTLC lockBook
    accountMachine.swapOffers.set(id, offer);  // Swap orderbook
  }
}
```

**Why this matters:** Bilateral finalization PRUNES observations after matching. If we prune during validation (on clone), observations are gone. Re-execution during commit finds no matches, never applies values!

---

## 🤝 Bilateral J-Event Consensus

**Analogy:** Two bank branches independently observing same wire transfer, then calling each other to confirm before updating accounts.

### The Flow

```
STEP 1: J-Machine (blockchain) emits AccountSettled event
        ↓
    Both entities observe via j-event watchers
        ↓
STEP 2: Each entity stores observation (LEFT or RIGHT)
        ↓
Alice:  leftJObservations: [{ jHeight:12, jBlockHash:0xabc..., events:[...] }]
        rightJObservations: []

Hub:    leftJObservations: []
        rightJObservations: [{ jHeight:12, jBlockHash:0xabc..., events:[...] }]
        ↓
STEP 3: Entities exchange observations via j_event_claim transactions
        ↓
Alice sends j_event_claim → Hub stores it as LEFT obs
Hub sends j_event_claim → Alice stores it as RIGHT obs
        ↓
STEP 4: tryFinalizeAccountJEvents finds matching (jHeight, jBlockHash)
        ↓
Alice:  leftJObservations: [...]  ← Alice's own
        rightJObservations: [...] ← Hub's received

        Match found! → Apply collateral/ondelta → Prune observations
        ↓
STEP 5: Both sides have identical delta.collateral, delta.ondelta
```

### Key Implementation Details

**Observation Attribution (account-tx/apply.ts:97):**
```typescript
const claimIsFromLeft = isOurFrame ? iAmLeft : !iAmLeft;

// When Alice (LEFT) processes own claim:     isOurFrame=true, iAmLeft=true  → LEFT obs ✓
// When Hub (RIGHT) processes Alice's claim:  isOurFrame=false, iAmLeft=false → LEFT obs ✓
// When Hub (RIGHT) processes own claim:      isOurFrame=true, iAmLeft=false → RIGHT obs ✓
// When Alice (LEFT) processes Hub's claim:   isOurFrame=false, iAmLeft=true → RIGHT obs ✓
```

**Matching Logic (entity-tx/j-events.ts:158-177):**
```typescript
function tryFinalizeAccountJEvents(account, counterpartyId, env) {
  // Find observations with same (jHeight, jBlockHash) from both sides
  const leftMap = new Map(account.leftJObservations.map(o => [`${o.jHeight}:${o.jBlockHash}`, o]));
  const rightMap = new Map(account.rightJObservations.map(o => [`${o.jHeight}:${o.jBlockHash}`, o]));

  const matches = Array.from(leftMap.keys()).filter(k => rightMap.has(k));

  if (matches.length === 0) return;  // Need both sides!

  // Apply collateral/ondelta from matched events
  for (const key of matches) {
    const obs = leftMap.get(key);
    delta.collateral = BigInt(obs.events[0].data.collateral);
    delta.ondelta = BigInt(obs.events[0].data.ondelta);
  }

  // Prune finalized observations (prevents re-application)
  account.leftJObservations = account.leftJObservations.filter(o => !finalizedHeights.has(o.jHeight));
  account.rightJObservations = account.rightJObservations.filter(o => !finalizedHeights.has(o.jHeight));
}
```

**Critical:** This MUST only run during commit (on real accountMachine), never during validation (on clone that gets discarded).

---

## 🔢 Counter Synchronization

**Analogy:** Message sequence numbers in TCP. Prevents replay attacks, ensures ordering.

### The Problem

```
Alice proposes h1 → cooperativeNonce++ → counter=1
Bob receives h1   → ackedTransitions=1
Bob sends ACK     → counter=1 (ACK doesn't increment)
Alice receives ACK → How to validate?
```

**Strict Validation:**
```typescript
expectedCounter = ackedTransitions + 1;  // Expects 1
if (counter !== expectedCounter) reject();  // ACK has counter=1 → PASS ✓
```

**But during collision:**
```
Alice proposes h1 (counter=1)  }
Bob proposes h1 (counter=1)    } Simultaneous!

Alice receives Bob's h1 → LEFT-WINS → ignores Bob's frame
Bob receives Alice's h1 → RIGHT-ROLLBACK → accepts Alice's frame

Bob sends ACK for Alice's h1 (counter=?)
```

**The Issue:** Bob already incremented his cooperativeNonce to 1 when he proposed. Now he's sending ACK with counter=2 or 3 (depending on batching). But Alice's ackedTransitions is still 0 (she hasn't processed any of Bob's messages successfully yet). Strict validation rejects!

**Solution: Flexible ACK Validation**
```typescript
const isACKForPendingFrame = accountMachine.pendingFrame
  && input.height === accountMachine.pendingFrame.height
  && input.prevSignatures;

if (isACKForPendingFrame) {
  // Allow counter >= ackedTransitions (collision recovery)
  counterValid = input.counter >= accountMachine.ackedTransitions;
} else {
  // Strict for all other messages
  counterValid = input.counter === accountMachine.ackedTransitions + 1;
}
```

---

## 🎭 Collision Handling: LEFT-WINS Tiebreaker

**Scenario:** Both sides propose same frame height simultaneously.

```
Alice: pendingFrame h5, proposes h5
Hub:   pendingFrame h5, proposes h5

Alice receives Hub's h5 → LEFT-WINS → ignores Hub's frame, waits for Hub to accept Alice's
Hub receives Alice's h5 → RIGHT-ROLLBACK → discards own h5, accepts Alice's h5
```

### Rollback Logic (account-consensus.ts:505-527)

```typescript
if (isLeftEntity) {
  // LEFT-WINS: Ignore their frame, keep ours
  return { success: true, events };
} else {
  // RIGHT-ROLLBACK: Accept theirs
  if (accountMachine.rollbackCount === 0) {
    // Restore our transactions to mempool (for retry)
    accountMachine.mempool.unshift(...accountMachine.pendingFrame.accountTxs);
    delete accountMachine.pendingFrame;
    accountMachine.rollbackCount++;
    // Continue to process their frame
  }
}
```

**Key:** RIGHT entity restores transactions to mempool. When Alice's frame is accepted, RIGHT sends ACK. Alice receives ACK, sees mempool has txs (the restored ones), batches them into h6.

**Deterministic:** isLeft = myEntityId < counterpartyEntityId (lexicographic). Same result on both sides.

---

## 📊 Account Key Refactoring: Canonical → Counterparty ID

**Old Pattern:**
```typescript
const accountKey = canonicalAccountKey(myEntityId, counterpartyId);
// Always returns: (min(a,b), max(a,b)) → Same key on both sides
```

**New Pattern:**
```typescript
// Each entity keys by counterparty ID (simpler perspective-based logic)
alice.accounts.get(hub.id)  // Alice's account with Hub
hub.accounts.get(alice.id)  // Hub's account with Alice
```

**Why change?** Simpler entity-centric logic. proofHeader still maintains canonical left/right for frame consensus.

**Gotcha:** Test assertions MUST use counterparty ID, not own ID:
```typescript
// WRONG
const bobAccount = bobRep.state.accounts.get(bob.id);

// CORRECT
const bobAccount = bobRep.state.accounts.get(hub.id);  // Bob's account WITH Hub
```

**Impact:** Multiple test bugs in lock-ahb.ts from using wrong keys.

---

## 🎯 Design Principles Summary

### 1. Pure Functions
Handlers return `{ newState, mempoolOps }`, never mutate input directly.

### 2. Immutability Boundaries
Clone once per layer (Entity → Account), not per handler.

### 3. Validation/Commit Separation
Validate on clone (verify safety), commit on real state (apply effects).

### 4. Deterministic Ordering
Sort all collections (proposableAccounts, signatures, tokenIds) for consensus.

### 5. Non-Blocking Duplex
Both sides can have pendingFrames. Batching (ACK+newFrame) prevents stalls.

### 6. Fintech-Grade Error Handling
Fail fast (throw on consensus mismatch), never swallow errors, always log state.

---

## 🔬 Debugging Tips

### When bilateral consensus fails:

**1. Check observations:**
```typescript
console.log(`LEFT obs: ${account.leftJObservations.length}`);
console.log(`RIGHT obs: ${account.rightJObservations.length}`);
```
Need both >0 for matching!

**2. Check which state:**
```typescript
console.log(`Processing on clone? isValidation=${isValidation}`);
```
If true and bilateral finalization happens → values lost!

**3. Check account keys:**
```typescript
console.log(`Account key: ${accountKey}, counterparty: ${counterpartyId}`);
```
Should use counterparty ID, not canonical key or own ID.

**4. Check counter sync:**
```typescript
console.log(`Counter: ${input.counter}, ackedTransitions: ${accountMachine.ackedTransitions}`);
```
Should be sequential (+1) except for ACKs after collision.

### When values don't persist:

**1. Are you on a clone that gets discarded?**
Check if handler is called during validation vs commit.

**2. Is state being returned and chained?**
```typescript
currentState = handler(currentState).newState;  // Must chain!
```

**3. Are mutations happening on shared objects?**
Delta objects should be shared between clonedMachine and accountMachine for validation to work.

---

## 📈 Production Readiness Checklist

**Single-Signer Entities:**
- ✅ Bilateral consensus working (ahb.ts 113 frames)
- ✅ J-event consensus (AccountSettled)
- ✅ Credit extensions
- ✅ Multi-hop payments
- ✅ Collision handling (left-wins)
- ✅ Counter validation (replay protection)
- ✅ Determinism verified

**Multi-Signer Entities:**
- ⏳ Needs testing (architecture ready)
- ⏳ BFT threshold consensus (code exists, not tested in scenarios)
- ⏳ Validator signature aggregation

**Hardening TODOs:**
- Frame hash: Replace placeholder with Merkle root (entity-consensus.ts:596)
- HTLC reveal: Complete secret propagation (lock-ahb.ts:995)
- Swap matching: Debug converge hang (swap.ts)

---

**Reference Implementations:**
- `.archive/2024_src/app/Channel.ts` - Bilateral consensus (gold standard)
- `.archive/2019src.txt` - Original flush pattern
- `runtime/scenarios/ahb.ts` - Complete working example (113 frames)
