# Orderbook Audit

**Auditor**: Claude Opus 4.5
**Date**: 2026-01-27
**Scope**: `/runtime/orderbook/` (core.ts, types.ts, index.ts)

## Executive Summary

The orderbook implementation is a well-designed pure-function limit order book using Struct-of-Arrays (SoA) for performance. The matching algorithm follows price-time priority correctly. However, several issues were identified ranging from potential manipulation vectors to subtle edge cases in fill ratio calculations.

**Overall Assessment**: Medium-High risk. Core matching logic is sound, but integration points and edge cases need attention.

---

## Critical (P0 - Fund loss/manipulation)

- [x] **CRITICAL-1: Integer Truncation in Price Calculation**
  - **Location**: `core.ts:396`, `types.ts:117-120`
  - **Issue**: Price calculation uses integer division `(wantAmount * 100n) / giveAmount` which truncates. For sell orders, the quantized price may round DOWN, giving taker a better price than maker intended.
  - **Example**: Maker wants 1001 for 1000 (price 1.001). `1001 * 100 / 1000 = 100` ticks. Actual execution is 1.00x, not 1.001x. Maker loses 0.1%.
  - **Impact**: Systematic value extraction from makers via precision loss.
  - **Fix**: Use fixed-point arithmetic with sufficient precision (e.g., 10^18 scale) or require aligned amounts.

- [x] **CRITICAL-2: No Validation of `priceTicks` Against TypedArray Bounds**
  - **Location**: `core.ts:444-448`
  - **Issue**: `levelIdx = Math.floor((priceTicks - pmin) / tick)` can produce negative values if `priceTicks < pmin`. The check `levelIdx < 0 || levelIdx >= levels` catches this, but TypedArray access at negative indices returns `undefined` silently, not throwing.
  - **Impact**: If bounds check is bypassed (unlikely but worth hardening), could corrupt state.
  - **Fix**: Already handled, but add explicit assertion: `if (levelIdx < 0) throw`.

- [x] **CRITICAL-3: Self-Trade Prevention (STP) Bypass via Owner String Collision**
  - **Location**: `core.ts:373-391`, `core.ts:246-253`
  - **Issue**: STP uses `ownerIdx` comparison which relies on `owners.indexOf(ownerId)`. If two different entities have the same `ownerId` string (e.g., truncated IDs), they would be treated as same owner.
  - **Impact**: STP would incorrectly cancel/reduce legitimate orders OR fail to prevent actual self-trades.
  - **Fix**: Ensure `ownerId` is always a unique canonical entity identifier (full entityId, not truncated).

- [x] **CRITICAL-4: No Atomicity Guarantee for Partial Fills**
  - **Location**: `core.ts:470-527` (FOK/IOC simulation), `entity-tx/handlers/account.ts:797-868`
  - **Issue**: FOK simulation runs BEFORE mutation but doesn't account for STP policy correctly. The simulation skips self-trades but the actual fill loop might behave differently if state changes between simulation and execution.
  - **Impact**: FOK orders might execute when they shouldn't, or reject when they should fill.
  - **Fix**: The current design handles this by doing simulation on immutable state. Verified correct.

- [x] **CRITICAL-5: Same-Tick Order Batching Not Fully Atomic** *(FIXED per comment)*
  - **Location**: `entity-tx/handlers/account.ts:699-701`
  - **Issue**: Comment indicates this was previously a bug where same-tick offers didn't see each other's fills. Fixed via `bookCache`.
  - **Status**: Fixed. Verified `bookCache` is used correctly.

---

## High (P1)

- [ ] **HIGH-1: Determinism Risk - Map Iteration Order**
  - **Location**: `types.ts:156` (`books: Map<string, BookState>`)
  - **Issue**: `Map` iteration order in JavaScript is insertion order, which IS deterministic. However, if books are created in different orders on different nodes (e.g., first trade on pair A vs B), the iteration order could differ.
  - **Impact**: If any code iterates over `books` map and order matters, consensus could diverge.
  - **Fix**: Always sort book keys before iteration, or use a sorted data structure.

- [ ] **HIGH-2: Uint32 Overflow for Large Quantities**
  - **Location**: `core.ts:91-93`, `core.ts:54`
  - **Issue**: `orderQtyLots: Uint32Array` limits max quantity to 4,294,967,295 lots. With `LOT_SCALE = 10^12`, this is ~4294 ETH per order. While checked (`qtyLots > MAX_LOTS` in account.ts:745), overflow could occur during accumulation.
  - **Scenario**: Multiple trades in single batch exceed Uint32 when summed.
  - **Impact**: Silent overflow in `tradeQtySum` (which is BigInt - OK) but potential issues in fill tracking (`fillsPerOrder.filledLots` is `number`).
  - **Fix**: Use BigInt for fill tracking in account.ts.

- [ ] **HIGH-3: Price Grid Initialization is Dynamic**
  - **Location**: `entity-tx/handlers/account.ts:759-772`
  - **Issue**: Book creation uses `center = Number(priceTicks)` from first order to set `pmin/pmax`. If first order is at an extreme price, grid may not cover typical trading range.
  - **Impact**: Legitimate orders could be rejected as "out of range" after adversarial first order sets bad grid.
  - **Fix**: Use predefined price grids per pair, or allow grid expansion.

- [ ] **HIGH-4: `bumpHash` Uses Weak Hash Function**
  - **Location**: `core.ts:341-343`
  - **Issue**: `PRIME = 0x1_0000_01n` multiplication with XOR is not cryptographically secure. An attacker could craft orders that produce hash collisions.
  - **Impact**: Consensus might falsely agree on different states (hash collision attack).
  - **Fix**: Use keccak256 as noted in `computeBookHash` comment (line 744).

- [ ] **HIGH-5: REPLACE Command Loses Time Priority**
  - **Location**: `core.ts:627-677`
  - **Issue**: Price change via REPLACE cancels and re-adds order at tail of queue, losing time priority. This is standard exchange behavior BUT not documented.
  - **Impact**: Users might expect price improvement to maintain priority. Could be exploited for queue manipulation.
  - **Fix**: Document clearly. Consider price-improvement-only REPLACE that maintains priority.

---

## Medium (P2)

- [ ] **MEDIUM-1: Sub-LOT_SCALE Amounts Silently Truncate**
  - **Location**: `entity-tx/handlers/account.ts:727-728`
  - **Issue**: Comment acknowledges amounts below LOT_SCALE (10^12 wei) truncate to 0 lots. The code throws, but swap-offer.ts (line 105) only checks alignment for side=1.
  - **Impact**: Users could create swap offers that fail at orderbook integration.
  - **Fix**: Validate alignment in swap-offer handler for both sides.

- [ ] **MEDIUM-2: `owners` Array Grows Unboundedly**
  - **Location**: `core.ts:246-253`
  - **Issue**: New owners are appended to `owners[]` array forever. Never garbage collected even after all their orders are removed.
  - **Impact**: Memory leak over time. Could also affect `indexOf()` performance.
  - **Fix**: Implement owner compaction or use Map with reference counting.

- [ ] **MEDIUM-3: TypedArray Degradation After JSON Round-Trip**
  - **Location**: `core.ts:7-15` (TODO comment)
  - **Issue**: After snapshot restore, TypedArrays become regular JS arrays. Functional correctness preserved but performance degrades.
  - **Status**: Known issue, documented, priority medium.

- [ ] **MEDIUM-4: `minFillRatio` Not Enforced for GTC Orders**
  - **Location**: `core.ts:519-527`
  - **Issue**: Comment says "For GTC orders, minFillRatio is enforced at swap_resolve time". But if order rests and later fills below ratio, the user has no recourse.
  - **Impact**: Users might not understand that minFillRatio only applies to immediate fills.
  - **Fix**: Document clearly OR implement partial cancel if resting fill would violate ratio.

- [ ] **MEDIUM-5: No Rate Limiting on Order Submission**
  - **Location**: `core.ts:236` (applyCommand)
  - **Issue**: No limit on orders per owner, orders per tick, or total order rate. Attacker could spam orders to DoS the matching engine.
  - **Impact**: Performance degradation, consensus delays.
  - **Fix**: Add per-entity rate limits enforced at entity-tx layer.

- [ ] **MEDIUM-6: `fillRatio` Calculation Precision**
  - **Location**: `entity-tx/handlers/account.ts:849-851`
  - **Issue**: `fillRatio = (filledBig * BigInt(MAX_FILL_RATIO)) / originalBig` uses integer division. For small fills, precision loss could cause incorrect ratio.
  - **Example**: filled=1, original=65536 → ratio=0 (should be 1).
  - **Fix**: Round up: `(filledBig * MAX_FILL + originalBig - 1n) / originalBig`.

---

## Matching Algorithm Review

### Price-Time Priority: CORRECT
- Orders are enqueued at tail of price level (`enqueueTail`, line 288-310)
- Matching traverses from head (`fillAgainst` uses `levelHead`, line 354)
- Best bid is highest index (descending), best ask is lowest index (ascending)
- Priority: Best price first, then FIFO within price level

### Price Discovery: CORRECT
- Taker aggresses at limit price or better
- Maker price is execution price (taker gets price improvement if crossing inside spread)
- `fillAgainst` iterates through levels until price limit reached

### Fill Logic: MOSTLY CORRECT
- Partial fills correctly decrement maker quantity
- Remaining taker quantity correctly continues to next level
- FOK simulation prevents partial execution
- **Edge case**: STP policy 2 (reduce maker) also reduces `remaining`, which skips the self-trade quantity from taker's fill - this is intentional but subtle

### Determinism: MOSTLY DETERMINISTIC
- Pure functions with immutable state pattern
- No randomness or timestamps in core matching
- **Risk**: Map iteration order (HIGH-1), hash function weakness (HIGH-4)

---

## Spread Distribution Review

### Implementation: `types.ts:99-133`

- Spread allocated via basis points (BPS_BASE = 10000)
- Hub gets remainder after other allocations (avoids rounding dust loss) - **CORRECT**
- Validation ensures sum = 10000 - **CORRECT**
- `spread <= 0n` returns zero allocation - **CORRECT**

### Fairness: ACCEPTABLE
- Default 20% to each party is balanced
- Hub profile is public, users can compare hubs
- Referrer fees create incentive alignment

### Risk: LOW
- No obvious manipulation vectors in spread calculation
- Integer division rounds down consistently (hub absorbs dust)

---

## Files Reviewed

| File | Lines | Purpose |
|------|-------|---------|
| `/runtime/orderbook/core.ts` | 833 | Matching engine, order management |
| `/runtime/orderbook/types.ts` | 173 | Type definitions, spread distribution |
| `/runtime/orderbook/index.ts` | 10 | Re-exports |
| `/runtime/entity-tx/handlers/account.ts` | 690-912 | Orderbook integration |
| `/runtime/account-tx/handlers/swap-offer.ts` | 171 | Swap offer creation |

---

## Recommendations (Priority Order)

1. **[P0]** Fix CRITICAL-1: Use higher precision for price calculation or enforce lot-aligned amounts
2. **[P0]** Audit all `ownerId` usage to ensure uniqueness (CRITICAL-3)
3. **[P1]** Replace `bumpHash` with keccak256 (HIGH-4)
4. **[P1]** Use BigInt for fill tracking to prevent overflow (HIGH-2)
5. **[P1]** Document or fix REPLACE time priority behavior (HIGH-5)
6. **[P2]** Implement owner array compaction (MEDIUM-2)
7. **[P2]** Add rate limiting at entity-tx layer (MEDIUM-5)

---

## Appendix: Code Snippets

### CRITICAL-1: Price Truncation Example
```typescript
// core.ts:396
const pxTicks = pmin + levelIdx * tick;
// If maker submitted 1001/1000, levelIdx calculation already truncated
// Execution happens at truncated price
```

### HIGH-2: Potential Overflow
```typescript
// entity-tx/handlers/account.ts:807-811
const makerEntry = fillsPerOrder.get(event.makerOrderId);
if (!makerEntry) {
  fillsPerOrder.set(event.makerOrderId, {
    filledLots: event.qty,  // number, not BigInt
    originalLots: event.makerQtyBefore
  });
} else {
  makerEntry.filledLots += event.qty;  // Could overflow for huge batches
}
```

### MEDIUM-6: Fill Ratio Precision Loss
```typescript
// entity-tx/handlers/account.ts:849-851
const fillRatio = originalBig > 0n
  ? Number((filledBig * BigInt(MAX_FILL_RATIO)) / originalBig)
  : 0;
// Integer division: 1 * 65535 / 65536 = 0, not 1
```
