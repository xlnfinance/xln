# XLN Signature System - Production Readiness Plan

**Status:** Draft for approval
**Based on:** fintech-visionary agent analysis (a3e84f3)
**Target:** Remove all testing patterns, enforce bilateral Hanko verification

---

## EXECUTIVE SUMMARY

Current state: Signatures work in test mode (entities have each other's private keys) but fail in production (cannot sign as counterparty). Plan addresses 3 CRITICAL gaps and 4 architectural fixes.

---

## CRITICAL SECURITY FIXES

### ✅ FIX-1: Remove Permissive Board Verification (COMPLETED)
**File:** `runtime/hanko-signing.ts:305-308`
**Status:** ✅ DONE

**Before:**
```typescript
if (!boardVerified) {
  console.warn(`⚠️ Cannot verify board`);
  // For now, allow (might be external entity)
}
```

**After:**
```typescript
if (!boardVerified) {
  console.error(`❌ SECURITY: Cannot verify board - REJECTING`);
  return { valid: false, entityId: null };
}
```

**Impact:** Prevents board spoofing attacks where attacker creates entity with unknown validators.

---

### 🔴 FIX-2: Implement Bilateral Settlement Signature Collection
**Files:**
- `runtime/types.ts` (add fields to AccountMachine)
- `runtime/account-consensus.ts` (collect settlement sigs during ACK)
- `runtime/j-batch.ts` (use stored sig instead of auto-signing)
- `runtime/proof-builder.ts` (add settlement message builder)

**Problem:**
```typescript
// j-batch.ts:462-474 (BROKEN in production)
if (!settlement.sig || settlement.sig === '0x') {
  settlement.sig = await browserVM.signSettlement(entityId, counterparty, ...);
  // ❌ This signs as initiator, but counterparty signature is needed!
}
```

**Root Cause:** Settlement requires COUNTERPARTY's signature (proves they agreed to settle). Auto-signing only works when you have counterparty's private key (test mode).

**Solution:** Parallel to dispute proof system - exchange settlement signatures during bilateral consensus.

**Implementation Steps:**

#### Step 2.1: Add AccountMachine fields (types.ts ~line 785)
```typescript
// After counterpartyDisputeProofHanko:
currentSettlementHanko?: HankoString;              // My settlement sig (for current state)
currentSettlementCooperativeNonce?: number;        // Nonce used in currentSettlementHanko
currentSettlementDiffs?: SettlementDiff[];         // Diffs that currentSettlementHanko signs
counterpartySettlementHanko?: HankoString;         // Their settlement sig (ready for j-batch)
counterpartySettlementCooperativeNonce?: number;   // Nonce used in counterpartySettlementHanko
counterpartySettlementDiffs?: SettlementDiff[];    // Diffs that counterparty signed
```

#### Step 2.2: Build settlement message hash (proof-builder.ts)
```typescript
export function createSettlementHash(
  accountMachine: AccountMachine,
  diffs: SettlementDiff[]
): string {
  const channelKey = getChannelKey(accountMachine.leftEntity, accountMachine.rightEntity);
  const cooperativeNonce = accountMachine.proofHeader.cooperativeNonce;

  // Match Account.sol CooperativeUpdate encoding
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  const encodedMsg = abiCoder.encode(
    ['uint256', 'bytes', 'uint256', 'tuple(uint256,int256,int256,int256,int256)[]', 'uint256[]', 'tuple(bytes32,bytes32,uint256,uint256,uint256)[]'],
    [
      0, // MessageType.CooperativeUpdate
      channelKey,
      cooperativeNonce,
      diffs.map(d => [d.tokenId, d.leftDiff, d.rightDiff, d.collateralDiff, d.ondeltaDiff]),
      [], // forgiveDebtsInTokenIds (empty for now)
      []  // insuranceRegs (empty for now)
    ]
  );

  return ethers.keccak256(encodedMsg);
}

export function buildSettlementDiffs(accountMachine: AccountMachine): SettlementDiff[] {
  // Calculate what would be sent to jurisdiction for settlement
  const diffs: SettlementDiff[] = [];

  for (const [tokenId, delta] of accountMachine.deltas) {
    // Only include tokens with non-zero collateral or holds
    if (delta.collateral !== 0n || delta.leftHtlcHold || delta.rightHtlcHold) {
      diffs.push({
        tokenId: Number(tokenId),
        leftDiff: delta.offdelta < 0n ? delta.offdelta : 0n,
        rightDiff: delta.offdelta > 0n ? delta.offdelta : 0n,
        collateralDiff: delta.collateral,
        ondeltaDiff: delta.ondelta
      });
    }
  }

  return diffs;
}
```

#### Step 2.3: Sign settlement during ACK (account-consensus.ts ~line 1076)
```typescript
// After building dispute proof hanko:
const ackDisputeHanko = ackDisputeHankos[0];

// NEW: Build settlement hanko for current state
const settlementDiffs = buildSettlementDiffs(accountMachine);
const settlementHash = createSettlementHash(accountMachine, settlementDiffs);
const ackSettlementHankos = await signHashesAsSingleEntity(
  env, ackEntityId, ackSignerId, [settlementHash]
);
const ackSettlementHanko = ackSettlementHankos[0];

const response: AccountInput = {
  // ... existing fields
  newDisputeHanko: ackDisputeHanko,
  newDisputeProofBodyHash: ackProofResult.proofBodyHash,
  // NEW: Settlement signature
  newSettlementHanko: ackSettlementHanko,
  newSettlementDiffs: settlementDiffs,
};
```

#### Step 2.4: Store counterparty settlement sig (account-consensus.ts ~line 607)
```typescript
// After storing counterpartyDisputeProofHanko:
if (input.newDisputeHanko) {
  accountMachine.counterpartyDisputeProofHanko = input.newDisputeHanko;
  // ...
}

// NEW: Store settlement signature
if (input.newSettlementHanko) {
  accountMachine.counterpartySettlementHanko = input.newSettlementHanko;
  accountMachine.counterpartySettlementCooperativeNonce = input.counter - 1;
  if (input.newSettlementDiffs) {
    accountMachine.counterpartySettlementDiffs = input.newSettlementDiffs;
  }
  console.log(`✅ Stored counterparty settlement hanko from ACK`);
}
```

#### Step 2.5: Use stored sig in j-batch (j-batch.ts:462-474)
```typescript
// REMOVE auto-signing pattern
// DELETE lines 462-475

// NEW: Require explicit signature
export function batchAddSettlement(
  jBatchState: JBatchState,
  leftEntity: string,
  rightEntity: string,
  diffs: Array<{ ... }>,
  forgiveDebtsInTokenIds: number[] = [],
  insuranceRegs: InsuranceReg[] = [],
  sig: string, // REQUIRED - no default!
  // ... rest
) {
  // Validate signature is present
  const hasChanges = diffs.length > 0 ||
                     forgiveDebtsInTokenIds.length > 0 ||
                     insuranceRegs.length > 0;

  if (hasChanges && (!sig || sig === '0x')) {
    throw new Error(
      `Settlement signature required for changes (left=${leftEntity.slice(-4)}, right=${rightEntity.slice(-4)})`
    );
  }

  // ... rest of function unchanged
}
```

#### Step 2.6: Update callers (entity-crontab.ts, entity-factory.ts)
```typescript
// When calling batchAddSettlement, use stored counterparty sig:
const account = entityState.accounts.get(counterpartyId);
if (!account?.counterpartySettlementHanko) {
  throw new Error(`No settlement signature from ${counterpartyId.slice(-4)}`);
}

batchAddSettlement(
  entityState.jBatchState,
  leftEntity,
  rightEntity,
  diffs,
  [],
  [],
  account.counterpartySettlementHanko  // Use stored signature
);
```

---

### 🔴 FIX-3: Add Replay Protection (chainId + domain separator)
**Files:**
- `runtime/proof-builder.ts` (add chainId to message encoding)
- `jurisdictions/contracts/Account.sol` (verify chainId)

**Problem:** Signatures can be replayed across chains/jurisdictions.

**Attack:** Valid dispute proof from testnet replayed on mainnet (same entities, same state).

**Solution:** Add EIP-712 style domain separator to all signed messages.

**Implementation:**

#### Step 3.1: Add chainId to message encoding (proof-builder.ts)
```typescript
// Before (line 282-291):
const encodedMsg = abiCoder.encode(
  ['uint8', 'bytes', 'uint256', 'uint256', 'bytes32'],
  [MESSAGE_TYPE_DISPUTE_PROOF, chKey, cooperativeNonce, disputeNonce, proofBodyHash]
);

// After:
const CHAIN_ID = 1; // TODO: Get from env or config
const encodedMsg = abiCoder.encode(
  ['uint256', 'uint256', 'address', 'bytes', 'uint256', 'uint256', 'bytes32'],
  [
    MESSAGE_TYPE_DISPUTE_PROOF,
    CHAIN_ID,                    // NEW: Chain ID
    depositoryAddress,           // NEW: Contract address
    chKey,
    cooperativeNonce,
    disputeNonce,
    proofBodyHash
  ]
);
```

#### Step 3.2: Update Account.sol verification
```solidity
// Add chainId check to _verifyDisputeProofHanko:
function _verifyDisputeProofHanko(...) internal view {
  bytes memory encodedMsg = abi.encode(
    Types.MessageType.DisputeProof,
    block.chainid,              // NEW: Verify chain ID
    address(depository),        // NEW: Verify contract address
    ch_key,
    nonce,
    disputeNonce,
    proofbodyHash
  );

  bytes32 hash = keccak256(encodedMsg);
  // ... rest of verification
}
```

#### Step 3.3: Apply same pattern to all message types
- CooperativeUpdate (settlements)
- FinalDisputeProof
- CooperativeDisputeProof

---

### 🟡 FIX-4: Add Initiator Signature to disputeStart
**Files:**
- `jurisdictions/contracts/Types.sol` (add initiatorSig field)
- `jurisdictions/contracts/Account.sol` (verify both signatures)
- `runtime/entity-tx/handlers/dispute.ts` (include initiator sig)

**Problem:** disputeStart only verifies counterparty signature. Initiator could submit without proving they also agreed to that state.

**Solution:** Require BOTH parties' signatures on the same proofBodyHash.

**Implementation:**

#### Step 4.1: Update InitialDisputeProof struct (Types.sol ~line 42)
```solidity
struct InitialDisputeProof {
  bytes32 counterentity;
  uint256 cooperativeNonce;
  uint256 disputeNonce;
  bytes32 proofbodyHash;
  bytes sig;                    // Counterparty signature
  bytes initiatorSig;           // NEW: Initiator signature
  bytes initialArguments;
}
```

#### Step 4.2: Verify both signatures (Account.sol ~line 410)
```solidity
function _disputeStart(...) internal {
  // Existing: Verify counterparty signed
  _verifyDisputeProofHanko(
    entityProvider, ch_key, params.cooperativeNonce,
    params.disputeNonce, params.proofbodyHash,
    params.sig, params.counterentity
  );

  // NEW: Verify initiator also signed the same state
  _verifyDisputeProofHanko(
    entityProvider, ch_key, params.cooperativeNonce,
    params.disputeNonce, params.proofbodyHash,
    params.initiatorSig, entityId  // Verify initiator's signature
  );

  // ... rest of function
}
```

#### Step 4.3: Include initiator sig (dispute.ts ~line 96)
```typescript
newState.jBatchState.batch.disputeStarts.push({
  counterentity: counterpartyEntityId,
  cooperativeNonce,
  disputeNonce,
  proofbodyHash: proofBodyHashToUse,
  sig: counterpartyDisputeHanko,          // Counterparty's sig
  initiatorSig: account.currentDisputeProofHanko || '0x',  // NEW: Initiator's sig
  initialArguments: '0x',
});
```

---

## CLEANUP TASKS

### 🟡 CLEANUP-1: Remove Debug Events from Solidity
**Files:**
- `jurisdictions/contracts/Account.sol` (lines 46-49)
- `jurisdictions/contracts/Depository.sol` (line 126)

**Remove:**
```solidity
// Account.sol
event DebugSettleEntry(uint256 index, uint256 tokenId, int256 leftDiff, int256 rightDiff);
event DebugSettlementHash(bytes32 hash);
event DebugHankoResult(bytes32 entityId, bool success);
event DebugHankoStep(string step, bytes data);

// Depository.sol
event DebugSettleStart(bytes32 leftEntity, bytes32 rightEntity, uint256 diffsLength);
```

**Find all emit calls and remove them.**

---

### 🟡 CLEANUP-2: Remove Unused Settlement Fields
**Files:**
- `jurisdictions/contracts/Types.sol` (line 121-122)
- `runtime/j-batch.ts` (lines 73, 246, 325)

**Decision needed on:**
1. `nonce` field in Settlement struct (never checked in _settleDiffs)
2. `hankoData` field in Settlement struct (passed but never used)

**Options:**
A) Remove both (cleanest)
B) Implement nonce verification
C) Document as future extension points

**Recommendation:** Remove both. If needed later, add with proper verification.

---

## TESTING REQUIREMENTS

### Before Production:
1. ✅ Board verification fails when metadata missing
2. ✅ Settlement fails when counterparty sig missing (not auto-signed)
3. ✅ Dispute start requires both initiator + counterparty sigs
4. ✅ Replay protection: same sig rejected on different chain
5. ✅ All debug events removed
6. ✅ No '0x' signatures accepted (except timeout disputes)

### Test Scenarios:
- **Scenario 1:** Entity A proposes frame, Entity B ACKs → both settlement sigs exchanged
- **Scenario 2:** Entity A calls disputeStart → verify both sigs present
- **Scenario 3:** External entity (no board metadata) → Hanko verification fails
- **Scenario 4:** Replay testnet signature on mainnet → rejected by chainId check

---

## IMPLEMENTATION ORDER

### Phase 1: CRITICAL (do first)
1. ✅ FIX-1: Board verification (DONE)
2. 🔴 FIX-2: Bilateral settlement signatures (2-3 hours)

### Phase 2: SECURITY HARDENING
3. 🔴 FIX-3: Replay protection (1-2 hours)
4. 🟡 FIX-4: Initiator signature (1 hour)

### Phase 3: CLEANUP (before audit)
5. 🟡 CLEANUP-1: Remove debug events (30 min)
6. 🟡 CLEANUP-2: Unused fields (30 min)

**Total estimated time:** 6-8 hours

---

## RISKS & MITIGATIONS

### Risk 1: Settlement Signature Mismatch
**Scenario:** Entity builds settlement with different diffs than what was signed
**Mitigation:** Store signed diffs with signature, verify match before j-batch
**Severity:** HIGH

### Risk 2: Nonce Desync
**Scenario:** cooperativeNonce used for settlement != nonce used during signing
**Mitigation:** Store nonce alongside signature, use exact match
**Severity:** MEDIUM

### Risk 3: Breaking Existing Tests
**Scenario:** Removing auto-signing breaks all existing test scenarios
**Mitigation:** Update tests to use bilateral signature exchange
**Severity:** LOW (tests should reflect production behavior)

---

## APPROVAL REQUIRED

**Questions for user:**
1. Proceed with full bilateral settlement implementation (FIX-2)?
2. Implement replay protection (FIX-3) now or defer?
3. Decision on unused `nonce`/`hankoData` fields - remove or document?
4. Should timeout disputes continue to use `'0x'` signature (Opus says yes)?

**Next step:** Get approval, then execute Phase 1.
