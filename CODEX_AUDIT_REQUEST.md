# Codex Audit Request: RJEA Architecture & Bilateral Consensus

## Context

XLN implements a 4-layer deterministic financial protocol:
- **R**untime (orchestration)
- **J**urisdiction (EVM state machine - external blockchain)
- **E**ntity (BFT consensus among validators)
- **A**ccount (bilateral consensus between 2 entities)

Reference implementation: `.archive/2024_src/app/Channel.ts`

## Recent Changes

### 1. Counterparty ID Refactor (just completed)
**Changed:** Account Map keys from canonical `"left:right"` to simple counterparty ID
- Before: `accounts.get(canonicalAccountKey(alice.id, hub.id))` - both entities use same key
- After: Alice: `accounts.get(hub.id)`, Hub: `accounts.get(alice.id)` - each uses counterparty

**Rationale:** Simpler lookups, more intuitive, implicit perspective
**Question:** Is this architecturally sound? Channel.ts uses canonical left/right - did we lose something important?

**Files:**
- `runtime/entity-tx/handlers/account.ts` (account creation)
- `runtime/entity-tx/apply.ts` (openAccount handler)
- `runtime/entity-consensus.ts` (proposableAccounts tracking)

### 2. Bilateral J-Event Consensus (recently implemented)
**Pattern:** 2-of-2 agreement on AccountSettled events from J-Machine
- Each entity posts observation: `{jHeight, jBlockHash, events, observedAt}`
- Stored in `leftJObservations` / `rightJObservations`
- When both match → finalize → update account collateral

**Files:**
- `runtime/entity-tx/j-events.ts` (lines 144-214: tryFinalizeAccountJEvents)
- `runtime/account-tx/apply.ts` (lines 80-114: j_event_claim handler)
- `runtime/types.ts` (lines 693-697: bilateral consensus fields)

## Critical Files to Review

### Core Consensus
1. **`runtime/account-consensus.ts`** - Bilateral account frame consensus
   - Lines 165-327: proposeAccountFrame
   - Lines 333-825: handleAccountInput (receiver path)
   - **CONCERN:** Lines 402, 682 use `deltas.clear()` then copy from clone (state replacement vs deterministic re-execution)

2. **`runtime/entity-consensus.ts`** - Entity-level orchestration
   - Lines 707-927: applyEntityFrame (processes txs, collects mempoolOps)
   - Lines 879-927: Account frame proposal loop
   - **CONCERN:** mempoolOps pattern - is this the right abstraction?

3. **`runtime/entity-tx/j-events.ts`** - J-event handling
   - Lines 260-369: tryFinalizeJBlocks (entity-level finalization)
   - Lines 144-214: tryFinalizeAccountJEvents (bilateral finalization)
   - **CONCERN:** Asymmetry - entity level uses 1-of-N, account uses 2-of-2

### Reference Implementation
4. **`.archive/2024_src/app/Channel.ts`** - 2024 canonical bilateral consensus
   - Lines 733-784: applyBlock(dryRun) - executes txs TWICE (validation, commit)
   - Lines 102-104: Canonical left/right storage
   - **QUESTION:** Should we match this pattern exactly?

## Specific Doubts & Questions

### A. Account State Management
**Current pattern (account-consensus.ts):**
```typescript
// Proposal: Execute on clone
const clonedMachine = manualCloneAccountMachine(accountMachine);
for (const tx of mempool) { processAccountTx(clonedMachine, tx); }
accountMachine.clonedForValidation = clonedMachine;

// Commit: Copy state from clone
accountMachine.deltas.clear();
for (const [k,v] of clonedMachine.deltas.entries()) {
  accountMachine.deltas.set(k, {...v});
}
```

**Channel.ts pattern:**
```typescript
// Proposal: applyBlock(dryRun=true)
// Commit: applyBlock(dryRun=false) - re-executes txs on REAL state
```

**Question:** Should we refactor to Channel.ts pattern (deterministic re-execution)?

### B. Counterparty ID vs Canonical Keys
**Trade-offs:**
- Counterparty ID: Simpler, intuitive, but each entity has different key for same account
- Canonical: Both use same key, but more complex, need canonicalAccountKey() helper

**Question:** Does counterparty ID break anything? Frame serialization? State proofs?

### C. mempoolOps Pattern
**Current:** Handlers return `{mempoolOps: [{accountId, tx}]}`, orchestrator applies
**Alternative:** Direct `account.mempool.push(tx)` in handlers

**Question:** Is mempoolOps the right abstraction? Adds complexity but keeps handlers pure?

### D. proposableAccounts Tracking
**Current:** Set<counterpartyId> tracks accounts needing frame proposals
**Uses counterpartyId now (was canonical keys)**

**Question:** Is this correct after counterparty refactor? Any edge cases?

### E. Bilateral Consensus Clone Sync
**Issue:** tryFinalizeAccountJEvents mutates clone during proposal, mutations copied to real during commit (lines 423-438, 702-717)

**Question:** This works but feels "phishy" - should we refactor to pure re-execution?

## Active Bugs (Please Advise)

### 1. J-Machine Routing Broken
**Symptom:** `jOutputs` not reaching J-Machine mempool
**File:** `runtime/entity-consensus.ts` - jOutput routing logic
**Error:** "ASSERT FAIL: J-Machine mempool is EMPTY after j_broadcast"

### 2. Swap Offers Not Persisting
**Symptom:** `swap_offer` tx processes but swapOffers Map stays empty
**File:** `runtime/account-tx/handlers/swap-offer.ts`
**Error:** "Offer created in A-Machine account" assertion fails

### 3. HTLC Reveals Unimplemented
**File:** `runtime/scenarios/lock-ahb.ts` - Line 995 "TODO: Add frames for Bob revealing secret"
**Question:** How should HTLC reveal propagate backward through route?

## General Architecture Questions

1. **RJEA Purity:** Are we maintaining determinism everywhere? Any Date.now() / Math.random() violations?

2. **Consensus Layers:** Is the split between entity (BFT) and account (bilateral) clean? Any leaky abstractions?

3. **State Machine Correctness:** Do proposal → validation → commit flows match blockchain best practices?

4. **Naming Consistency:**
   - `entityTx` vs `EntityTx` (type)
   - `accountMachine` vs `AccountMachine` (type)
   - `counterpartyId` vs `targetEntityId` vs `fromEntityId`
   - Consistent?

5. **Channel.ts Divergence:** We deviated from Channel.ts in several ways:
   - Counterparty ID vs canonical keys
   - State copy vs re-execution
   - mempoolOps pattern
   - Is this evolution good or regression?

## What We Need

1. **Architecture Review:** Is RJEA layering correct? Any fundamental flaws?
2. **Consensus Correctness:** Bilateral + BFT patterns sound? Race conditions? State divergence risks?
3. **Design Feedback:** Counterparty ID - keep or revert? deltas.clear() - refactor or keep?
4. **Bug Guidance:** J-Machine routing, swap offers - where to look?
5. **Best Practices:** Are we following financial-grade deterministic state machine patterns?

## Files to Focus On

**Critical path (consensus):**
- `runtime/account-consensus.ts` (bilateral)
- `runtime/entity-consensus.ts` (BFT orchestration)
- `runtime/entity-tx/j-events.ts` (jurisdiction events)

**Recent changes:**
- `runtime/entity-tx/handlers/account.ts` (counterparty refactor)
- `runtime/account-tx/handlers/swap-offer.ts` (swap fix attempt)

**Reference:**
- `.archive/2024_src/app/Channel.ts` (proven correct implementation)

## Success Criteria

After audit, we should have:
- ✅ Architectural confidence (RJEA layers sound)
- ✅ Consensus correctness verified (no race conditions)
- ✅ Clear decision on counterparty ID vs canonical
- ✅ Clear decision on state copy vs re-execution
- ✅ Guidance on fixing active bugs
- ✅ Naming/style consistency recommendations

---

**Note:** We have 600k+ context available. Read whatever you need. Be brutally honest - we want fintech-grade correctness, not "it works for now".
