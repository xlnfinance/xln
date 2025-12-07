# Solidity Contract Size Reduction - Expert Consultation Prompt

## Problem Statement

I have a Solidity contract (`Depository.sol`) that is **39,808 bytes** compiled with optimizer runs=1. The EVM limit is **24,576 bytes**. I need to reduce by **15,232 bytes (38%)** to deploy to Base/Ethereum mainnet.

**Critical constraint:** Must deploy TODAY (4-8 hour time budget).

---

## Current Contract Structure

**Depository.sol** - 2,316 lines, handles:

### Core Features (MUST KEEP):
1. **Reserve management** (~300 lines)
   - `_reserves` mapping: entity → tokenId → amount
   - `mintToReserve()`, `externalTokenToReserve()`, `reserveToExternalToken()`
   - Multi-token support (ERC20/721/1155)

2. **Debt enforcement** (~400 lines)
   - FIFO debt queue: `_debts[entity][tokenId]` array
   - `enforceDebts()` - iterates debt queue, pays from reserves
   - `_addDebt()`, `_clearDebtAtIndex()`, `_syncDebtIndex()`
   - Debt stats tracking

3. **Insurance system** (~200 lines)
   - `insuranceLines[entity]` array with InsuranceLine structs
   - `_claimFromInsurance()` - FIFO queue with gas cap
   - Cursor tracking for iteration resumption

4. **Bilateral settlement** (~350 lines)
   - `settle()` - mutual agreement with diffs (leftDiff + rightDiff + collateralDiff = 0)
   - Channel collateral management
   - Signature verification (ECDSA for counterparty)
   - Hanko signature verification for entity authorization

5. **Dispute resolution** (~300 lines)
   - `disputeStart()` - unilateral channel close initiation
   - `disputeFinalize()` - timeout or counterparty response
   - `closeWithProof()` - test helper, both parties agree
   - `finalizeChannel()` - internal, applies ProofBody with subcontracts

6. **Flashloans** (~50 lines, just re-enabled)
   - Track starting reserves
   - Grant loans (increase reserves)
   - Validate exact return at end of batch
   - Multi-token support

7. **Batch processing** (~200 lines)
   - `processBatch()` - test mode bypass
   - `processBatchWithHanko()` - production mode with Hanko auth
   - `_processBatch()` - internal coordinator

8. **Subcontract execution** (~150 lines)
   - ProofBody with allowances
   - Calls SubcontractProvider.applyBatch()
   - HTLC and swap support

### Helper Features (Negotiable):
- Hub registration (~20 lines) - gasused tracking
- Debug functions (~20 lines) - `debugBulkFundEntities()`, `debugFundReserve()`
- View functions (~40 lines) - `getUsers()`, `getChannels()`
- Reputation scores (~30 lines) - EntityScore struct

### Already Removed:
✅ cooperativeUpdate() - merged into settle()
✅ CooperativeUpdate struct

---

## What We've Tried

1. **Optimizer runs=1000 → runs=1**: 45KB → 39.8KB (5.2KB saved)
2. **Removed cooperativeUpdate()**: ~5KB saved
3. **Still 15.2KB over limit**

---

## Constraints

**MUST preserve:**
- Dispute system (core security - unilateral channel close)
- Debt enforcement (FIFO, mechanical repayment)
- Insurance (FIFO claims)
- Settlement with Hanko auth
- Flashloans (just re-enabled)
- Batch processing

**CAN remove/modify:**
- Helper functions (hubs, debug, views)
- Verbose console.log statements
- Test helpers (closeWithProof)
- Error message strings

**Time budget:** 4-8 hours max

---

## Library Pattern Context

Solidity libraries:
- Deployed separately, linked at deploy time
- Function code **does NOT count** toward contract 24KB limit
- Only storage remains in main contract
- Can use `delegatecall` to access main contract storage

**Example:**
```solidity
library DebtLib {
  function enforceDebts(
    mapping(bytes32 => mapping(uint => uint)) storage _reserves,
    mapping(bytes32 => mapping(uint => Debt[])) storage _debts,
    bytes32 entity,
    uint256 tokenId
  ) external returns (uint256) {
    // 400 lines of logic here
    // Doesn't count toward Depository.sol size!
  }
}

contract Depository {
  mapping(bytes32 => mapping(uint => uint)) public _reserves;
  mapping(bytes32 => mapping(uint => Debt[])) public _debts;

  function enforceDebts(bytes32 entity, uint tokenId) public {
    return DebtLib.enforceDebts(_reserves, _debts, entity, tokenId);
  }
}
```

---

## Questions for Expert

1. **Library extraction strategy:**
   - Which features should go to libraries first? (debt, insurance, settlement?)
   - Can I pass complex storage mappings to libraries efficiently?
   - Should I use `internal` libraries (embedded) or `external` (deployed separately)?

2. **Code size optimization tricks:**
   - Replace error strings with custom errors? (saves how much?)
   - Struct packing opportunities?
   - Function visibility changes? (external vs public)
   - Modifier inlining?

3. **Feature removal priorities:**
   - Is `closeWithProof()` safe to remove? (forces proper dispute flow)
   - Are view functions worth keeping? (`getUsers()`, `getChannels()`)
   - Can hub system be moved to separate contract?

4. **Quick wins:**
   - What are the top 3 fastest ways to save 5KB each?
   - Any compiler tricks I'm missing?
   - Alternative to libraries that's faster?

5. **Deployment strategy:**
   - If I use libraries, how many separate deployments?
   - Gas costs for library pattern vs monolithic?
   - Can I deploy libraries once and reuse across jurisdictions?

---

## Success Criteria

**Minimum viable:**
- Contract compiles to <24KB
- All core features work (debts, settlement, disputes, insurance, flashloans)
- Deployable to Base mainnet
- Tests still pass

**Ideal:**
- <20KB (room for future features)
- Clean architecture (easy to audit)
- Minimal gas overhead from libraries
- Fast implementation (<6 hours)

---

## Current Optimizer Settings

```javascript
// hardhat.config.cjs
solidity: {
  version: "0.8.24",
  settings: {
    optimizer: {
      enabled: true,
      runs: 1, // Already at minimum
    },
    viaIR: true, // Already enabled
  },
}
```

---

## Additional Context

- XLN = bilateral credit network with off-chain consensus
- Depository = on-chain settlement layer (J-machine)
- Entity = can be EOA or hierarchical board (Hanko signatures)
- Jurisdiction = blockchain instance (Ethereum, Base, Arbitrum, etc.)
- All actions require Hanko authorization (entity board signatures)
- Premium focus on security > gas efficiency

---

## What I Need From You

**Provide a concrete implementation plan:**

1. **Which functions to extract to libraries** (ranked by size savings)
2. **Step-by-step library extraction order** (with time estimates)
3. **Quick wins** (non-library tricks to save 1-2KB each)
4. **Risks** (what could break during extraction)
5. **Testing strategy** (how to verify nothing broke)

**Format:**
- Actionable steps (not just "use libraries")
- Code examples for tricky parts
- Time estimates for each step
- Expected bytecode savings per step

**Assume I'm competent with Solidity but haven't done library extraction before.**

---

## Example Library Structure (What I'm Considering)

```solidity
// Option A: Feature-based split
DebtLib.sol       (enforceDebts, addDebt, clearDebt)
InsuranceLib.sol  (claimFromInsurance, expiry checks)
SettlementLib.sol (settle logic, diff application)

// Option B: Pure function split
MathLib.sol       (pure calculations)
ValidationLib.sol (require checks)
StorageLib.sol    (storage operations)

// Option C: Just extract biggest function
EnforceDebtsLib.sol (just enforceDebts - 100 lines)
```

**Which approach is best for my constraints?**

---

**Please provide specific, actionable advice to get this contract deployed today.**

Include:
- Recommended library structure
- Code snippets for storage parameter passing
- Migration checklist
- Potential gotchas
- Time estimates

Thank you!
