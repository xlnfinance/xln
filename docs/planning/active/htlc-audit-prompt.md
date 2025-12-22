# HTLC Implementation Audit Prompt

**Use this prompt with GPT-4, Claude Opus, or other LLM to audit the HTLC implementation**

---

## Context

XLN is a Byzantine Fault Tolerant off-chain settlement network with a layered R→E→A→J architecture:
- **R-layer (Runtime):** Orchestrates the system
- **E-layer (Entity):** BFT consensus for multi-party entities
- **A-layer (Account):** Bilateral consensus between entity pairs
- **J-layer (Jurisdiction):** On-chain EVM contracts

HTLCs (Hash Time-Locked Contracts) are being added as **delta transformers** at the A-layer to enable conditional payments with proof-of-payment.

## Implementation Summary

**What was implemented:**

1. **Types** (`runtime/types.ts`):
   - `HtlcLock` interface with lockId, hashlock, timelock, revealBeforeHeight
   - `HtlcRoute` for multi-hop routing (like 2024's hashlockMap pattern)
   - Extended `Delta` with `leftHtlcHold`/`rightHtlcHold` for capacity holds
   - Added `htlc_lock`, `htlc_reveal`, `htlc_timeout` to AccountTx union
   - Added `htlcPayment` to EntityTx union
   - Extended `EntityState` with `htlcRoutes` Map and `htlcFeesEarned` counter
   - Extended `AccountMachine` with `locks` Map
   - Extended `proofBody` with `htlcLocks` array for on-chain proofs

2. **Constants** (`runtime/constants.ts`):
   - `HTLC.MIN_TIMELOCK_DELTA_MS = 10000` (10s per hop)
   - `HTLC.FEE_RATE_UBP = 100n` (1 basis point = 0.001%)
   - `HTLC.DEFAULT_EXPIRY_MS = 30000` (30s)

3. **Handlers** (`runtime/account-tx/handlers/`):
   - `htlc-lock.ts`: Validates capacity (including existing holds), creates lock, updates hold
   - `htlc-reveal.ts`: Verifies secret hash, applies delta, releases hold, returns secret/hashlock
   - `htlc-timeout.ts`: Verifies expiry, releases hold without delta change

4. **Entity-level** (`runtime/entity-tx/handlers/htlc-payment.ts`):
   - Creates htlc_lock AccountTx for first hop
   - Generates secret/hashlock if not provided
   - Registers route in htlcRoutes Map
   - Follows exact pattern from directPayment handler

5. **Routing logic** (`runtime/entity-tx/handlers/account.ts`):
   - When HTLC lock received, checks if final recipient → reveals immediately
   - If intermediary → registers route + forwards with fee deduction
   - When reveal processed → propagates secret backward via htlcRoutes

6. **State management**:
   - `account-consensus.ts`: Added await to processAccountTx calls, collect revealedSecrets
   - `state-helpers.ts`: Clone htlcRoutes with defensive checks
   - Account initialization: Added `locks: new Map()` in 2 places

## Issues Found During Implementation

### Known Issues (Avoided/Not Fixed):

1. **revealedSecrets not propagating properly**
   - Collected in proposeAccountFrame
   - Passed through handleAccountInput
   - But entity-tx/handlers/account.ts isn't receiving them
   - Flow: proposeAccountFrame → handleAccountInput → entity-tx/handlers/account.ts
   - revealedSecrets returned from both functions but not wired through completely

2. **Bob recognizes final recipient but reveals aren't settling**
   - Bob adds htlc_reveal to mempool successfully
   - handleHtlcReveal processes and changes deltas correctly
   - But secret doesn't propagate backward to Hub→Alice
   - Likely because revealedSecrets flow is broken (see #1)

3. **Test assertions failing on Frame 7**
   - Error: "Hub-Bob account does NOT exist!"
   - Possibly caused by adding `byLeft?: boolean` to AccountFrame breaking frame creation
   - Or unrelated issue with account setup

4. **deriveDelta() doesn't auto-deduct holds**
   - htlc-lock.ts manually deducts: `availableCapacity = outCapacity - existingHold`
   - Works for HTLCs but other tx types won't see held capacity
   - Could allow double-spend if direct_payment doesn't check holds
   - Avoided: Didn't modify deriveDelta() signature to prevent breaking existing code

5. **Locks not included in frame hash**
   - Added locks to proofBody for on-chain disputes (correct per 2024 pattern)
   - But didn't add to frame hash computation
   - Avoided: Frame hash changes would break existing consensus, needs careful integration

6. **Secret hashing uses toUtf8Bytes**
   - `keccak256(toUtf8Bytes(secret))` instead of raw bytes
   - Doesn't matter for XLN (not interop with Lightning)
   - User explicitly rejected Lightning compatibility

7. **AccountFrame.byLeft added but not populated**
   - Added field to type but not setting it when creating frames
   - All frame creation sites need: `byLeft: isLeft(fromEntity, toEntity)`
   - Avoided: Would require updating 10+ frame creation sites

## Audit Tasks

Please review the implementation and answer:

### 1. Architecture Questions

- **Is HTLC routing logic in the right place?**
  - Currently in `entity-tx/handlers/account.ts` after processAccountInput returns
  - Checks committed frames for htlc_lock transactions
  - Should it be somewhere else?

- **Is the revealedSecrets propagation pattern correct?**
  - proposeAccountFrame collects secrets → returns revealedSecrets
  - handleAccountInput passes through revealedSecrets
  - entity-tx/handlers/account.ts iterates and propagates backward
  - What's missing in this chain?

- **Should deriveDelta() auto-deduct holds or is manual OK?**
  - Manual works for htlc-lock handler
  - But what about direct_payment, crontab checks, gossip capacity announcements?
  - Do they need hold-aware capacity?

### 2. Code Review

**Check these files for bugs:**

- `runtime/account-tx/handlers/htlc-lock.ts:69-86` - Is senderIsLeft logic correct?
- `runtime/entity-tx/handlers/htlc-payment.ts:133-138` - Is routingInfo structure correct?
- `runtime/entity-tx/handlers/account.ts:84-172` - HTLC routing logic placement and correctness
- `runtime/entity-tx/handlers/account.ts:208-239` - Secret propagation logic
- `runtime/account-consensus.ts:151-167` - revealedSecrets collection
- `runtime/account-consensus.ts:638-641` - revealedSecrets passthrough

**Specific questions:**

1. In `htlc-lock.ts`, `senderIsLeft` is derived from `isOurFrame` and proofHeader. Is this deterministic for both sides?

2. In `htlc-payment.ts`, routing info has `nextHop: route[1]`. For route [alice, hub, bob]:
   - Alice→Hub lock has nextHop=hub (correct)
   - Hub forwards with `route.slice(1)` which makes route=[hub, bob], so nextHop=bob (correct?)

3. In `account.ts:148-167`, Hub forwards HTLC by creating new routingInfo with `nextNextHop = forwardRoute[0]`. Is this correct?

4. Why doesn't Bob's reveal propagate backward? The code looks correct but `revealedSecrets.length=0` in entity handler.

### 3. Edge Cases

**Test these scenarios mentally:**

1. **Double HTLC:** Alice locks 100, then locks 50 more
   - First lock: leftHtlcHold = 100
   - Second lock: availableCapacity = outCapacity - 100, should succeed if capacity allows
   - Is this handled correctly?

2. **Reveal after timeout:** Bob tries to reveal but currentHeight > revealBeforeHeight
   - htlc-reveal.ts:35-41 checks this
   - Returns error - correct

3. **Timeout before reveal:** Alice tries timeout but currentHeight <= revealBeforeHeight
   - htlc-timeout.ts:25-32 checks this
   - Returns error - correct

4. **Wrong secret:** Bob reveals with incorrect preimage
   - htlc-reveal.ts:44-50 verifies hash
   - Returns error - correct

5. **Hub forwards to itself:** Route [alice, hub, bob], Hub's routingInfo.nextHop = hub
   - This was happening earlier, fixed by updating routing info in forward
   - Verify fix is correct

### 4. 2024 Pattern Compliance

**Compare to 2024 reference:**

- `User.hashlockMap` pattern → `EntityState.htlcRoutes` (correct)
- `processAddPayment()` decryption → entity-tx/handlers/account.ts routing check (correct placement?)
- `processSettlePayment()` backward propagation → entity-tx/handlers/account.ts secret loop (correct)
- `Channel.deriveDelta()` NO hold deduction → Same in 2025 deriveDelta() (bug or intentional?)

### 5. Remaining Work

**What needs to be added:**

1. Fix revealedSecrets flow so Bob's reveal triggers Hub→Alice propagation
2. Populate `AccountFrame.byLeft` when creating frames
3. Build `proofBody.htlcLocks` array when creating dispute proofs
4. Make deriveDelta() hold-aware (or document why manual is OK)
5. Test full A→H→B flow with reveal and settlement
6. Add onion encryption (Phase 3 - deferred)

## Expected Audit Output

Please provide:

1. **Bug list** - Specific issues with file:line references
2. **Architecture feedback** - Is routing/propagation logic in right places?
3. **Missing pieces** - What's blocking secret propagation?
4. **Priority fixes** - What must be fixed vs what can wait?
5. **Test scenarios** - Specific test cases to verify fixes work

Be brutally honest - this needs to work for real money.
