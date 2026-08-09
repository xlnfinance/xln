# XLN Smart Contract Architecture

## Contract Structure

### Current Architecture (Optimal)

**EntityProvider.sol** (605 lines)
- Entity registration & naming
- Board/quorum management
- Governance tokens (ERC1155)
- Quorum replacement voting
- Articles of incorporation

**Depository.sol** (991 lines)
- Multi-asset reserves
- Channel collateral
- Debt tracking
- Token transfers (ERC20/721/1155)
- Batch processing

**Design Rationale:**
- EntityProvider = Identity + Governance (logical pairing)
- Depository = Assets + Channels (logical pairing)
- Both contracts focused and manageable (< 1000 lines each)
- Gas efficient governance operations (no cross-contract calls)
- Proven pattern in DeFi (similar to Uniswap v3)

---

## Integrated Governance System

XLN implements Meta/Alphabet-style dual-class governance with tradeable control and dividend tokens built into EntityProvider.

### Token ID Scheme

```
controlTokenId = entityNumber
dividendTokenId = entityNumber | 0x8000000000000000000000000000000000000000000000000000000000000000
```

The first bit determines control vs dividend token. Integrators derive the
entity number locally by clearing that bit; EntityProvider deliberately has no
parallel on-chain reverse-lookup API.

### Foundation Entity (#1)

- Created automatically on deployment
- Has own control/dividend tokens
- Can replace quorums with maximum delay (10,000 blocks)
- `nextNumber` starts at 2 for user entities

### Articles of Incorporation

Stored as `keccak256(abi.encode(articles))`:
- Gas savings on storage updates
- Immutable after creation
- Brought in calldata for verification

---

## BCD Priority System

**Board-Control-Dividend hierarchy:**

| Proposer   | Can Override/Cancel         | Delay Source                |
|------------|----------------------------|-----------------------------|
| CONTROL    | BOARD, DIVIDEND proposals  | Board.controlChangeDelay    |
| BOARD      | DIVIDEND proposals only    | Board.boardChangeDelay      |
| DIVIDEND   | Cannot cancel anyone       | Board.dividendChangeDelay   |

**TradFi-Style Transitions:**
- Current board remains active during transition
- Configurable delays prevent channel proof expiration
- No dual power - only one active board hash per entity

---

## Entity Creation Workflow

### Step 1: Entity Registration
```solidity
registerNumberedEntity(boardHash) → entityNumber = 42
```

### Step 2: Governance Setup
```solidity
setupGovernance(
  entityNumber: 42,
  holders: ['founder', 'public_investors', 'employees', 'vcs'],
  controlAmounts: [510, 200, 150, 140],      // Total: 1000 (100%)
  dividendAmounts: [100, 600, 200, 100],     // Total: 1000 (100%)
  articles: {
    controlChangeDelay: 1000,
    boardChangeDelay: 500,
    dividendChangeDelay: 3000,
    controlThreshold: 510  // 51%
  }
)
```

**Result:**
- Creates tokens 42 (control) and 0x800...042 (dividend)
- Mints according to initial distribution
- Stores `articlesHash` in `entities[42]`

### Step 3: Trading (ERC1155)
```solidity
safeTransferFrom(founder, activist_investor, 42, 100, "")
```
- Activist receives 100 control tokens (10%)
- `totalControlSupply` automatically tracked

### Step 4: Quorum Replacement Proposal
```solidity
proposeQuorumReplacement(
  entityNumber: 42,
  newQuorum: new_quorum_hash,
  proposerType: CONTROL,
  articles: {...}
)
```

**Result:**
- Proposal saved with delay = 1000 blocks (from articles)
- Event: `QuorumReplacementProposed`

### Step 5: Execution After Delay
```solidity
executeQuorumReplacement(
  entityNumber: 42,
  supporters: ['founder', 'activist_investor'],
  articles: {...}
)
```

**Result:**
- Verification: delay passed + 51% control support
- `entities[42].currentBoardHash = newQuorum`
- Event: `QuorumReplaced`

---

## Emergency Scenarios

### 🚨 Hostile Takeover Prevention
1. Hostile entity buys 40% control tokens
2. Proposes quorum replacement (delay = 1000 blocks)
3. During delay, incumbent holders can:
   - Buy tokens back
   - Organize defensive coalition
   - Propose alternative quorum

### 🚨 Dividend Shareholder Coordination
1. Dividend holders dissatisfied with management
2. Organize 51%+ coalition
3. Propose new quorum (delay = 3000 blocks)
4. Control holders can cancel and propose their own

### 🚨 Foundation Emergency Intervention
1. All shareholders unavailable/disappeared
2. Entity paralyzed > 1 month
3. Foundation proposes new quorum (delay = 10000 blocks)
4. No one can cancel → executes

---

## Key Contract Functions

### Entity & Governance
```solidity
registerNumberedEntity(boardHash) → entityNumber
setupGovernance(entityNumber, holders[], controlAmounts[], dividendAmounts[], articles)
```

### Token Operations (ERC1155)
```solidity
balanceOf(holder, tokenId) → amount
safeTransferFrom(from, to, tokenId, amount, data)
getTokenIds(entityNumber) → (controlTokenId, dividendTokenId)
```

### Quorum Replacement
```solidity
proposeQuorumReplacement(entityNumber, newQuorum, proposerType, articles)
executeQuorumReplacement(entityNumber, supporters[], articles)
```

---

## Contract Size Analysis

| Contract       | Current Lines | With Libraries | Target  | Status |
|----------------|---------------|----------------|---------|--------|
| EntityProvider | 605           | ~450           | < 800   | ✅     |
| Depository     | 991           | 991            | < 1000  | ✅     |

**Both within reasonable limits.**

---

## Architecture Decision

**Current two-contract split is optimal because:**

1. **Simple & Effective** - 2 contracts easier to deploy/manage
2. **Gas Efficient** - No cross-contract calls for governance operations
3. **Maintainable** - Clear responsibilities, manageable size
4. **Production Ready** - Less surface area for bugs, easier auditing

**When to split:** Only if EntityProvider exceeds 1000 lines or governance becomes significantly more complex.

---

## XLN vs Traditional DAOs

### Traditional DAO Limitations
- ❌ One token = control + economics
- ❌ Can't sell economics separately
- ❌ Whale governance inevitable
- ❌ Expensive ERC20 transfers
- ❌ No emergency coordination

### XLN Advantages
- ✅ Control/dividend separation (Meta/Alphabet style)
- ✅ ERC1155 gas efficiency
- ✅ Multi-layer emergency system
- ✅ Priority-based proposal cancellation
- ✅ Immutable articles of incorporation
- ✅ Foundation fallback protection
- ✅ Automatic token supply tracking

---

## Deployment Checklist

- ✅ EntityProvider inherits ERC1155
- ✅ Foundation entity #1 created automatically
- ✅ nextNumber starts at 2
- ✅ Token ID scheme with first bit differentiation
- ✅ Priority system for cancellation
- ✅ Articles hash verification
- ✅ Multi-delay system
- ✅ Automatic supply tracking
- ✅ Event emissions for indexing
- ✅ Gas optimizations
