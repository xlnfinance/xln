# CRITICAL: EntityProvider O(N) Lookup Scalability Bug

**Severity:** CRITICAL (contract will brick at scale)
**Location:** `EntityProvider.sol:369` - `recoverEntity()` function
**Impact:** Contract unusable after ~2000-5000 entities

## THE BUG

```solidity
// EntityProvider.sol line 369-378
for (uint256 i = 1; i < nextNumber; i++) {
  bytes32 candidateEntityId = bytes32(i);
  if (entities[candidateEntityId].currentBoardHash == boardHash) {
    // Found matching entity
    return i;
  }
}
```

**Complexity:** O(N) where N = number of registered entities
**Gas Cost:** N × SLOAD ≈ N × 2100 gas
**Breaking Point:** ~5000 entities (105M gas vs 30M block limit)

## THE FIX

### Add Reverse Mapping

```solidity
// Add to EntityProvider.sol storage
mapping(bytes32 => uint256) public boardHashToEntityNumber;
```

### Update on Registration

```solidity
// In registerNumberedEntity() after line 197
boardHashToEntityNumber[boardHash] = entityNumber;
```

### O(1) Lookup

```solidity
// Replace recoverEntity() loop with:
function recoverEntity(
  bytes calldata encodedBoard,
  bytes calldata encodedSignature,
  bytes32 hash
) public view returns (uint256 entityId) {
  bytes32 boardHash = keccak256(encodedBoard);

  // O(1) lookup instead of O(N) loop
  uint256 candidateNumber = boardHashToEntityNumber[boardHash];

  if (candidateNumber == 0) {
    // Not a registered entity, try lazy entity
    return recoverLazyEntity(encodedBoard, encodedSignature, hash);
  }

  // Verify signature for registered entity
  uint16 boardResult = _verifyBoard(hash, encodedBoard, encodedSignature);
  require(boardResult > 0, "Invalid signature");

  return candidateNumber;
}
```

## IMPACT ANALYSIS

**Before Fix:**
- Entity #1: ~2K gas
- Entity #100: ~210K gas
- Entity #1000: ~2.1M gas
- Entity #5000: ~10.5M gas ❌ (exceeds block limit)

**After Fix:**
- Any entity: ~5K gas ✅ (constant)

## PRIORITY

**ASAP - before mainnet.** This is a day-1 exploit if deployed as-is.

## STATUS

- [ ] Add `boardHashToEntityNumber` mapping
- [ ] Update `registerNumberedEntity` to populate mapping
- [ ] Replace `recoverEntity` loop with O(1) lookup
- [ ] Add test: register 10K entities, verify last one still works
- [ ] Update IEntityProvider interface if needed

## RELATED

See also: All functions that iterate `for (uint256 i = 1; i < nextNumber; i++)`:
- `getEntitiesByBoard()` - also O(N), less critical (view function)
- Any other entity iteration patterns
