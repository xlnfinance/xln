# Mainnet-Level Batch Management — Execution Plan v2

## Architecture Decisions (Finalized)

### D1: Unified Account Nonce (coopNonce + disputeNonce → single `nonce`)

**Current**: Two separate tracking mechanisms:
- `cooperativeNonce` in AccountInfo — increments on settlement
- `disputeNonce` in InitialDisputeProof — tracks dispute rounds
- Both included in dispute hash computation

**New**: Single `nonce` per account.

**Why it works:**
1. At settlement signing time, snapshot current nonce into the settlement proof
2. On settlement execution, force on-chain `nonce = signedNonce + 1`
3. All older proofs (dispute or settlement) signed at `nonce < current` are automatically invalid
4. The "one valid proof" invariant: only the proof signed at the current nonce is valid
5. When a dispute starts, nonce increments → any settlement proof signed before is dead
6. When a settlement executes, nonce increments → any dispute proof filed before is dead

**Attack prevention**: Alice signs settlement S1 at nonce=5. Applied → nonce=6. Alice tries to re-include S1 in another batch → fails because S1 was signed at nonce=5, on-chain expects nonce=6.

**Contract changes:**
```solidity
struct AccountInfo {
  uint nonce;          // was: cooperativeNonce + separate disputeNonce
  bytes32 disputeHash;
  uint256 disputeTimeout;
}

// Settlement: signs over nonce, on apply increments nonce
// Dispute start: signs over nonce, on start increments nonce
// Dispute finalize: checks nonce matches what was active at start
```

**No need for two hankos in dispute flow**: The executor submits via batch hanko. The counterparty's signature (settlement or dispute proof) is per-operation. One sig per operation, one batch-level sig for the submitter.

### D2: Multisig Batch — One Entity Machine Round (NOT 3 separate txs)

**The infrastructure already exists!**

`hashesToSign` pipeline in entity-consensus.ts:
1. EntityTx handler returns `hashesToSign: [{ hash, type, context }]`
2. During PROPOSE: proposer signs all hashes, stores in `collectedSigs`
3. During PRECOMMIT: each validator signs all hashes, adds to `collectedSigs`
4. On COMMIT: `buildQuorumHanko()` merges signatures per hash → stores in `hankoWitness`

Settlements already use this (type `'settlement'`). The type union already includes `'jBatch'` at entity-consensus.ts:715.

**Flow for batch broadcast:**
```
j_broadcast EntityTx
  → handler computes batchHash = computeBatchHankoHash(chainId, depository, encodedBatch, nonce)
  → handler returns { newState, outputs, jOutputs, hashesToSign: [{ hash: batchHash, type: 'jBatch', context }] }
  → entity consensus PROPOSE: proposer signs batchHash alongside frame hash
  → entity consensus PRECOMMIT: all validators sign batchHash
  → entity consensus COMMIT: buildQuorumHanko(batchHash, allSigs) → hankoWitness.set(batchHash, hanko)
  → jOutput carries the batch + references batchHash
  → runtime post-save: looks up hanko from hankoWitness, submits to JAdapter with full quorum hanko
```

**Single EntityTx. Single consensus round. Full multisig. No new protocol messages.**

The only change: `j_broadcast` handler must:
1. Compute batchHash and return it in `hashesToSign`
2. Store `encodedBatch` in entity state so runtime can retrieve it post-commit
3. Runtime post-save must look up hanko from `hankoWitness` when submitting

### D3: Unionified AccountSettled Event

```solidity
struct TokenSettlement {
  uint tokenId;
  uint leftReserve;
  uint rightReserve;
  uint collateral;
  int ondelta;
}

struct AccountSettlement {
  bytes32 left;
  bytes32 right;
  TokenSettlement[] tokens;
  uint nonce;  // new unified nonce, for watcher correlation
}

event AccountSettled(AccountSettlement[] settled);
```

Benefits:
- One entry per account pair (not per token) — saves gas
- Includes nonce for watcher to correlate with bilateral state
- Matches how `rawEventToJEvents()` already groups by `(left, right)`

### D4: Settlement Executor Model

Settlement struct already has `leftEntity` + `rightEntity`. The submitter (executor) is identified by the batch-level hanko. The `sig` field is the counterparty's hanko.

Either side can be executor. Executor can be swapped via AccountTx (`swap_executor`). The executor is responsible for:
- Collecting counterparty's settlement hanko (via bilateral consensus)
- Including the settlement in their batch
- Submitting the batch on-chain

Only ONE hanko needed per settlement (counterparty's). Batch hanko covers the executor.

---

## Batch Lifecycle State Machine

```
  EMPTY
    │ batchAdd*()
    ▼
  ACCUMULATING ◄── batchAdd*() (more ops)
    │ j_broadcast EntityTx
    ▼
  SENT ── broadcastedAt=timestamp, txHash stored
    │
    ├─ HankoBatchProcessed(success=true) → CONFIRMED → archive to batchHistory[]
    │
    └─ HankoBatchProcessed(success=false) or timeout → FAILED → Retry or Clear
```

Note: no separate SIGNING state. The `j_broadcast` EntityTx goes through entity consensus which collects all validator signatures in one round. By the time the frame is committed, the full quorum hanko is ready.

For single-signer: consensus is instant (threshold=1, self-sign). Same code path.

---

## Entity State Changes

### types.ts

```typescript
type BatchStatus = 'empty' | 'accumulating' | 'sent' | 'confirmed' | 'failed';

// Add 'jBatch' to HashType
export type HashType = 'entityFrame' | 'accountFrame' | 'dispute' | 'settlement' | 'profile' | 'jBatch';

interface JBatchState {
  batch: JBatch;
  status: BatchStatus;
  jurisdiction: JurisdictionConfig | null;

  // Broadcast tracking
  broadcastedAt: number;           // timestamp when sent to chain
  txHash: string | null;           // on-chain tx hash (set after submission)
  entityNonce: number;             // nonce used for this batch
  broadcastCount: number;          // total broadcasts
  failedAttempts: number;          // consecutive failures

  // Frozen batch for post-commit submission
  encodedBatch: string | null;     // ABI-encoded batch bytes (frozen at j_broadcast time)
  batchHash: string | null;        // hash for hanko lookup in hankoWitness

  // Gas
  gasConfig: {
    maxFeePerGas: bigint | null;
    maxPriorityFeePerGas: bigint | null;
    gasLimit: bigint | null;
  } | null;
}

interface CompletedBatch {
  batchNonce: number;
  status: 'confirmed' | 'failed';
  operations: {
    r2c: number; c2r: number; settlements: number;
    r2r: number; disputes: number; reveals: number;
  };
  broadcastedAt: number;
  confirmedAt: number;
  txHash: string;
  blockNumber: number;
  gasUsed: bigint;
  netReserveChange: Record<number, bigint>; // tokenId → net change
}

// In EntityState:
batchHistory: CompletedBatch[];  // last 20, newest first
```

---

## File Changes

### Phase 1: Solidity — Unified Nonce + AccountSettled

| File | Change |
|------|--------|
| Types.sol | `AccountInfo.cooperativeNonce` → `AccountInfo.nonce`. Add `TokenSettlement` + `AccountSettlement` structs. Remove old `Settled` struct. `InitialDisputeProof`: replace `cooperativeNonce + disputeNonce` with single `nonce`. `FinalDisputeProof`: same. |
| Account.sol | Update `AccountSettled` event to `AccountSettlement[]`. Update `_settleDiffs()` and `_processC2R()` to emit new format with nonce. Update `_disputeStart()` to use unified nonce. Update all `encodeDisputeHash` / `verifyDisputeProofHanko` / `verifyCooperativeProofHanko` to use single nonce. Remove debug events in production. |
| Depository.sol | Update event declarations. Update `_processDisputeFinalization()` to use unified nonce. |

### Phase 2: Runtime — Batch Lifecycle + hashesToSign

| File | Change |
|------|--------|
| types.ts | Add `'jBatch'` to `HashType`. Add `BatchStatus`, expand `JBatchState`, add `CompletedBatch`, add `batchHistory` to EntityState |
| j-batch.ts | Update `JBatchState` interface. `assertBatchNotPending()` → check `status === 'empty' \|\| status === 'accumulating'`. Add `archiveBatch()` helper |
| entity-tx/handlers/j-broadcast.ts | Compute `batchHash`, return in `hashesToSign: [{ hash: batchHash, type: 'jBatch', context }]`. Store `encodedBatch` and `batchHash` in state. Set `status = 'sent'`, `broadcastedAt`. Remove direct `signHashesAsSingleEntity` call — consensus handles it |
| runtime.ts (post-save jOutput handling) | When processing jOutputs: look up batchHash in `hankoWitness` to get the quorum hanko. Pass it to `JAdapter.submitTx()`. This is where the actual on-chain tx fires |
| entity-tx/j-events.ts | `HankoBatchProcessed` success → archive to `batchHistory[]` (cap 20), set `status='confirmed'`, clear batch. Failure → set `status='failed'` |
| entity-tx/j-events.ts | Update `rawEventToJEvents()` for new `AccountSettled` format |
| jadapter/helpers.ts | Update `rawEventToJEvents()` for `AccountSettlement[]` with `TokenSettlement[]` + nonce |
| entity-crontab.ts | `broadcastBatch` task: use `j_broadcast` EntityTx (which now returns hashesToSign). Retry logic: if status='sent' && age > threshold → warn. If status='failed' → suggest retry |

### Phase 3: Runtime — Unified Nonce in Bilateral

| File | Change |
|------|--------|
| account-tx/handlers/settle-hold.ts | Use `account.proofHeader.nonce` instead of `cooperativeNonce` |
| entity-tx/handlers/settle.ts | Settlement hash computation: use unified nonce. Remove separate cooperativeNonce/disputeNonce tracking |
| entity-tx/handlers/dispute.ts | Use unified nonce for dispute proofs |
| proof-builder.ts | Update `createSettlementHashWithNonce()` to use single nonce |

### Phase 4: Frontend

| File | Change |
|------|--------|
| SettlementPanel.svelte | **Redesign**: Top = Current Batch (full expansion of every operation type with amounts, tokens, counterparties, hanko status). Middle = Action tabs (Fund/Withdraw/Transfer/Dispute). Bottom = Batch History (last 20). Gas Fee selector. "Sign & Broadcast" triggers `j_broadcast` EntityTx (not direct submitProcessBatch). "Clear" triggers `j_clear_batch` EntityTx. Retry UI when stuck/failed. |
| New: GasFeeSelector.svelte | 3-tier gas selection (Slow/Standard/Fast) + custom gwei input. EIP-1559 fields. Estimated cost display. |

### Phase 5: Scenario + Verification

| File | Change |
|------|--------|
| scenarios/rebalance.ts | Update for new nonce model + batch lifecycle assertions |
| scenarios/lock-ahb.ts | Verify still passes |

---

## Key Implementation Details

### j_broadcast handler (the critical change)

```typescript
export async function handleJBroadcast(
  entityState: EntityState,
  entityTx: Extract<EntityTx, { type: 'j_broadcast' }>,
  env: Env
): Promise<{
  newState: EntityState;
  outputs: EntityInput[];
  jOutputs: JInput[];
  hashesToSign: Array<{ hash: string; type: 'jBatch'; context: string }>;
}> {
  // 1. Validate batch non-empty
  // 2. Encode batch: encodedBatch = encodeJBatch(batch)
  // 3. Get next nonce (from entity state or env)
  // 4. Compute: batchHash = computeBatchHankoHash(chainId, depository, encodedBatch, nonce)
  // 5. Store in state: jBatchState.encodedBatch = encodedBatch, jBatchState.batchHash = batchHash
  // 6. Set status = 'sent', broadcastedAt = timestamp
  // 7. Create jOutput with batch data (hanko will be attached by runtime post-commit)
  // 8. Return hashesToSign: [{ hash: batchHash, type: 'jBatch', context: 'batch:nonce:N' }]

  // Entity consensus handles the rest:
  // - All validators sign batchHash during PRECOMMIT
  // - On COMMIT: buildQuorumHanko(batchHash, sigs) → hankoWitness
  // - Runtime post-save: retrieve hanko from hankoWitness → JAdapter.submitTx()
}
```

### Runtime post-save jOutput handling (attach hanko)

```typescript
// In runtime.ts, after entity frame committed:
for (const jOutput of jOutbox) {
  for (const jTx of jOutput.jTxs) {
    if (jTx.type === 'batch') {
      // Look up quorum hanko from hankoWitness
      const batchHash = jTx.data.batchHash;
      const witness = replica.hankoWitness?.get(batchHash);
      if (witness?.hanko) {
        jTx.data.hankoSignature = witness.hanko;  // Attach full quorum hanko
      }
      await jAdapter.submitTx(jTx.data.encodedBatch, entityProviderAddr, jTx.data.hankoSignature, nonce);
    }
  }
}
```

---

## Execution Order

1. **Solidity**: Unified nonce + AccountSettlement event restructure
2. **Runtime types**: JBatchState expansion, batchHistory, HashType update
3. **j-broadcast handler**: Return hashesToSign, freeze batch
4. **Runtime post-save**: Attach hanko from hankoWitness to jOutput
5. **j-events handler**: Archive to batchHistory on HankoBatchProcessed
6. **Event watcher**: Update rawEventToJEvents for new AccountSettled format
7. **Bilateral nonce**: Unify cooperativeNonce + disputeNonce throughout runtime
8. **Frontend**: Redesign SettlementPanel, add GasFeeSelector, batch history
9. **Scenarios**: Update rebalance.ts, verify lock-ahb.ts still passes
10. **bun run check**: Type-clean

---

## What We're NOT Building (Deferred)

- Auto-retry with gas bumping (manual retry only for now)
- Gas oracle integration (hardcode tiers, user can override with custom gwei)
- Executor swap AccountTx (design exists, implementation deferred)
- Flashloan UI (batch field exists, no UI yet)

---

## Codex Response (2026-02-14)

### Verdict

Approved with notes. Direction is sound and better aligned with mainnet constraints than prior flow.

### MUST before prod rollout

1. Keep runtime/event backward compatibility during migration window:
   - Support both old and new `AccountSettled` payloads in watcher parsing until all contracts are upgraded.
2. Add explicit migration tests for nonce unification:
   - settlement signed at `nonce=n` must fail after `nonce` increments,
   - dispute-start and settlement ordering must be replay-safe across blocks.
3. Enforce single source of truth for batch hanko attachment:
   - `j_broadcast` creates `batchHash` only,
   - post-commit runtime attaches quorum hanko from `hankoWitness`,
   - no fallback single-signer signing path left in handler.

### TODO (not blocking immediate commit)

1. Add scenario assertions for `onChainSettlementNonce` increments (not just logs).
2. Add UI guardrails for batch state transitions (`sent/failed/confirmed`) to prevent duplicate submit clicks.
3. Add a compact ops telemetry view (batch nonce, tx hash, gas used, failure reason) for faster incident triage.

### Recommendation on NEXT

- `A) Commit all changes`: yes.
- `B) Update docs/rebalance.md`: yes (include final C→R workspace lifecycle and nonce semantics).
- `C) Deploy to prod and test E2E`: after the three MUST items above are verified in CI.
