# Depository.sol - Core Logic Summary

**2069 lines → Essential architecture (no signatures/proofs)**

---

## 📊 DATA STRUCTURES

### Reserves (Entity Balances)
```solidity
mapping(bytes32 => mapping(uint => uint)) public _reserves;  // entityId => tokenId => amount
```

### Channels (Bilateral State)
```solidity
mapping(bytes => ChannelInfo) public _channels;  // channelKey => info
mapping(bytes => mapping(uint => ChannelCollateral)) public _collaterals;  // locked per token

struct ChannelInfo {
  uint cooperativeNonce;
  uint disputeNonce;
  uint disputeStartedAt;
  mapping(uint => int) ondelta;  // net balance delta per token
}

struct ChannelCollateral {
  uint left;   // collateral locked by left entity
  uint right;  // collateral locked by right entity
}
```

### Debts (FIFO Queue - Mechanical Enforcement)
```solidity
mapping(bytes32 => mapping(uint => Debt[])) public _debts;  // entityId => tokenId => queue
mapping(bytes32 => mapping(uint => uint)) public _debtIndex;  // current head position
mapping(bytes32 => uint) public _activeDebts;  // total active debts across all tokens

struct Debt {
  bytes32 creditor;
  uint amount;
}
```

### Reputation Scores
```solidity
struct EntityScore {
  uint64 totalGasUsed;      // activity metric
  uint48 inDebtSince;       // timestamp when debt started (0 = clear)
  uint32 totalActiveDebts;  // outstanding debt count
  uint32 totalDisputes;     // dispute counter
  uint32 totalRepayments;   // reliability metric
  uint32 totalForgivenDebts;
}
mapping(bytes32 => EntityScore) public entityScores;
```

---

## 🔄 CORE OPERATIONS

### 1. External Token → Reserve (Deposit)
```solidity
function externalTokenToReserve(ExternalTokenToReserve memory params) {
  // ERC20/721/1155 transfer to contract
  // Increase entity reserve: _reserves[entity][tokenId] += amount
}
```

### 2. Reserve → External Token (Withdraw)
```solidity
function reserveToExternalToken(bytes32 entity, ReserveToExternalToken memory params) {
  enforceDebts(entity, tokenId);  // ⚠️ CRITICAL: Always enforce debts first
  require(_reserves[entity][tokenId] >= amount);
  _reserves[entity][tokenId] -= amount;
  // Transfer ERC20/721/1155 to recipient
}
```

### 3. Reserve → Reserve (Entity-to-Entity Transfer)
```solidity
function reserveToReserve(bytes32 fromEntity, bytes32 toEntity, uint tokenId, uint amount) {
  enforceDebts(fromEntity, tokenId);  // Always enforce first
  require(_reserves[fromEntity][tokenId] >= amount);
  _reserves[fromEntity][tokenId] -= amount;
  _reserves[toEntity][tokenId] += amount;
}
```

### 4. Reserve → Collateral (Lock in Channel)
```solidity
function reserveToCollateral(bytes32 entity, ReserveToCollateral memory params) {
  bytes memory key = channelKey(entity, params.counterentity);

  // Decrease reserve
  require(_reserves[entity][params.tokenId] >= params.collateral);
  _reserves[entity][params.tokenId] -= params.collateral;

  // Increase channel collateral (left or right side based on entity ordering)
  bool isLeft = entity < params.counterentity;
  if (isLeft) {
    _collaterals[key][params.tokenId].left += params.collateral;
  } else {
    _collaterals[key][params.tokenId].right += params.collateral;
  }

  // Update channel delta
  _channels[key].ondelta[params.tokenId] += params.ondelta;
}
```

### 5. Cooperative Channel Update
```solidity
function cooperativeUpdate(bytes32 entity, CooperativeUpdate memory params) {
  bytes memory key = channelKey(entity, params.counterentity);

  // Update cooperative nonce (prevents replay)
  _channels[key].cooperativeNonce = params.cooperativeNonce;

  // Apply deltas
  for (uint i = 0; i < params.diff.length; i++) {
    Diff memory d = params.diff[i];
    _channels[key].ondelta[d.tokenId] += d.delta;
  }
}
```

### 6. Channel Settlement (Close + Distribute)
```solidity
function settle(bytes32 entity, Settlement[] memory settlements) {
  for (uint i = 0; i < settlements.length; i++) {
    Settlement memory s = settlements[i];
    bytes memory key = channelKey(entity, s.counterentity);

    // Finalize channel state
    int finalDelta = _channels[key].ondelta[s.tokenId];
    uint leftColl = _collaterals[key][s.tokenId].left;
    uint rightColl = _collaterals[key][s.tokenId].right;

    // Calculate final balances based on delta
    (uint leftFinal, uint rightFinal) = _applyChannelDelta(finalDelta, leftColl, rightColl);

    // Return to reserves
    _reserves[entity][s.tokenId] += (entity < s.counterentity) ? leftFinal : rightFinal;
    _reserves[s.counterentity][s.tokenId] += (entity < s.counterentity) ? rightFinal : leftFinal;

    // Clear channel
    delete _collaterals[key][s.tokenId];
    delete _channels[key].ondelta[s.tokenId];
  }
}
```

---

## 💰 DEBT MECHANISM (First in Crypto History)

**Innovation:** Escrowed collateral + credit extension + mechanical enforcement

### Create Debt
```solidity
function _addDebt(bytes32 debtor, uint256 tokenId, bytes32 creditor, uint256 amount) internal {
  uint index = _debts[debtor][tokenId].length;
  _debts[debtor][tokenId].push(Debt({creditor: creditor, amount: amount}));
  _activeDebts[debtor]++;

  // Update reputation
  if (entityScores[debtor].inDebtSince == 0) {
    entityScores[debtor].inDebtSince = uint48(block.timestamp);
  }
  entityScores[debtor].totalActiveDebts++;

  emit DebtCreated(debtor, creditor, tokenId, amount, index);
}
```

### Enforce Debts (FIFO - Liquidity Trap)
```solidity
function _enforceDebts(bytes32 entity, uint256 tokenId, uint256 maxIterations) internal {
  uint currentIndex = _debtIndex[entity][tokenId];
  Debt[] storage queue = _debts[entity][tokenId];
  uint available = _reserves[entity][tokenId];

  for (uint i = 0; i < maxIterations && currentIndex < queue.length; i++) {
    Debt storage debt = queue[currentIndex];

    if (available >= debt.amount) {
      // Full payment
      available -= debt.amount;
      _reserves[entity][tokenId] -= debt.amount;
      _reserves[debt.creditor][tokenId] += debt.amount;

      _clearDebtAtIndex(entity, tokenId, currentIndex, true);
      currentIndex++;
    } else if (available > 0) {
      // Partial payment
      debt.amount -= available;
      _reserves[entity][tokenId] = 0;
      _reserves[debt.creditor][tokenId] += available;
      available = 0;
      break;  // LIQUIDITY TRAP: Stuck until more reserves added
    } else {
      break;  // No reserves available
    }
  }

  _debtIndex[entity][tokenId] = currentIndex;
}
```

**Key Property:** Debts are paid in order created (FIFO). If reserve insufficient, entity is trapped until debt head is cleared.

---

## 🔀 BATCH PROCESSING

```solidity
struct Batch {
  uint[] cooperativeNonces;
  Settlement[] settlements;
  ReserveToReserve[] reserveToReserves;
  ReserveToCollateral[] reserveToCollaterals;
  CooperativeUpdate[] cooperativeUpdates;
  Allowance[] allowances;
  SubcontractClause[] subcontracts;
  ExternalTokenToReserve[] externalTokenToReserves;
  ReserveToExternalToken[] reserveToExternalTokens;
}

function processBatch(bytes32 entity, Batch calldata batch) public {
  // Process all operations atomically
  // 1. External deposits (add reserves)
  // 2. Reserve-to-collateral (lock in channels)
  // 3. Cooperative updates (update channel deltas)
  // 4. Settlements (close channels, return collateral)
  // 5. Reserve-to-reserve transfers (entity payments)
  // 6. External withdrawals (after enforcing debts)

  // Each operation enforces debts as needed
  // All succeed or all revert (atomic batch)
}
```

---

## 🛡️ SECURITY INVARIANTS

1. **Reserve Conservation:** Sum of all reserves + locked collateral = Total tokens held by contract
2. **Debt Ordering:** Debts paid strictly FIFO per (entity, tokenId)
3. **Channel Symmetry:** `channelKey(A, B) == channelKey(B, A)` (canonical ordering)
4. **Reentrancy Protection:** All public functions use `nonReentrant` modifier
5. **Emergency Pause:** Admin can pause all operations except views

---

## 📐 MATHEMATICS

### Channel Delta Application
```solidity
function _applyChannelDelta(int delta, uint leftColl, uint rightColl) internal pure
  returns (uint leftFinal, uint rightFinal)
{
  int leftBalance = int(leftColl) + delta;
  int rightBalance = int(rightColl) - delta;

  leftFinal = leftBalance > 0 ? uint(leftBalance) : 0;
  rightFinal = rightBalance > 0 ? uint(rightBalance) : 0;
}
```

**Example:**
- Left collateral: 100
- Right collateral: 50
- Delta: +30 (left owes right 30)
- Final: left=70, right=80

---

## 🔗 MULTI-PROVIDER ARCHITECTURE

```solidity
mapping(address => bool) public approvedEntityProviders;
address[] public entityProvidersList;

function addEntityProvider(address provider) external onlyAdmin;
function removeEntityProvider(address provider) external onlyAdmin;
```

**Design:** Depository agnostic to entity registration. Multiple EntityProvider contracts can be approved. Each EntityProvider implements its own entity ID scheme (numbered, hash-based, ERC1155, etc).

---

## 🎯 KEY DIFFERENCES FROM LIGHTNING

| Feature | Lightning | XLN Depository |
|---------|-----------|----------------|
| Credit Extension | ❌ No (collateral = limit) | ✅ Yes (can exceed collateral) |
| Enforcement | Social (route fails) | Mechanical (FIFO debt queue) |
| Collateral Type | Native coin only | Any ERC20/721/1155 |
| Multi-token | ❌ No | ✅ Yes (per channel) |
| Debt History | ❌ No tracking | ✅ Full reputation system |

**Core Innovation:** First system combining escrowed collateral, credit extension, and mechanical enforcement without social/legal layer.
