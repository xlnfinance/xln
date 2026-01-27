# Settlement & Dispute Audit

**Auditor**: Claude Opus 4.5
**Date**: 2026-01-27
**Scope**: runtime settlement and dispute resolution code

## Executive Summary

The XLN settlement and dispute resolution system implements a bilateral consensus model with on-chain enforcement via the Depository contract. The design follows established payment channel patterns (similar to Lightning Network and Sprites) with some protocol-specific extensions for multi-token support and entity-based accounts.

**Overall Assessment**: The codebase demonstrates careful attention to determinism, replay protection, and bilateral consensus. However, several critical and high-severity issues were identified that could lead to fund loss, griefing attacks, or consensus failures during dispute resolution.

---

## Critical (P0 - Fund loss in disputes)

### C1: Missing dispute timeout enforcement in runtime (disputeFinalize can be called prematurely)

**File**: `/Users/zigota/xln/runtime/entity-tx/handlers/dispute.ts` (lines 170-299)

**Issue**: The `handleDisputeFinalize` function constructs the `disputeUntilBlock` from `account.activeDispute.disputeTimeout` but does NOT validate that the current block has actually exceeded this timeout before allowing unilateral finalization.

```typescript
// Line 271 - Timeout passed to jBatch without local validation
disputeUntilBlock: account.activeDispute.disputeTimeout,  // From on-chain
```

The on-chain contract enforces the timeout, but the runtime allows building the batch prematurely. This creates a gas-waste vector where malicious entities can spam finalize attempts, and more critically, if there's any discrepancy between local state and on-chain state, funds could be settled incorrectly.

**Recommendation**: Add explicit block height check in runtime before allowing unilateral finalize:
```typescript
const currentBlock = await browserVM.getBlockNumber();
if (!isCounterDispute && currentBlock < account.activeDispute.disputeTimeout) {
  throw new Error(`Dispute timeout not reached: ${currentBlock} < ${account.activeDispute.disputeTimeout}`);
}
```

**Severity**: CRITICAL - Could cause griefing (gas waste) or fund settlement at wrong state if on-chain/off-chain diverge.

---

### C2: Proof body hash mismatch vulnerability in counter-disputes

**File**: `/Users/zigota/xln/runtime/entity-tx/handlers/dispute.ts` (lines 206-257)

**Issue**: Counter-dispute logic requires `counterpartyProofBody` but falls back to `currentProofResult.proofBodyStruct` if not available:

```typescript
const finalProofbody = isCounterDispute
  ? (counterpartyProofBody || currentProofResult.proofBodyStruct)  // Fallback is dangerous!
  : (shouldUseStoredProof ? storedProofBody : currentProofResult.proofBodyStruct);
```

If `counterpartyProofBody` is unavailable (race condition, storage bug, etc.), the counter-dispute will use current state which may not match the signed proof body hash, causing on-chain verification to fail or worse - settle with wrong balances.

**Recommendation**: Make `counterpartyProofBody` strictly required for counter-disputes:
```typescript
if (isCounterDispute && !counterpartyProofBody) {
  throw new Error('disputeFinalize: missing counterparty proof body for counter-dispute');
}
```

This check exists (line 244-246) but only throws if `counterpartyProofBody` is undefined, not if it's accessed via the fallback path.

**Severity**: CRITICAL - Counter-dispute could use wrong proof body, leading to signature verification failure or incorrect settlement.

---

### C3: Cooperative nonce desync can block dispute resolution

**File**: `/Users/zigota/xln/runtime/entity-tx/handlers/dispute.ts` (lines 129-143)

**Issue**: The `cooperativeNonce` selection logic has multiple fallback paths that could select the wrong nonce:

```typescript
let cooperativeNonce = account.proofHeader.cooperativeNonce;
let nonceSource = 'proofHeader';
const mappedNonce = account.disputeProofNoncesByHash?.[proofBodyHashToUse];
if (mappedNonce !== undefined) {
  cooperativeNonce = mappedNonce;
  nonceSource = 'hashMap';
} else if (account.counterpartyDisputeProofCooperativeNonce !== undefined) {
  cooperativeNonce = account.counterpartyDisputeProofCooperativeNonce;
  nonceSource = 'counterpartySig';
} else if (hasCounterpartySig && account.ackedTransitions > 0) {
  cooperativeNonce = account.ackedTransitions - 1;
  nonceSource = 'ackedTransitions-1';
}
```

If `ackedTransitions` is used but doesn't match the actual signed nonce (e.g., frames were proposed but not acked), the dispute will submit with wrong nonce and fail on-chain verification.

**Recommendation**: Store the exact cooperativeNonce at the time of signing alongside the proofBodyHash in `disputeProofNoncesByHash`. Remove the `ackedTransitions - 1` fallback which is a heuristic prone to failure.

**Severity**: CRITICAL - Dispute submission could fail, leaving funds locked during dispute period.

---

## High (P1)

### H1: Settlement workspace not protected against concurrent modification

**File**: `/Users/zigota/xln/runtime/entity-tx/handlers/settle.ts` (lines 103-179)

**Issue**: Settlement workspace creation (`settle_propose`) doesn't use any locking mechanism. If two proposals arrive simultaneously (race condition in P2P network), the workspace state could become inconsistent.

```typescript
if (account.settlementWorkspace) {
  throw new Error(`Settlement workspace already exists. Use settle_update or settle_reject first.`);
}
```

This check is not atomic - between the check and workspace assignment, another proposal could be processed.

**Recommendation**: Use a workspace state machine with explicit states: `IDLE -> PROPOSED -> APPROVED -> EXECUTING`. Reject any state transitions that don't follow the valid sequence.

**Severity**: HIGH - Could cause settlement state divergence between bilateral parties.

---

### H2: HTLC timeout expiration check uses OR instead of AND

**File**: `/Users/zigota/xln/runtime/account-tx/handlers/htlc-timeout.ts` (lines 29-43)

**Issue**: HTLC timeout check uses OR between height and timestamp:

```typescript
const heightExpired = currentHeight > 0 && currentHeight > lock.revealBeforeHeight;
const timestampExpired = currentTimestamp > Number(lock.timelock);

if (!heightExpired && !timestampExpired) {
  // ... return error
}
```

This means an HTLC can be timed out based on timestamp alone, even if blocks haven't advanced. In a scenario where the timestamp is manipulated (e.g., entity clock drift), HTLCs could be prematurely expired.

**Recommendation**: For off-chain timeouts, require BOTH height AND timestamp to exceed thresholds. For on-chain enforcement, use only block height (which is what the contract does).

**Severity**: HIGH - Premature HTLC timeout could cause fund loss in payment routing.

---

### H3: Settlement hold underflow silently clamps to zero

**File**: `/Users/zigota/xln/runtime/account-tx/handlers/settle-hold.ts` (lines 89-105)

**Issue**: When releasing settlement holds, underflow is silently clamped to zero:

```typescript
if (currentLeftHold < diff.leftWithdrawing) {
  console.warn(`...underflow...clamping to 0`);
  delta.leftSettleHold = 0n;
}
```

This could mask bugs where holds were double-released or never properly set, potentially allowing double-spend scenarios.

**Recommendation**: Throw an error on hold underflow instead of clamping. Underflow indicates a consensus bug that should halt processing.

**Severity**: HIGH - Could mask double-release bugs leading to double-spend.

---

### H4: Dispute finalization doesn't verify proof body matches initial hash

**File**: `/Users/zigota/xln/runtime/entity-tx/handlers/dispute.ts` (lines 248-253)

**Issue**: For unilateral finalization, the code warns but doesn't prevent submission when proof hashes don't match:

```typescript
if (!isCounterDispute && !cooperative && currentProofResult.proofBodyHash !== account.activeDispute.initialProofbodyHash) {
  console.warn(`...proofBodyHash mismatch...`);
  if (!storedProofBody) {
    throw new Error('disputeFinalize: missing stored proofBody for unilateral finalize');
  }
}
```

If the stored proof body is available but doesn't match what was signed, the dispute could still proceed with mismatched data.

**Recommendation**: Verify that `storedProofBody` when hashed equals `initialProofbodyHash` before proceeding.

**Severity**: HIGH - Could submit dispute with wrong proof, causing on-chain failure or incorrect settlement.

---

## Medium (P2)

### M1: No rate limiting on dispute initiation

**File**: `/Users/zigota/xln/runtime/entity-tx/handlers/dispute.ts`

**Issue**: Entities can initiate disputes without any rate limiting or bonding requirement in the runtime. While the on-chain contract may have gas costs as implicit rate limiting, a malicious entity could spam dispute starts to grief counterparties.

**Recommendation**: Add a minimum time between dispute attempts per account, or require a bond that's slashed for frivolous disputes.

**Severity**: MEDIUM - Griefing attack vector.

---

### M2: Batch preflight validation is informational only

**File**: `/Users/zigota/xln/runtime/j-batch.ts` (lines 266-331)

**Issue**: `preflightBatchForE2` returns a list of issues but the caller may ignore them:

```typescript
const preflightIssues = preflightBatchForE2(normalizedEntityId, jBatchState.batch, ...);
if (preflightIssues.length > 0) {
  throw new Error(`Batch preflight failed: ${preflightIssues.join('; ')}`);
}
```

This is good, but the preflight is only called in `broadcastBatch`. Other code paths that add to the batch don't run preflight, allowing invalid batches to accumulate.

**Recommendation**: Run preflight validation when adding items to batch, not just at broadcast time.

**Severity**: MEDIUM - Invalid operations could accumulate and cause batch failure.

---

### M3: Insurance registration expiry check uses block timestamp in seconds

**File**: `/Users/zigota/xln/runtime/j-batch.ts` (lines 311-312)

**Issue**: Insurance expiry check compares `expiresAt` against `blockTimestampSec`:

```typescript
if (nowSec > 0 && reg.expiresAt <= BigInt(nowSec)) {
  issues.push(`insuranceReg expired...`);
}
```

But throughout the codebase, timestamps are often in milliseconds (e.g., `env.timestamp`). This could cause premature expiry or accept already-expired insurance.

**Recommendation**: Standardize timestamp units across the codebase. Add explicit `_ms` or `_sec` suffixes to variable names.

**Severity**: MEDIUM - Insurance could be incorrectly accepted or rejected.

---

### M4: J-event bilateral finalization can diverge on timing

**File**: `/Users/zigota/xln/runtime/entity-tx/j-events.ts` (lines 533-593)

**Issue**: `AccountSettled` events are stored in `leftJObservations` or `rightJObservations` but the bilateral finalization in `tryFinalizeAccountJEvents` requires both sides to have observed the same event. If P2P message delivery is delayed, one side might finalize while the other hasn't received the observation.

**Recommendation**: Add timeout handling for j-event claims. If one side's observation isn't received within a timeout, allow unilateral finalization with the on-chain event as proof.

**Severity**: MEDIUM - Could cause state divergence if network is partitioned.

---

### M5: Dispute start stores counterparty nonce from potentially stale state

**File**: `/Users/zigota/xln/runtime/entity-tx/j-events.ts` (lines 714-741)

**Issue**: When `DisputeStarted` event is received, the `initialCooperativeNonce` is derived from various fallback sources which might not reflect the exact nonce used on-chain:

```typescript
// Multiple fallback sources for nonce
if (mappedNonce !== undefined) { ... }
else if (weAreStarter) { ... }
else { ... }
```

This could cause the stored `activeDispute.initialCooperativeNonce` to differ from what's actually committed on-chain, causing finalization to fail.

**Recommendation**: Query the on-chain dispute state directly to get the committed nonce instead of inferring from local state.

**Severity**: MEDIUM - Could cause dispute finalization mismatch.

---

## Dispute Resolution Analysis

### Flow Overview

1. **Bilateral Consensus Phase**
   - Entities exchange frames with signed state hashes
   - Each frame includes `newDisputeHanko` signing the current proof body hash
   - Counterparty stores `counterpartyDisputeProofHanko` for potential dispute

2. **Dispute Initiation (`disputeStart`)**
   - Entity adds dispute proof to jBatch with counterparty's signed hanko
   - Batch is broadcast to Depository contract
   - Contract verifies hanko signature and starts dispute timer

3. **Dispute Period**
   - TIMING.DISPUTE_PERIOD_BLOCKS = 100 blocks (~20 minutes on Ethereum)
   - Either party can submit counter-dispute with higher nonce
   - On-chain transformer processes HTLC/swap states

4. **Dispute Finalization (`disputeFinalize`)**
   - After timeout: unilateral finalization with initial proof
   - Before timeout (counter-dispute): submission with higher-nonce proof
   - Cooperative: both parties sign final state

### Security Properties

**Positive Findings**:
- Frame hash chain linkage prevents replay attacks
- Counter validation prevents message desync
- Bilateral j-event consensus (2-of-2) prevents unilateral state injection
- Proof body includes full delta state (credit limits, allowances, holds)
- Settlement conservation law enforced (`leftDiff + rightDiff + collateralDiff = 0`)

**Concerns**:
- Multiple fallback paths for nonce/hash selection create edge cases
- Timestamp-based HTLC timeout could be manipulated
- No bonding/slashing for frivolous disputes
- Silent underflow clamping could mask consensus bugs

### Timeout Handling

| Component | Timeout | Enforcement |
|-----------|---------|-------------|
| Account frame ACK | 5s | Crontab suggests dispute |
| HTLC reveal | Per-hop delta | Both height AND timestamp |
| Dispute period | 100 blocks | On-chain contract |
| Settlement workspace | None | Manual reject required |
| jBatch broadcast | 5s auto | Crontab triggers |

### Fund Safety Analysis

**Funds at risk during disputes**:
1. Collateral in disputed account
2. HTLC holds on routing hops
3. Settlement holds pending execution

**Protections**:
- Collateral can only move via signed proof
- HTLC holds are released on timeout (but see H2)
- Settlement holds are ring-fenced bilaterally

**Gaps**:
- If dispute submission fails repeatedly, funds remain locked
- No emergency recovery mechanism for stuck disputes
- Clock drift could cause premature HTLC timeouts

---

## Files Reviewed

| File | Lines | Purpose |
|------|-------|---------|
| `/Users/zigota/xln/runtime/entity-tx/handlers/dispute.ts` | 300 | Dispute start/finalize handlers |
| `/Users/zigota/xln/runtime/entity-tx/handlers/settle.ts` | 672 | Settlement workspace management |
| `/Users/zigota/xln/runtime/entity-tx/j-events.ts` | 842 | J-event handling, bilateral consensus |
| `/Users/zigota/xln/runtime/account-consensus.ts` | 1420 | Frame consensus, signature verification |
| `/Users/zigota/xln/runtime/proof-builder.ts` | 371 | Dispute proof construction |
| `/Users/zigota/xln/runtime/j-batch.ts` | 973 | Batch aggregation and broadcast |
| `/Users/zigota/xln/runtime/account-tx/handlers/htlc-timeout.ts` | 82 | HTLC timeout processing |
| `/Users/zigota/xln/runtime/account-tx/handlers/settle-hold.ts` | 115 | Settlement hold management |
| `/Users/zigota/xln/runtime/entity-crontab.ts` | 468 | Periodic timeout checks |
| `/Users/zigota/xln/runtime/constants.ts` | 264 | System constants |
| `/Users/zigota/xln/runtime/transformer-args.ts` | 73 | Transformer argument encoding |
| `/Users/zigota/xln/runtime/types.ts` | 1250+ | Type definitions |

---

## Recommendations Summary

### Immediate (Before Production)

1. **C1**: Add block height validation before unilateral dispute finalize
2. **C2**: Strictly require counterparty proof body for counter-disputes
3. **C3**: Store exact signed nonce with proof hash, remove heuristic fallbacks
4. **H2**: Require both height AND timestamp for HTLC timeout
5. **H3**: Throw on hold underflow instead of clamping

### Short-term

1. **H1**: Add settlement workspace state machine
2. **H4**: Verify stored proof body hash matches before finalization
3. **M2**: Run preflight validation when adding to batch

### Long-term

1. **M1**: Add dispute bonding/rate limiting
2. **M4**: Add timeout handling for j-event claims
3. Standardize timestamp units (ms vs sec) across codebase
4. Add emergency recovery mechanism for stuck disputes

---

*End of Audit Report*
