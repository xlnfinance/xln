# Account.sol Extraction - Contract Size Reduction Refactor

**Status:** CRITICAL BUGS FOUND - FIX BEFORE EXTRACTION
**Goal:** Split Depository.sol (39KB) into Account.sol library + Depository.sol coordinator to get both under 24KB
**Timeline:** 5-6 hours implementation (includes bug fixes)
**Deploy target:** Base mainnet (today)

---

## 🚨 CRITICAL BUGS TO FIX FIRST (from Codex review)

### Bug 1: KEY SCHEME MISMATCH (CRITICAL - data corruption)

**Problem:** Two different key schemes split state across different storage slots:

```solidity
// Pattern 1 - HASHED (settle, prefundAccount):
bytes memory ch_key = abi.encodePacked(keccak256(abi.encodePacked(leftEntity, rightEntity)));
// → 32 bytes (hash)

// Pattern 2 - RAW (channelKey, disputes, collateral moves):
function channelKey(bytes32 e1, bytes32 e2) public pure returns (bytes memory) {
  return e1 < e2 ? abi.encodePacked(e1, e2) : abi.encodePacked(e2, e1);
}
// → 64 bytes (concatenation)
```

**Impact:**
- settle() writes to hash-based key
- disputeStart/Finalize reads from concat-based key
- These are DIFFERENT storage slots!
- Disputes operate on empty state even after settlements

**Fix:** Unify to ONE key scheme (concat is canonical):

```solidity
// REMOVE the hashed pattern from settle() and prefundAccount()
// Use channelKey() everywhere:
bytes memory ch_key = channelKey(leftEntity, rightEntity);
```

**Files affected:** Depository.sol lines 527, 630

---

### Bug 2: disputeFinalize has NO on-chain state verification

**Problem:** `disputeFinalize()` never checks:
- `_channels[ch_key].disputeHash` (was a dispute actually started?)
- Stored timeout/expiry (is it past the dispute period?)

Current code at line 2060:
```solidity
// verify the dispute was started
// ← THIS COMMENT BUT NO CODE!
```

**Impact:** Anyone can call `disputeFinalize()` with fabricated params:
- No prior `disputeStart()` required
- Attacker provides their own `disputeUntilBlock`
- Bypasses dispute flow entirely

**Fix:**

```solidity
function disputeFinalize(FinalDisputeProof memory params) public nonReentrant returns (bool) {
  bytes memory ch_key = channelKey(bytes32(uint256(uint160(msg.sender))), params.counterentity);

  // ✅ ADD: Verify dispute was actually started
  require(_channels[ch_key].disputeHash != bytes32(0), "No active dispute");

  // ✅ ADD: Verify timeout using stored value, not caller-provided
  require(block.number >= _channels[ch_key].disputeTimeout, "Dispute period not ended");

  // ... rest of function ...

  // ✅ ADD: Clear dispute state after finalization
  delete _channels[ch_key].disputeHash;
  delete _channels[ch_key].disputeTimeout;
}
```

**Note:** Need to add `disputeTimeout` field to ChannelInfo struct.

---

### Bug 3: settle() bypasses enforceDebts

**Problem:** `settle()` can decrease reserves without enforcing FIFO debt repayment:

```solidity
// In settle() - NO enforceDebts call before reserve decrease!
if (diff.leftDiff < 0) {
  require(_reserves[leftEntity][tokenId] >= uint(-diff.leftDiff), "...");
  _reserves[leftEntity][tokenId] -= uint(-diff.leftDiff); // ← Decreases reserves
  // ← No debt enforcement!
}
```

**Compare with reserveToCollateral():**
```solidity
// enforceDebts is called FIRST
enforceDebts(entity, tokenId); // ← Correct!
// ...then reserves can decrease
```

**Impact:** Debtor can escape FIFO repayment by routing value through settlements instead of reserve operations.

**Fix:**

```solidity
function settle(...) public ... {
  // ... signature verification ...

  for (uint j = 0; j < diffs.length; j++) {
    SettlementDiff memory diff = diffs[j];
    uint tokenId = diff.tokenId;

    // ✅ ADD: Enforce debts before any reserve decrease
    if (diff.leftDiff < 0) {
      enforceDebts(leftEntity, tokenId);
    }
    if (diff.rightDiff < 0) {
      enforceDebts(rightEntity, tokenId);
    }

    // ... rest of settlement logic ...
  }
}
```

---

### Bug 4: _processBatch ignores some Batch fields (minor)

**Problem:** Batch struct has `externalTokenToReserve` and `reserveToExternalToken` fields but `_processBatch` doesn't process them.

**Impact:** Silent no-ops. Offchain encoders may include these expecting them to work.

**Fix:** Either:
1. Wire up these operations in _processBatch
2. Remove the fields from Batch struct (if not needed)

```solidity
// Option 1: Wire up (preferred)
function _processBatch(...) private {
  // ... existing operations ...

  // Process external token deposits
  for (uint i = 0; i < batch.externalTokenToReserve.length; i++) {
    externalTokenToReserve(entityId, batch.externalTokenToReserve[i]);
  }

  // Process external token withdrawals
  for (uint i = 0; i < batch.reserveToExternalToken.length; i++) {
    reserveToExternalToken(entityId, batch.reserveToExternalToken[i]);
  }
}
```

---

## Implementation Order

**BEFORE Account.sol extraction:**
1. Fix key scheme mismatch (Bug 1) - 30min
2. Fix disputeFinalize verification (Bug 2) - 30min
3. Add enforceDebts to settle (Bug 3) - 15min
4. Wire up batch fields or remove them (Bug 4) - 15min
5. Run tests, ensure no regressions - 30min

**Total bug fix time: ~2 hours**

**THEN proceed with Account.sol extraction:**
- Follow steps below (3-4 hours)

---

## Architectural Decision: Library vs External Contract

**Gemini3's argument for DisputeProvider (external contract):**
- Stateless computation is safer
- Can't corrupt storage (only returns results)
- Depository stays "Single Source of Truth" for writes

**GLM4.6's argument for Account.sol (library):**
- Standard Solidity pattern for size reduction
- No data passing overhead for return values
- DELEGATECALL shares storage context

**Decision: LIBRARY PATTERN WINS. Here's why:**

1. **XLN settlements are NOT pure computation:**
   - Must update _reserves, _collaterals, _debts atomically
   - External contract would need massive return structs OR callback pattern
   - Callback pattern is more complex than library

2. **Safety via immutability, not isolation:**
   - Library code is reviewed/audited same as main contract
   - Once deployed, library can't be modified
   - Storage corruption risk is same as any internal function

3. **Gas efficiency:**
   - Library: 1 DELEGATECALL, direct storage writes
   - External: CALL + encode params + decode return + apply updates
   - External would be 2-3x more gas

4. **Precedent:** OpenZeppelin uses libraries extensively (SafeMath, EnumerableSet, etc.)

**GLM4.6's Storage struct suggestion:**

```solidity
// Instead of 6+ mapping parameters:
struct Storage {
  mapping(bytes32 => mapping(uint => uint)) reserves;
  mapping(bytes => AccountInfo) accounts;
  mapping(bytes => mapping(uint => AccountCollateral)) collaterals;
  mapping(bytes32 => mapping(uint => Debt[])) debts;
}

// Single parameter:
function settle(Storage storage s, ...) external {
  s.reserves[leftEntity][tokenId] -= amount;
}
```

**Issue:** Solidity doesn't allow storage structs with mappings as struct members.
**Workaround:** Pass mappings individually (verbose but works).

---

## Problem Statement

**Current state:**
- Depository.sol: **39,345 bytes** (160% of 24KB limit)
- Cannot deploy to Base/Ethereum mainnet
- Already optimized: runs=1, removed cooperativeUpdate, removed TokenDebtStats

**EVM limit:**
- 24,576 bytes (24KB) per contract
- No exceptions on any chain (Ethereum, Base, Arbitrum, etc.)

**Need to reduce by:** 14,769 bytes (38%)

---

## Solution: Extract Account Operations to Library

**Create Account.sol library** containing all bilateral account operations:
- settle() - mutual agreement settlement
- disputeStart() - unilateral channel close
- disputeFinalize() - dispute resolution
- closeWithProof() - test helper (mutual close with proof)
- finalizeChannel() - applies ProofBody with subcontract execution
- _applyChannelDelta() - settlement math
- Account state management

**Keep in Depository.sol:**
- Storage mappings (_reserves, _debts, _accounts, _collaterals)
- Reserve management (mint, externalTokenToReserve, reserveToExternalToken)
- Debt enforcement (enforceDebts, _addDebt, _clearDebtAtIndex)
- Insurance (_claimFromInsurance)
- Batch coordination (processBatch, processBatchWithHanko)
- Flashloan validation
- Admin functions

---

## Expected Outcome

```
Account.sol (library):     12,000 bytes (49% of limit) ✅
Depository.sol (contract): 16,000 bytes (65% of limit) ✅

Total: 28KB deployed, but each individually under 24KB limit
```

---

## Architecture

### Before (Monolithic)
```
Depository.sol (39KB ❌)
├─ Storage
├─ Reserve operations
├─ Debt operations
├─ Account operations (settle, disputes)
└─ Batch coordination
```

### After (Library Pattern)
```
Depository.sol (16KB ✅)
├─ Storage (_reserves, _debts, _accounts, _collaterals)
├─ Reserve operations
├─ Debt operations
├─ Batch coordination
└─ Calls Account.sol via DELEGATECALL

Account.sol (library, 12KB ✅)
├─ settle() - bilateral settlement
├─ disputeStart() - unilateral dispute
├─ disputeFinalize() - resolution
├─ finalizeChannel() - applies proofs
├─ _applyChannelDelta() - settlement math
└─ Calls SubcontractProvider (external CALL)
```

---

## Terminology Changes

**Rename for consistency with XLN architecture:**

```solidity
// OLD (Lightning terminology):
mapping(bytes => ChannelInfo) public _channels;
mapping(bytes => mapping(uint => ChannelCollateral)) public _collaterals;
struct ChannelInfo { ... }
struct ChannelCollateral { ... }

// NEW (XLN terminology):
mapping(bytes => AccountInfo) public _accounts;
mapping(bytes => mapping(uint => AccountCollateral)) public _collaterals;
struct AccountInfo { ... }
struct AccountCollateral { ... }
```

**Rationale:** XLN calls bilateral relationships "accounts", not "channels" (see vibepaper/jea.md).

---

## Library Storage Access Pattern

**Solidity allows passing storage mappings to libraries:**

```solidity
// Account.sol (library)
library Account {
  function settle(
    // Storage parameters (passed by reference)
    mapping(bytes32 => mapping(uint => uint)) storage _reserves,
    mapping(bytes => AccountInfo) storage _accounts,
    mapping(bytes => mapping(uint => AccountCollateral)) storage _collaterals,

    // Data parameters
    bytes32 leftEntity,
    bytes32 rightEntity,
    SettlementDiff[] memory diffs,
    ...
  ) external returns (bool) {
    // Full read/write access to Depository storage
    _reserves[leftEntity][tokenId] -= amount; // ✅ Works!
    _accounts[accountKey].nonce++; // ✅ Works!

    // This executes in Depository's context via DELEGATECALL
  }
}

// Depository.sol
contract Depository {
  mapping(bytes32 => mapping(uint => uint)) public _reserves;
  mapping(bytes => AccountInfo) public _accounts;
  mapping(bytes => mapping(uint => AccountCollateral)) public _collaterals;

  function settle(...) public {
    return Account.settle(_reserves, _accounts, _collaterals, ...);
  }
}
```

**Key points:**
- ✅ Libraries execute via DELEGATECALL (same storage context)
- ✅ Can read/write Depository storage
- ✅ Library bytecode doesn't count toward Depository's 24KB limit
- ⚠️ Must pass storage mappings explicitly (verbose signatures)
- ⚠️ DELEGATECALL costs ~2,800 gas per call

---

## Gas Optimization: Batch Processing

**Instead of calling library per operation:**
```solidity
// ❌ Bad (N DELEGATECALLs):
for (uint i = 0; i < batch.settlements.length; i++) {
  Account.settle(_reserves, _accounts, _collaterals, batch.settlements[i]);
  // 20 settlements = 20 × 2,800 gas = 56,000 gas overhead
}
```

**Call library once per batch:**
```solidity
// ✅ Good (1 DELEGATECALL):
Account.processBatch(_reserves, _accounts, _collaterals, batch, entityId);
// Inside library:
for (uint i = 0; i < batch.settlements.length; i++) {
  _settle(batch.settlements[i]); // Internal call, no DELEGATECALL
}
// Only 2,800 gas overhead regardless of batch size!
```

---

## Functions to Extract to Account.sol

### Primary Functions (~600 lines)
1. **settle()** (165 lines, lines 627-791)
   - Bilateral settlement with SettlementDiff[]
   - Signature verification (counterparty ECDSA + caller Hanko)
   - Debt forgiveness
   - Insurance registration

2. **disputeStart()** (39 lines, lines 2013-2051)
   - Post initial dispute proof
   - Start timeout period
   - Update dispute hash

3. **disputeFinalize()** (48 lines, lines 2054-2098)
   - Respond with newer proof OR timeout
   - Call finalizeChannel()

4. **closeWithProof()** (41 lines, lines 1969-2009)
   - Test helper: skip timeout, mutual agreement
   - TODO: Consider removing for production

5. **finalizeChannel()** (103 lines, lines 1720-1822)
   - Apply ProofBody to deltas
   - Execute subcontracts via SubcontractProvider
   - Validate allowances
   - Apply final state

6. **_applyChannelDelta()** (48 lines, lines 1906-1953)
   - Convert delta to reserve changes
   - Handle shortfalls (create debts)
   - Call _settleShortfall

7. **_settleShortfall()** (28 lines, lines 1963-1990)
   - Pay from reserves
   - Claim from insurance
   - Create debt if underfunded

### Helper Functions (~100 lines)
8. **channelKey()** (3 lines, line 1693)
9. **logChannel()** (14 lines, line 2283)
10. **_increaseReserve()** (7 lines, line 1955)

**Total: ~700 lines estimated = 12-14KB savings**

---

## Functions to Keep in Depository.sol

### Reserve Operations (~250 lines)
- mintToReserve()
- debugBulkFundEntities()
- externalTokenToReserve()
- reserveToExternalToken()
- prefundAccount()
- reserveToReserve() (the struct version used internally)
- reserveToCollateral()

### Debt Operations (~400 lines)
- enforceDebts() / _enforceDebts()
- _addDebt()
- _clearDebtAtIndex()
- _syncDebtIndex()
- _countRemainingDebts()
- _afterDebtCleared()
- getDebts(), listActiveDebts(), previewEnforceDebts()

### Insurance Operations (~200 lines)
- _claimFromInsurance()
- getInsuranceLines(), getInsuranceLinesCount(), getAvailableInsurance()

### Batch Coordination (~150 lines)
- processBatch()
- processBatchWithHanko()
- _processBatch() (becomes thin coordinator)

### Token & Provider Management (~150 lines)
- packTokenReference(), unpackTokenReference()
- addEntityProvider(), removeEntityProvider()
- registerHub()
- transferControlShares()

### Admin & Utilities (~100 lines)
- constructor()
- setEmergencyPause()
- disableTestModeForever()
- _verifyHankoForAction()

**Total: ~1,250 lines = 16-18KB**

---

## Implementation Steps

### Step 1: Create Account.sol (2h)

```solidity
// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import "./SubcontractProvider.sol";
import "./ECDSA.sol";

library Account {

  // Structs needed (copy from Depository.sol)
  struct AccountInfo { ... }
  struct AccountCollateral { ... }
  struct SettlementDiff { ... }
  struct ProofBody { ... }
  struct InitialDisputeProof { ... }
  struct FinalDisputeProof { ... }
  struct CooperativeDisputeProof { ... }
  enum MessageType { ... }

  // Main entry point (called once per batch)
  function processBatch(
    mapping(bytes32 => mapping(uint => uint)) storage _reserves,
    mapping(bytes32 => mapping(uint => Debt[])) storage _debts,
    mapping(bytes => AccountInfo) storage _accounts,
    mapping(bytes => mapping(uint => AccountCollateral)) storage _collaterals,
    Batch memory batch,
    bytes32 entityId
  ) external returns (bool completeSuccess) {
    completeSuccess = true;

    // Process settlements
    for (uint i = 0; i < batch.settlements.length; i++) {
      if (!_settle(_reserves, _accounts, _collaterals, batch.settlements[i], entityId)) {
        completeSuccess = false;
      }
    }

    // Process dispute starts
    for (uint i = 0; i < batch.disputeStarts.length; i++) {
      if (!_disputeStart(_accounts, batch.disputeStarts[i])) {
        completeSuccess = false;
      }
    }

    // Process dispute finalizations
    for (uint i = 0; i < batch.disputeFinalizations.length; i++) {
      if (!_disputeFinalize(_reserves, _debts, _accounts, _collaterals, batch.disputeFinalizations[i])) {
        completeSuccess = false;
      }
    }

    return completeSuccess;
  }

  // Internal functions (no DELEGATECALL overhead)
  function _settle(...) internal returns (bool) { ... }
  function _disputeStart(...) internal returns (bool) { ... }
  function _disputeFinalize(...) internal returns (bool) { ... }
  function _finalizeChannel(...) internal returns (bool) { ... }
  function _applyChannelDelta(...) internal { ... }
  function _settleShortfall(...) internal { ... }
}
```

### Step 2: Update Depository.sol (1h)

```solidity
contract Depository {
  // ... storage unchanged ...

  function _processBatch(bytes32 entityId, Batch memory batch) private {
    // ... flashloan grant ...
    // ... reserveToReserve processing ...

    // Delegate ALL account operations to library (1 DELEGATECALL)
    bool accountSuccess = Account.processBatch(
      _reserves,
      _debts,
      _accounts,
      _collaterals,
      batch,
      entityId
    );

    if (!accountSuccess) {
      completeSuccess = false;
    }

    // ... flashloan validation ...
    // ... gas tracking ...

    return completeSuccess;
  }

  // Remove these functions (moved to Account.sol):
  // - settle()
  // - disputeStart()
  // - disputeFinalize()
  // - closeWithProof()
  // - finalizeChannel()
  // - _applyChannelDelta()
  // - _settleShortfall()
}
```

### Step 3: Rename Channels → Accounts (30m)

**Global find/replace:**
```bash
# In Depository.sol:
_channels → _accounts
ChannelInfo → AccountInfo
ChannelCollateral → AccountCollateral
channelKey → accountKey
logChannel → logAccount

# Keep these as-is (already correct):
ChannelSettled event (external API, don't break)
```

### Step 4: Compile & Test (1h)

```bash
# Compile with new structure
bunx hardhat compile --force

# Expected sizes:
# Account.sol: ~12KB
# Depository.sol: ~16KB

# Run tests
bunx hardhat test

# All 20 Hanko tests should still pass
```

### Step 5: Deploy (30m)

```bash
# Deploy to Base Sepolia (testnet)
bunx hardhat run scripts/deploy.js --network baseSepolia

# Test basic operations
# Deploy to Base mainnet
```

---

## Code Migration Details

### Functions Moving to Account.sol

**From Depository.sol lines:**
- settle() (627-791) → Account._settle()
- disputeStart() (2013-2051) → Account._disputeStart()
- disputeFinalize() (2054-2098) → Account._disputeFinalize()
- closeWithProof() (1969-2009) → Account._closeWithProof()
- finalizeChannel() (1720-1822) → Account._finalizeChannel()
- _applyChannelDelta() (1906-1953) → Account._applyChannelDelta()
- _settleShortfall() (1963-1990) → Account._settleShortfall()

**Structs to copy to Account.sol:**
- AccountInfo (was ChannelInfo)
- AccountCollateral (was ChannelCollateral)
- SettlementDiff
- Settlement
- ProofBody
- SubcontractClause
- Allowence
- InitialDisputeProof
- FinalDisputeProof
- CooperativeDisputeProof
- MessageType enum

**Events to copy to Account.sol:**
```solidity
event SettlementProcessed(...);
event ChannelSettled(Settled[]); // Keep name for backwards compat
event DisputeStarted(...);
event CooperativeClose(...);
```

---

## Storage Mapping Parameters

**Account.sol functions need access to these mappings:**

```solidity
// Core storage (passed to most functions)
mapping(bytes32 => mapping(uint => uint)) storage _reserves;
mapping(bytes32 => mapping(uint => Debt[])) storage _debts;
mapping(bytes => AccountInfo) storage _accounts;
mapping(bytes => mapping(uint => AccountCollateral)) storage _collaterals;

// Also needed by some functions:
mapping(bytes32 => EntityScore) storage entityScores;
mapping(bytes32 => uint256) storage insuranceCursor;
mapping(bytes32 => InsuranceLine[]) storage insuranceLines; // Or mapping(bytes32 => mapping(uint => InsuranceLine[])) after fix
```

**Pattern:**
```solidity
function settle(
  mapping(...) storage _reserves,
  mapping(...) storage _accounts,
  // ... all needed mappings ...
  bytes32 leftEntity,
  bytes32 rightEntity,
  SettlementDiff[] memory diffs
) external {
  // Can now read/write all storage as if internal
}
```

---

## Dependency on SubcontractProvider

**Account.sol must call SubcontractProvider:**

```solidity
// In Account._finalizeChannel():
for (uint256 i = 0; i < proofbody.subcontracts.length; i++) {
  SubcontractClause memory sc = proofbody.subcontracts[i];

  // External CALL (not DELEGATECALL) - untrusted code
  int[] memory newDeltas = SubcontractProvider(sc.subcontractProviderAddress).applyBatch(
    deltas,
    sc.encodedBatch,
    decodedLeft[i],
    decodedRight[i]
  );

  // Validate allowances
  // Apply new deltas
}
```

**Import needed:**
```solidity
import "./SubcontractProvider.sol";
import "./ECDSA.sol";
```

---

## Gas Cost Analysis

**DELEGATECALL overhead:**
- Base cost: ~700 gas
- Additional: ~2,100 gas
- **Total per DELEGATECALL: ~2,800 gas**

**Current batch processing:**
```
processBatch() contains:
- 0-N settlements
- 0-M disputes
- Other operations

Without library: 0 DELEGATECALL overhead
With library: 1 DELEGATECALL per batch (Account.processBatch)

Gas increase: 2,800 gas per batch (regardless of settlement/dispute count)
```

**Is this acceptable?**
- Typical batch: 50,000-200,000 gas
- 2,800 gas = 1.4-5.6% overhead
- ✅ Acceptable for ability to deploy

**Worst case (20 disputes in one batch):**
- Without library: 20 separate dispute calls (if done individually)
- With library: 1 DELEGATECALL, then 20 internal calls
- Savings: 19 × 2,800 = 53,200 gas saved!

---

## Testing Strategy

### Unit Tests (Account.sol)

**Create test/Account.test.cjs:**
```javascript
describe("Account Library", function () {
  it("Should settle with correct diffs", async function () {
    // Deploy Depository + Account library
    // Call settle via Depository
    // Verify reserves updated correctly
  });

  it("Should start dispute with valid proof", async function () {
    // Test disputeStart
  });

  it("Should finalize dispute after timeout", async function () {
    // Test disputeFinalize
  });

  it("Should execute subcontracts during finalization", async function () {
    // Test finalizeChannel with SubcontractProvider
  });
});
```

### Integration Tests

**Verify existing tests still pass:**
```bash
bunx hardhat test test/Depository.ts
bunx hardhat test test/HankoAuthorization.test.cjs

# All should pass after refactor
```

### Manual Testing
1. Deploy to local Hardhat node
2. Test full flow: settle → dispute → finalize
3. Verify gas costs acceptable
4. Check storage state correct

---

## Deployment Procedure

### Deploy Account.sol Library First
```bash
# 1. Deploy library
bunx hardhat run scripts/deploy-account-lib.js --network base

# Output: Account library deployed at 0xLIBRARY_ADDRESS
```

### Link Library to Depository
```solidity
// hardhat.config.cjs
networks: {
  base: {
    // ...
    libraries: {
      Account: "0xLIBRARY_ADDRESS" // Address from step 1
    }
  }
}
```

### Deploy Depository
```bash
# 2. Deploy Depository (automatically links to Account library)
bunx hardhat run scripts/deploy-depository.js --network base

# Output: Depository deployed at 0xDEPOSITORY_ADDRESS
```

**Note:** Library must be deployed BEFORE Depository, then linked during Depository deployment.

---

## Risks & Gotchas

### 1. Storage Layout Must Match
```solidity
// Depository.sol and Account.sol must agree on:
- Struct definitions (AccountInfo, AccountCollateral, etc.)
- Enum values (MessageType)
- Mapping types

// If mismatch → storage corruption!
```

**Mitigation:** Copy structs/enums exactly, add comments marking as "MUST MATCH DEPOSITORY.SOL"

### 2. Event Definitions

Events emitted from library are logged as if from Depository:
```solidity
// In Account.sol:
emit SettlementProcessed(...); // Event appears as Depository.SettlementProcessed

// Event must be defined in Depository.sol, not Account.sol!
```

**Mitigation:** Keep event definitions in Depository, re-emit from library.

### 3. Function Visibility

Library functions must be `external` or `public` to be called via DELEGATECALL:
```solidity
// ❌ Won't work:
function settle(...) internal { ... } // Can't call from Depository

// ✅ Correct:
function settle(...) external { ... } // DELEGATECALL works
```

### 4. Modifier Access

Libraries can't use Depository modifiers directly:
```solidity
// ❌ Won't work in library:
function settle(...) external nonReentrant { ... }

// ✅ Workaround:
// Keep nonReentrant in Depository wrapper:
function settle(...) public nonReentrant {
  return Account.settle(_reserves, ...);
}
```

---

## File Structure After Refactor

```
contracts/
├── Account.sol (NEW - library, 700 lines, 12KB)
│   ├─ settle()
│   ├─ disputeStart()
│   ├─ disputeFinalize()
│   ├─ finalizeChannel()
│   └─ Account helper functions
│
├── Depository.sol (MODIFIED - contract, 1,250 lines, 16KB)
│   ├─ Storage mappings
│   ├─ Reserve operations
│   ├─ Debt operations
│   ├─ Insurance operations
│   └─ Batch coordination (calls Account.sol)
│
├── EntityProvider.sol (unchanged, 1,119 lines, ~18KB)
└── SubcontractProvider.sol (unchanged, 155 lines, 4KB)

test/
├── Account.test.cjs (NEW - tests for Account library)
├── HankoAuthorization.test.cjs (unchanged, should pass)
└── Depository.ts (unchanged, should pass)
```

---

## Alternative Considered: Why Not Separate Contracts?

**Could do:**
```solidity
contract AccountManager {
  function settle(...) external { ... }
}

contract Depository {
  AccountManager accountManager;

  function settle(...) public {
    accountManager.settle(...); // External CALL
  }
}
```

**Why library is better:**
- ✅ Libraries use DELEGATECALL (share storage) - no need to pass data back
- ✅ Libraries don't add deployment complexity (no separate contract to manage)
- ✅ Libraries are stateless (easier to reason about)
- ❌ External contracts would need storage replication or complex callbacks

---

## Success Criteria

**Must achieve:**
1. ✅ Account.sol compiles to <24KB
2. ✅ Depository.sol compiles to <24KB
3. ✅ All 20 Hanko authorization tests pass
4. ✅ Existing Depository tests pass
5. ✅ Gas costs <5% increase per batch
6. ✅ Deployable to Base mainnet

**Nice to have:**
1. Account.sol < 20KB (room for future features)
2. Depository.sol < 20KB (room for future features)
3. No regression in functionality
4. Clean separation of concerns

---

## Rollback Plan

**If refactor fails:**
1. Revert Depository.sol to previous version (git)
2. Alternative: Deploy to chain with unlimited size (local only)
3. Alternative: Remove more features (closeWithProof, debug functions)
4. Alternative: Multi-contract architecture (more complex)

**Git branches:**
```bash
git checkout -b refactor/account-library
# Do refactor
# Test
# If fails: git checkout main
```

---

## Post-Refactor Optimization Opportunities

**After successful extraction, could further optimize:**

1. **Remove console.log statements** (-2KB)
   - Already in library, low impact on debugging
   - Can use events instead

2. **Custom errors instead of strings** (-1KB)
   ```solidity
   // Instead of:
   require(amount > 0, "Amount must be positive");

   // Use:
   error AmountZero();
   if (amount == 0) revert AmountZero();
   ```

3. **Remove closeWithProof()** (-1KB)
   - Test helper, not needed for production
   - Forces proper dispute flow

4. **Optimize struct packing** (-0.5KB)
   - Check if any structs can use smaller types

**Total potential: -4.5KB → Final size ~19KB with headroom**

---

## Questions for Reviewer

1. **Is Account.sol the right name?** Or prefer AccountLib, BilateralAccount, ChannelManager?

2. **Should closeWithProof() be included?** It's a test helper that skips timeout - might want to remove for production security.

3. **Event emission strategy:**
   - Keep events in Depository and emit from library? (current plan)
   - Or define events in library?

4. **Struct location:**
   - Copy structs to Account.sol? (duplication)
   - Or import from shared file?

5. **Is one DELEGATECALL per batch acceptable gas overhead?**

6. **Should we extract insurance to separate library too?**
   - InsuranceLib.sol would save another ~3KB
   - But adds more DELEGATECALL overhead

7. **Better way to avoid passing 6+ storage mappings as parameters?**

---

## Expected Timeline

**Total: 4-5 hours**

```
Step 1: Create Account.sol                    2h
Step 2: Update Depository.sol                 1h
Step 3: Rename channels → accounts            30m
Step 4: Compile & test                        1h
Step 5: Deploy to Base                        30m
```

**Earliest deployment:** 4-5 hours from now

---

## References

- **EIP-170:** Contract size limit (24KB)
- **Solidity docs:** Libraries and storage
- **Current contract:** `/Users/zigota/xln/jurisdictions/contracts/Depository.sol`
- **XLN architecture:** `/Users/zigota/xln/vibepaper/jea.md`

---

## Approval Checklist

Before starting implementation:

- [ ] Confirm Account.sol is correct name
- [ ] Confirm function extraction list is complete
- [ ] Confirm gas overhead acceptable (~2,800 per batch)
- [ ] Confirm testing strategy adequate
- [ ] Confirm deployment procedure correct
- [ ] Review by: _______________ (second reviewer)
- [ ] Approved by: _______________ (project lead)

---

**Status:** Ready for review
**Next step:** Get approval, then implement
**ETA to deploy:** 4-5 hours after approval

---

*Created: 2024-12-05*
*Author: Claude (Marvin)*
*Review by: [Pending]*
