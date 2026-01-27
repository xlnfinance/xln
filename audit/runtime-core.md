# Runtime Core Audit

**Audited by**: Claude Opus 4.5 (Security Review)
**Date**: 2026-01-27
**Scope**: /Users/zigota/xln/runtime/ (all TypeScript files)
**Protocol Version**: Pre-mainnet

## Executive Summary

The XLN runtime implements a sophisticated off-chain payment channel system with bilateral consensus (A-Machine), entity-level BFT consensus (E-Machine), and blockchain settlement (J-Machine). Overall architecture is sound with strong separation of concerns. However, several **critical issues** must be addressed before mainnet deployment, particularly around determinism violations, missing input validation, and potential state inconsistency edge cases.

**Risk Assessment**: MEDIUM-HIGH - Issues are fixable but require attention before handling real funds.

---

## Critical Issues (P0 - Must fix before mainnet)

### CRITICAL-1: Non-deterministic Operations in State Transitions
**File**: `/Users/zigota/xln/runtime/runtime.ts:155`
```typescript
const nowMs = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
```
**File**: `/Users/zigota/xln/runtime/htlc-utils.ts:67`
```typescript
const secretBytes = crypto.getRandomValues(new Uint8Array(32));
```
**Issue**: `Date.now()` in fallback path and `crypto.getRandomValues()` for HTLC secret generation violate determinism requirements. Different replicas may generate different values.
**Impact**: Consensus failure, state divergence between replicas.
**Fix**: Use `env.timestamp` exclusively. For HTLC secrets, derive from `env.runtimeSeed` + counter (already partially implemented in `deterministic-rng.ts` but not consistently used).

---

### CRITICAL-2: Missing Negative Amount Validation
**File**: `/Users/zigota/xln/runtime/account-tx/handlers/direct-payment.ts:22-26`
```typescript
if (amount < FINANCIAL.MIN_PAYMENT_AMOUNT || amount > FINANCIAL.MAX_PAYMENT_AMOUNT) {
```
**Issue**: `FINANCIAL.MIN_PAYMENT_AMOUNT = 10n ** 18n` (1 token). No explicit check for negative BigInt amounts. While BigInt comparison works, TypeScript doesn't enforce unsigned at compile time.
**Impact**: A malicious peer could craft a transaction with negative amount, potentially causing underflow.
**Fix**: Add explicit `amount < 0n` check at all entry points:
```typescript
if (amount < 0n || amount < FINANCIAL.MIN_PAYMENT_AMOUNT || amount > FINANCIAL.MAX_PAYMENT_AMOUNT)
```

---

### CRITICAL-3: setInterval/setTimeout in Consensus-Critical Paths
**Files**:
- `/Users/zigota/xln/runtime/runtime.ts:597` - `setInterval` for runtime tick
- `/Users/zigota/xln/runtime/j-event-watcher.ts:243` - `setInterval` for J-watcher
- `/Users/zigota/xln/runtime/scenarios/p2p-relay.ts:43,110,119,136` - Multiple timers in scenarios

**Issue**: Timer-based operations are inherently non-deterministic across different machines/loads.
**Impact**: In multi-node production, timing differences could cause consensus divergence.
**Fix**: For production, use explicit tick-based progression with env.timestamp increments, not wall-clock timers. The `scenarioMode` flag partially addresses this but needs broader application.

---

### CRITICAL-4: Swap/HTLC Amount Bounds Allow Overflow at Scale
**File**: `/Users/zigota/xln/runtime/constants.ts:41-42`
```typescript
MAX_PAYMENT_AMOUNT: 2n ** 128n - 1n, // U128 max
MAX_COLLATERAL: 2n ** 64n - 1n, // U64 max
```
**Issue**: MAX_PAYMENT_AMOUNT (U128) exceeds MAX_COLLATERAL (U64) by 64 bits. Multiple concurrent large payments could overflow collateral tracking.
**Impact**: Accounting corruption if total payments exceed U64.
**Fix**: Either align limits or add cumulative bounds checking in account state.

---

### CRITICAL-5: HTLC Reveal Height Validation Gap
**File**: `/Users/zigota/xln/runtime/account-tx/handlers/htlc-reveal.ts:45-51`
```typescript
if (currentHeight > lock.revealBeforeHeight) {
  return { success: false, error: `Lock expired by height...` };
}
```
**Issue**: Uses `>` instead of `>=`. If `currentHeight === revealBeforeHeight`, reveal still succeeds. This creates a 1-block window that may conflict with timeout processing.
**Impact**: Race condition between reveal and timeout at exact deadline block.
**Fix**: Change to `currentHeight >= lock.revealBeforeHeight` for strict deadline enforcement.

---

### CRITICAL-6: SwapBook Key Collision Risk
**File**: `/Users/zigota/xln/runtime/entity-tx/apply.ts:749-760`
```typescript
const swapBookKey = `${counterpartyEntityId}:${offerId}`;
newState.swapBook.set(swapBookKey, { ... });
```
**Issue**: Key construction uses counterpartyEntityId, but offerId is user-provided. If two different accounts (e.g., Alice-Hub and Alice-Bob) use same offerId, collision could occur.
**Impact**: Swap offer overwrite/corruption.
**Status**: Partially fixed per code comment "AUDIT FIX (CRITICAL-6)" - verify the fix is complete across all swap operations.

---

## High Priority (P1 - Should fix)

### HIGH-1: Message Counter Replay Window
**File**: `/Users/zigota/xln/runtime/account-consensus.ts:130-144`
```typescript
const MAX_MESSAGE_COUNTER = 1000000;
if (counter <= 0 || counter > MAX_MESSAGE_COUNTER) { ... }
```
**Issue**: Counter resets after 1M messages. Long-lived channels could wrap around, enabling replay attacks.
**Fix**: Either use BigInt for counter or implement counter epochs with height-based resets.

---

### HIGH-2: Frame Size Limit Not Enforced on Receipt
**File**: `/Users/zigota/xln/runtime/account-consensus.ts:76-77`
```typescript
const MAX_FRAME_SIZE_BYTES = 1048576; // 1MB frame size limit
```
**Issue**: Constant defined but no code enforces it when receiving/validating frames.
**Impact**: DOS via oversized frame submission.
**Fix**: Add size check in `validateAccountFrame()`:
```typescript
if (JSON.stringify(frame).length > MAX_FRAME_SIZE_BYTES) return false;
```

---

### HIGH-3: Missing Signature Verification on J-Events
**File**: `/Users/zigota/xln/runtime/entity-tx/apply.ts:206-216`
```typescript
if (entityTx.type === 'j_event') {
  // No signature verification before processing
  const { newState, mempoolOps } = await handleJEvent(entityState, entityTx.data, env);
```
**Issue**: J-events are accepted without cryptographic proof of blockchain inclusion.
**Impact**: Malicious node could inject fake J-events.
**Fix**: Require block header proof or trusted oracle signature for J-events.

---

### HIGH-4: Settlement Invariant Not Checked in All Paths
**File**: `/Users/zigota/xln/runtime/entity-tx/apply.ts:882-888`
```typescript
const sum = diff.leftDiff + diff.rightDiff + diff.collateralDiff;
if (sum !== 0n) {
  throw new Error(`Settlement invariant violation: ${sum} !== 0`);
}
```
**Issue**: Only checked in `settleDiffs` handler, not in `createSettlement` or `settle_execute` handlers.
**Fix**: Extract invariant check to shared function, call in all settlement paths.

---

### HIGH-5: Undefined Variable Reference in settleDiffs
**File**: `/Users/zigota/xln/runtime/entity-tx/apply.ts:892`
```typescript
if (!newState.accounts.has(settleAccountKey)) {
```
**Issue**: `settleAccountKey` is not defined - should be `counterpartyEntityId`.
**Impact**: Runtime crash on settlement attempt.
**Fix**: Replace with `counterpartyEntityId`.

---

### HIGH-6: Browser Math.random in Jurisdiction
**File**: `/Users/zigota/xln/runtime/jurisdiction/browser-jurisdiction.ts:112,139`
```typescript
hash: '0x' + Math.random().toString(16).slice(2),
```
**Issue**: Non-deterministic hash generation for browser jurisdiction transactions.
**Impact**: Browser-based testing produces non-reproducible results.
**Fix**: Use deterministic RNG seeded from env.

---

## Medium Priority (P2 - Nice to have)

### MEDIUM-1: Silent Error Swallowing
**File**: `/Users/zigota/xln/runtime/runtime.ts:1103-1105`
```typescript
} catch (e) {
  // Silent fail - stateRoot capture is optional for time-travel
}
```
**Issue**: Multiple `catch` blocks silently swallow errors without logging.
**Impact**: Debugging difficulty, hidden failures.
**Fix**: Add `console.warn()` with error context in all catch blocks.

---

### MEDIUM-2: Missing Type Guards for Union Types
**File**: `/Users/zigota/xln/runtime/types.ts:417-700`
**Issue**: `EntityTx` is a large discriminated union with 30+ variants. No runtime type guards provided.
**Fix**: Generate type guards for each variant to ensure safe narrowing.

---

### MEDIUM-3: Inconsistent Error Handling Patterns
**Files**: Various
**Issue**: Mix of `throw new Error()`, `return { success: false }`, and `logError()` patterns.
**Fix**: Standardize on Result type pattern for all handlers.

---

### MEDIUM-4: HTLC Fee Calculation Integer Division
**File**: `/Users/zigota/xln/runtime/htlc-utils.ts:18`
```typescript
const rateFee = (amount * HTLC.FEE_RATE_UBP) / HTLC.FEE_DENOMINATOR;
```
**Issue**: Integer division truncates. For small amounts, fee could round to 0.
**Fix**: Add minimum fee floor or document behavior.

---

### MEDIUM-5: Account Cloning Performance
**File**: `/Users/zigota/xln/runtime/state-helpers.ts:126-166`
**Issue**: `structuredClone` fallback to manual deep clone is expensive. Called on every transaction.
**Fix**: Implement copy-on-write or immutable data structures for performance.

---

### MEDIUM-6: Missing Input Sanitization for Entity Names
**File**: `/Users/zigota/xln/runtime/entity-factory.ts`
**Issue**: No validation that entity names don't contain special characters, SQL injection vectors, or excessive length.
**Fix**: Add name sanitization regex and length limits.

---

## Architecture Observations

### Strengths

1. **Clean RJEA Layering**: Runtime → Entity → Account → Jurisdiction hierarchy is well-documented and consistently implemented.

2. **Comprehensive Type System**: `types.ts` (1200+ lines) provides excellent type coverage with detailed JSDoc comments explaining consensus semantics.

3. **Determinism Awareness**: `CLAUDE.md` explicitly prohibits non-deterministic operations. Code includes `env.scenarioMode` flag for controlled testing.

4. **Bilateral Consensus Pattern**: Account consensus follows established 2-of-2 multisig patterns from Lightning Network with proper frame chaining.

5. **Financial Safety Checks**: `validation-utils.ts` implements validate-at-source pattern with custom error classes for financial data.

6. **Constants Centralization**: `constants.ts` consolidates all magic numbers with clear documentation.

### Areas for Improvement

1. **Test Coverage**: No test files found in main runtime folder beyond `__tests__/ids.test.ts`.

2. **Documentation-Code Sync**: Some inline comments reference "2024 patterns" from archived code - ensure current implementation matches.

3. **Error Recovery**: No explicit transaction rollback or compensation logic for partial failures in multi-step operations.

4. **Monitoring/Observability**: Limited structured logging. Consider adding OpenTelemetry spans for production debugging.

5. **Rate Limiting**: No explicit rate limits on mempool additions beyond MEMPOOL_SIZE check.

---

## Files Reviewed

| File | Lines | Risk Level |
|------|-------|------------|
| runtime/types.ts | ~1200 | Medium |
| runtime/runtime.ts | ~2000 | High |
| runtime/account-consensus.ts | ~1400 | Critical |
| runtime/entity-consensus.ts | ~1000 | High |
| runtime/entity-tx/apply.ts | ~960 | High |
| runtime/account-tx/apply.ts | ~250 | Medium |
| runtime/constants.ts | ~265 | Low |
| runtime/validation-utils.ts | ~470 | Medium |
| runtime/account-crypto.ts | ~430 | Critical |
| runtime/deterministic-rng.ts | ~100 | Medium |
| runtime/htlc-utils.ts | ~108 | High |
| runtime/account-utils.ts | ~200+ | Medium |
| runtime/state-helpers.ts | ~400+ | Medium |
| runtime/serialization-utils.ts | ~120 | Low |
| runtime/account-tx/handlers/direct-payment.ts | ~237 | High |
| runtime/account-tx/handlers/htlc-lock.ts | ~152 | Critical |
| runtime/account-tx/handlers/htlc-reveal.ts | ~127 | Critical |
| runtime/account-tx/handlers/swap-offer.ts | ~171 | High |
| runtime/time.ts | ~30 | Low |

**Total files in runtime/**: 100+ TypeScript files
**Manually reviewed**: 20+ core files (highest risk)

---

## Recommendations

### Immediate (Pre-Mainnet)
1. Fix CRITICAL-1 through CRITICAL-6
2. Add comprehensive negative value checks
3. Implement strict determinism audit (grep for Date.now, Math.random, setInterval)
4. Add frame size validation

### Short-Term (First Month)
1. Fix HIGH-1 through HIGH-6
2. Add unit tests for all handlers
3. Implement structured error logging

### Medium-Term (Quarter)
1. Address MEDIUM-1 through MEDIUM-6
2. Performance optimization for state cloning
3. Add integration test suite with chaos testing

---

## Appendix: Determinism Violations Summary

| Location | Violation | Severity |
|----------|-----------|----------|
| runtime.ts:155 | Date.now() fallback | Critical |
| htlc-utils.ts:67 | crypto.getRandomValues() | Critical |
| browser-jurisdiction.ts:112,139 | Math.random() | Medium |
| scenarios/swap-market.ts:915,974 | Date.now() | Low (test only) |
| scenarios/settle.ts:101 | Date.now() | Low (test only) |
| ws-server.ts:228 | setInterval | Low (I/O layer) |
| runtime.ts:270,387,597 | setTimeout/setInterval | Medium |

---

*This audit is a point-in-time review. Subsequent code changes require re-audit.*
