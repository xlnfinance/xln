# Solidity Contracts Audit

**Audit Date:** 2026-01-27
**Auditor:** Claude Opus 4.5
**Contracts Version:** Solidity ^0.8.24
**Scope:** jurisdictions/contracts/

## Executive Summary

The XLN protocol implements a bilateral reserve management system with hierarchical entity governance (Hanko signatures), delta transformers for HTLCs/swaps, and a debt/insurance mechanism. The codebase uses Solidity 0.8.24 with built-in overflow protection and includes custom reentrancy guards. **Critical issues identified include potential admin key centralization risks, unbounded loops in several functions, and a mock contract that could be accidentally deployed to production.**

---

## Critical (P0 - Fund loss possible)

- [ ] **MockEntityProvider bypasses ALL signature verification** - `jurisdictions/contracts/mocks/MockEntityProvider.sol:11`
  - `verifyHankoSignature()` always returns `(entityId, true)` regardless of input
  - If accidentally deployed to mainnet and set as an approved provider, ANY caller can authorize ANY transaction
  - **Impact:** Complete loss of all funds in Depository
  - **Recommendation:** Add compile-time guards, use different contract name pattern, or use constructor that reverts on mainnet chainId

- [ ] **Admin can drain all reserves via mintToReserve + reserveToReserve** - `Depository.sol:271,309`
  - `mintToReserve()` has no cap, admin can mint unlimited tokens
  - `reserveToReserve()` allows admin to transfer any entity's reserves
  - **Impact:** Complete fund drainage if admin key compromised
  - **Recommendation:** Implement timelock, multi-sig requirement for admin actions, or governance token voting

- [ ] **Immutable admin with no transfer mechanism** - `Depository.sol:68,192`
  - `admin` is set in constructor with no ability to change
  - If admin key is lost or compromised, no recovery possible
  - **Impact:** Permanent loss of administrative control or permanent compromise
  - **Recommendation:** Add admin transfer with timelock or use upgradeable proxy pattern

---

## High (P1 - Security risk)

- [ ] **EntityProvider unbounded loop in recoverEntity** - `EntityProvider.sol:375-384`
  ```solidity
  for (uint256 i = 1; i < nextNumber; i++) {
  ```
  - Iterates through ALL registered entities to find matching boardHash
  - Gas cost scales linearly with entity count; will hit block gas limit
  - **Impact:** Denial of service for Hanko verification after ~10,000 entities
  - **Recommendation:** Use mapping from boardHash to entityId instead of iteration

- [ ] **removeEntityProvider unbounded loop** - `Depository.sol:175-181`
  ```solidity
  for (uint i = 0; i < entityProvidersList.length; i++) {
  ```
  - Linear search through all providers
  - **Impact:** Gas griefing if many providers added
  - **Recommendation:** Use EnumerableSet or mapping with index

- [ ] **Debt enforcement can be blocked via debt spam** - `Depository.sol:730-741`
  - `enforceDebts()` limited to 100 iterations, `enforceDebtsLarge()` to 1000
  - Attacker can create many small debts to exhaust iterations before legitimate debt paid
  - **Impact:** Debt payment ordering manipulation
  - **Recommendation:** Add debt creation cost or minimum debt amount

- [ ] **Insurance cursor only advances on successful claims** - `Depository.sol:961-992`
  - Expired/wrong-token lines are skipped but cursor not advanced
  - If many lines expire, iteration starts from same position each time
  - **Impact:** Gas waste, potential DoS on insurance claims
  - **Recommendation:** Clean up expired lines or use different data structure

- [ ] **External call in _finalizeAccount before state completion** - `Depository.sol:1093`
  ```solidity
  int[] memory newDeltas = DeltaTransformer(tc.transformerAddress).applyBatch(...)
  ```
  - Calls external transformer contract before all state is finalized
  - Reentrancy guard is on, but malicious transformer could manipulate state
  - **Impact:** Transformer could exploit mid-execution state
  - **Recommendation:** Validate transformer is whitelisted before calling

- [ ] **flashloan aggregation logic allows same tokenId multiple times** - `Depository.sol:379-398`
  - While fixed for aggregation, the loop has O(n^2) complexity
  - For large flashloan arrays, could cause gas issues
  - **Impact:** Gas griefing
  - **Recommendation:** Use mapping for O(1) lookup

- [ ] **EntityProvider _detectSignatureCount has unbounded loop** - `EntityProvider.sol:574-588`
  ```solidity
  for (uint256 count = 1; count <= 16000; count++) {
  ```
  - Iterates up to 16000 times to detect signature count
  - **Impact:** High gas cost for signature verification
  - **Recommendation:** Calculate directly from length formula: `count = (len * 8) / (64 * 8 + 1)` (approximately)

---

## Medium (P2 - Best practice violation)

- [ ] **No event for admin change** - `Depository.sol`
  - `admin` is immutable, but if changed to mutable, no event exists
  - **Recommendation:** Add `AdminTransferred` event (preemptive)

- [ ] **Debug events left in production code** - `Depository.sol:126, EntityProvider.sol:696-698, Account.sol:45-48`
  - Multiple `Debug*` events increase contract size and gas cost
  - **Impact:** Unnecessary gas consumption, potential information leak
  - **Recommendation:** Remove before mainnet deployment

- [ ] **console.sol import in production contracts** - `DeltaTransformer.sol:9`
  - `import "hardhat/console.sol"` and `Console` inheritance
  - **Impact:** Increased contract size
  - **Recommendation:** Remove hardhat imports for production

- [ ] **Missing zero-address validation** - Multiple locations
  - `reserveToExternalToken()` sends to `address(uint160(uint256(params.receivingEntity)))` without validation - `Depository.sol:667-671`
  - Could send tokens to zero address if receivingEntity is bytes32(0)
  - **Recommendation:** Add `require(params.receivingEntity != bytes32(0))`

- [ ] **No input validation on batch array lengths** - `Depository.sol:248-261`
  - `processBatch` accepts arrays of arbitrary length
  - **Impact:** Could cause out-of-gas reverts mid-execution
  - **Recommendation:** Add reasonable max limits per batch

- [ ] **Insurance registration allows self-insurance** - `Depository.sol:919`
  - Check `reg.insurer == reg.insured` is present but on same line as other checks
  - Complex validation in single require could mask issues
  - **Recommendation:** Separate validation checks with distinct error messages

- [ ] **ECDSA library doesn't handle v=0/1** - `ECDSA.sol:63`
  - Only accepts v=27 or v=28, but some signing libraries return v=0/1
  - **Recommendation:** Add normalization like OpenZeppelin does

- [ ] **entityTransferTokens uses block.timestamp in hash** - `EntityProvider.sol:1071`
  - Signature includes `block.timestamp` making it valid only in same block
  - **Impact:** Legitimate transfers could fail if not mined in same block
  - **Recommendation:** Use nonce-based replay protection instead

- [ ] **DeltaTransformer.cleanSecret threshold too short** - `DeltaTransformer.sol:175`
  - `block.number - 100000` is only ~14 days at 12s blocks
  - HTLCs might have longer timeouts
  - **Recommendation:** Increase to 1M blocks or make configurable

- [ ] **Missing ERC1155 batch receive implementation** - `Depository.sol:1189`
  - `onERC1155BatchReceived` just reverts
  - **Impact:** Cannot receive batch ERC1155 transfers
  - **Recommendation:** Implement batch handler or document limitation

- [ ] **Settlement diff invariant check could underflow** - `Account.sol:358`
  - `if (diff.leftDiff + diff.rightDiff + diff.collateralDiff != 0)` uses signed int math
  - With extreme values, could have unexpected behavior
  - **Recommendation:** Add bounds checking before arithmetic

---

## Gas Optimization Opportunities

- [ ] **Use `calldata` instead of `memory` for view functions** - Multiple locations
  - `EntityProvider.getEntityInfo()` could take calldata params
  - ~2,000 gas savings per call

- [ ] **Cache array lengths in loops** - Multiple locations
  ```solidity
  // Before
  for (uint i = 0; i < array.length; i++)
  // After
  uint256 len = array.length;
  for (uint i = 0; i < len; i++)
  ```
  - `Depository.sol:426,442,454,467,475,481,489,494`
  - ~100 gas per iteration

- [ ] **Use `unchecked` for loop increments** - Multiple locations
  - Loop counters cannot overflow in practice
  - ~80 gas per iteration

- [ ] **Pack storage variables** - `Depository.sol:57-65`
  - `defaultDisputeDelay` (uint256) could be uint64
  - Could pack multiple uint64s in single slot

- [ ] **insuranceLines uses dynamic array** - `Depository.sol:526`
  - Each `push` costs ~20,000 gas for new slot
  - Consider linked list or bounded array

- [ ] **Use `++i` instead of `i++`** - Multiple locations
  - Saves ~5 gas per increment

- [ ] **Duplicate storage reads** - `Depository.sol:773-809`
  - `queue[cursor]` read multiple times in loop
  - Cache in memory variable

- [ ] **encodedBatch decoded twice** - `Depository.sol:259`
  - `abi.decode(encodedBatch, (Batch))` already done, but passed as raw bytes
  - Could save decode cost by passing struct

---

## Architecture Notes

### Contract Interaction Pattern
```
                    +-----------------+
                    | EntityProvider  |
                    | (ERC1155 tokens)|
                    | (Hanko verify)  |
                    +--------+--------+
                             |
                             | verifyHankoSignature()
                             v
+-------------+     +--------+--------+     +------------------+
|   Account   |<----|   Depository    |---->| DeltaTransformer |
|  (Library)  |     | (Main Storage)  |     | (HTLC/Swaps)     |
+-------------+     +-----------------+     +------------------+
```

### Key Design Decisions
1. **Bilateral accounts**: All settlements require counterparty signature (good for security)
2. **Hanko system**: Novel hierarchical entity signature scheme - creative but complex attack surface
3. **Flashloan pattern**: Entity can temporarily mint tokens within single tx (aggregation fix addresses duplicate tokenId exploit)
4. **Debt FIFO**: First-in-first-out debt repayment (fair but can be gamed via spam)

### Upgrade Considerations
- Contracts are NOT upgradeable (no proxy pattern)
- Admin is immutable - no governance transfer possible
- EntityProvider list can be modified - potential upgrade path
- Consider implementing EIP-1967 proxy if future upgrades needed

### Recommendations for Production
1. **Implement timelock** for admin functions (3-7 day minimum)
2. **Add circuit breakers** with graduated response (pause deposits, then all ops)
3. **Cap single transaction value** for dispute/settlement
4. **Add whitelist** for DeltaTransformer addresses
5. **Remove all debug events** and console imports
6. **Implement monitoring** for unusual reserve/collateral changes
7. **Consider formal verification** for Account library math

---

## Files Reviewed

| File | Lines | Purpose | Risk Level |
|------|-------|---------|------------|
| `Depository.sol` | 1191 | Main fund storage, settlements, disputes | HIGH |
| `EntityProvider.sol` | 1154 | Entity governance, Hanko signatures, ERC1155 | HIGH |
| `Account.sol` | 451 | Settlement/dispute library | MEDIUM |
| `DeltaTransformer.sol` | 190 | HTLC/swap logic | MEDIUM |
| `Types.sol` | 196 | Shared type definitions | LOW |
| `ECDSA.sol` | 98 | Signature recovery | LOW |
| `IDepository.sol` | 109 | Interface definition | LOW |
| `IEntityProvider.sol` | 111 | Interface definition | LOW |
| `IDeltaTransformer.sol` | 71 | Interface definition | LOW |
| `Token.sol` | 41 | ERC20 interface | LOW |
| `console.sol` | 54 | Debug logging | LOW |
| `ERC20Mock.sol` | 10 | Test helper | N/A |
| `ERC721Mock.sol` | 14 | Test helper | N/A |
| `ERC1155Mock.sol` | 12 | Test helper | N/A |
| `MockEntityProvider.sol` | 14 | **DANGEROUS** test helper | CRITICAL |

---

## Summary Statistics

| Severity | Count |
|----------|-------|
| Critical (P0) | 3 |
| High (P1) | 7 |
| Medium (P2) | 12 |
| Gas Optimizations | 8 |

**Overall Assessment:** The protocol implements novel bilateral settlement mechanics with creative use of hierarchical signatures. However, the admin centralization risks and unbounded loop patterns need addressing before mainnet deployment. The MockEntityProvider contract is a critical deployment risk and should be in a separate test-only package.
