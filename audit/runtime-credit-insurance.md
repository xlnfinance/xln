# Credit & Insurance Audit

## Executive Summary

The XLN runtime implements a bilateral credit/insurance system with on-chain debt enforcement via FIFO queues. Credit limits are enforced at the account-utils layer through the `deriveDelta()` function, while insurance coverage and debt tracking are handled on-chain in `Depository.sol`.

**Audit Scope**: Runtime credit flow, debt tracking, insurance payout mechanisms, and default handling.

**Key Findings**: 4 Critical, 3 High, 5 Medium issues identified.

---

## Critical (P0)

- [ ] **C1: Credit limit bypass via HTLC hold timing** - `deriveDelta()` deducts HTLC holds from capacity but validation timing allows same-frame over-commitment. If multiple HTLC locks are proposed in a single frame before validation completes, the hold amounts are not aggregated until commit phase.
  - File: `/Users/zigota/xln/runtime/account-utils.ts:92-99`
  - File: `/Users/zigota/xln/runtime/account-tx/handlers/htlc-lock.ts:124-132`
  - Impact: Entity can lock more capacity than available by submitting multiple HTLCs in single frame
  - Fix: Aggregate holds before capacity check OR enforce single HTLC per frame

- [ ] **C2: Default credit limit is 0 but demo function creates non-zero limits** - `BASE_CREDIT_LIMIT = 0n` but `createDemoDelta()` calls `getDefaultCreditLimit()` which returns `0n * 10^decimals = 0n`. However, some code paths create deltas with hardcoded defaults.
  - File: `/Users/zigota/xln/runtime/account-utils.ts:22,169-185`
  - File: `/Users/zigota/xln/runtime/account-tx/handlers/direct-payment.ts:43-54`
  - Impact: Inconsistent credit extension - some paths use 0, others use `getDefaultCreditLimit()`
  - Fix: Audit all delta creation paths for consistent credit defaults

- [ ] **C3: Insurance cursor skipping vulnerability** - In `_claimFromInsurance()`, the cursor only advances when insurance is claimed, but expired/wrong-token lines accumulate. If attacker floods with many expired insurance registrations, valid insurance at higher indices becomes inaccessible.
  - File: `/Users/zigota/xln/jurisdictions/contracts/Depository.sol:960-992`
  - Impact: Denial of valid insurance claims via stale line accumulation
  - Fix: Add periodic cleanup or use linked list with removal

- [ ] **C4: Debt can go negative incorrectly in runtime state** - `EntityState.debts` array tracks debts but `DebtEnforced` handler directly assigns `remainingAmount` without validation. If on-chain event sends corrupted data, runtime state becomes invalid.
  - File: `/Users/zigota/xln/runtime/entity-tx/j-events.ts:663-679`
  - Impact: Corrupted debt tracking if blockchain event data is malformed
  - Fix: Add validation `remainingAmount >= 0` before assignment

---

## High (P1)

- [ ] **H1: Credit limit can exceed MAX_CREDIT_LIMIT** - `handleSetCreditLimit()` validates `amount > MAX_CREDIT_LIMIT` but the check uses the scaled value (`FINANCIAL.MAX_PAYMENT_AMOUNT * 1000n`). Token with 18 decimals could overflow.
  - File: `/Users/zigota/xln/runtime/account-tx/handlers/set-credit-limit.ts:10-11,22-27`
  - Impact: Potential overflow for high-decimal tokens
  - Fix: Validate per-token after scaling

- [ ] **H2: No interest calculation implemented** - The codebase has no interest accrual mechanism for credit usage. Credit is essentially free, creating economic imbalance.
  - Files: All credit-related handlers
  - Impact: No incentive structure for credit extension, potential exploitation
  - Mitigation: Document as intentional design OR implement interest

- [ ] **H3: Settlement conservation law not enforced in runtime** - Contract enforces `leftDiff + rightDiff + collateralDiff = 0` but runtime `SettlementWorkspace` does not validate this invariant before signing.
  - File: `/Users/zigota/xln/runtime/types.ts:1000-1008`
  - File: `/Users/zigota/xln/jurisdictions/contracts/Account.sol:358`
  - Impact: Invalid settlements may be signed off-chain, wasting gas on-chain rejection
  - Fix: Add conservation check in `settle_propose/update` handlers

---

## Medium (P2)

- [ ] **M1: Debt FIFO iteration limit (100) may leave debts unpaid** - `enforceDebts()` limits to 100 iterations. Entity with >100 debts in a token only gets partial enforcement per call.
  - File: `/Users/zigota/xln/jurisdictions/contracts/Depository.sol:730-731`
  - Impact: Creditors at index >100 must wait for multiple `enforceDebts` calls
  - Mitigation: Document limitation, provide `enforceDebtsLarge()` for authorized callers

- [ ] **M2: Insurance registration allows self-insurance** - Contract checks `reg.insurer != reg.insured` but runtime scenario simulates cross-entity. No validation prevents entity from being insured by itself via intermediary.
  - File: `/Users/zigota/xln/jurisdictions/contracts/Depository.sol:917-920`
  - Impact: Circular insurance arrangements possible
  - Fix: Track insurance graph to detect cycles

- [ ] **M3: InsuranceLine expiry uses `block.timestamp`** - Timestamp-based expiry is manipulable by miners within limits.
  - File: `/Users/zigota/xln/jurisdictions/contracts/Depository.sol:920,966`
  - Impact: Minor timing manipulation for insurance expiry
  - Mitigation: Accept as known Solidity limitation

- [ ] **M4: Credit limit side (`left`/`right`) not validated against caller** - `handleSetCreditLimit()` accepts canonical `side` parameter but does not verify caller is authorized to set that side's limit.
  - File: `/Users/zigota/xln/runtime/account-tx/handlers/set-credit-limit.ts:50-58`
  - Impact: If frame proposal is accepted, either party can set either credit limit
  - Fix: Validate `side` matches proposer's canonical position

- [ ] **M5: Derived credit used tracking may overflow** - `peerCreditUsed` and `ownCreditUsed` are calculated from deltas but not bounds-checked for theoretical edge cases.
  - File: `/Users/zigota/xln/runtime/account-utils.ts:63-65`
  - Impact: Unlikely but possible display issues for extreme deltas
  - Fix: Add nonNegative() wrapper

---

## Credit System Analysis

### Architecture

```
                    +-----------------+
                    |   Runtime (R)   |
                    |  deriveDelta()  |
                    +--------+--------+
                             |
         +-------------------+-------------------+
         |                                       |
+--------v--------+                     +--------v--------+
|  AccountMachine |                     |  JurisdictionEVM |
|  - deltas Map   |                     |  - _reserves     |
|  - locks Map    |                     |  - _debts        |
|  - swapOffers   |                     |  - insuranceLines|
+-----------------+                     +------------------+
```

### Credit Flow

1. **Extension**: `set_credit_limit` AccountTx sets `leftCreditLimit` or `rightCreditLimit` on a Delta
2. **Usage**: `direct_payment` checks `deriveDelta().outCapacity` which includes credit
3. **Capacity**: `totalCapacity = collateral + ownCreditLimit + peerCreditLimit`
4. **Holds**: HTLC and swap holds reduce available capacity via `leftHtlcHold/rightHtlcHold`

### Debt Flow

1. **Creation**: On settlement shortfall, `_settleShortfall()` calls `_addDebt()`
2. **Enforcement**: `enforceDebts()` is called before any reserve transfer
3. **Insurance Claim**: If reserves insufficient, `_claimFromInsurance()` attempts coverage
4. **FIFO Order**: Debts paid in chronological order via `_debtIndex` cursor

### Insurance Flow

1. **Registration**: Via `InsuranceRegistration[]` in settlement
2. **Claim Trigger**: Automatic in `_enforceDebts()` when reserves exhausted
3. **Payment**: Insurer reserves debited, creditor credited, debt created from insured to insurer
4. **Expiry**: Timestamp-based, checked at claim time

### Credit Limit Enforcement Points

| Layer | Function | Enforcement |
|-------|----------|-------------|
| Runtime | `deriveDelta()` | Calculates available capacity including credit |
| Runtime | `handleDirectPayment()` | Checks `outCapacity >= amount` |
| Runtime | `handleHtlcLock()` | Checks capacity after hold deduction |
| Contract | `_settleDiffs()` | Checks reserve sufficiency |
| Contract | `_applyAccountDelta()` | Creates debt for shortfall |

### Known Limitations

1. **No interest accrual**: Credit is free
2. **No credit scoring**: All entities treated equally
3. **No partial insurance**: Either fully covered or creates debt
4. **Single-token debts**: No cross-token debt netting

---

## Files Reviewed

| File | Purpose | Lines |
|------|---------|-------|
| `/Users/zigota/xln/runtime/account-utils.ts` | deriveDelta, credit calculations | 228 |
| `/Users/zigota/xln/runtime/account-tx/handlers/set-credit-limit.ts` | Credit limit handler | 63 |
| `/Users/zigota/xln/runtime/account-tx/handlers/direct-payment.ts` | Payment with credit checks | 237 |
| `/Users/zigota/xln/runtime/account-tx/handlers/htlc-lock.ts` | HTLC with hold tracking | 152 |
| `/Users/zigota/xln/runtime/entity-tx/j-events.ts` | Debt event handlers | ~700 |
| `/Users/zigota/xln/runtime/types.ts` | Delta, Debt, Insurance types | 1853 |
| `/Users/zigota/xln/runtime/constants.ts` | FINANCIAL limits | 264 |
| `/Users/zigota/xln/runtime/validation-utils.ts` | Delta validation | 468 |
| `/Users/zigota/xln/runtime/financial-utils.ts` | BigInt math helpers | 173 |
| `/Users/zigota/xln/runtime/state-helpers.ts` | Account perspective helpers | 731 |
| `/Users/zigota/xln/runtime/scenarios/insurance-cascade.ts` | Insurance test scenario | 153 |
| `/Users/zigota/xln/jurisdictions/contracts/Depository.sol` | On-chain debt/insurance | 1191 |
| `/Users/zigota/xln/jurisdictions/contracts/Account.sol` | Settlement diffs | 452 |

---

## Recommendations

1. **Immediate**: Fix C1 (HTLC hold timing) - add aggregate check before capacity validation
2. **Short-term**: Add runtime conservation law validation (H3)
3. **Medium-term**: Implement insurance cursor cleanup mechanism (C3)
4. **Long-term**: Consider interest accrual design for credit sustainability (H2)

---

*Audit Date: 2026-01-27*
*Auditor: Claude Opus 4.5*
