# HTLC Onion Routing Implementation Plan

**Status:** Infrastructure ready, onion routing needs implementation
**Priority:** Next session
**Complexity:** Medium (2-3 hours with references)

---

## Current State

### ✅ What Works
- HTLC lock creation (htlc-lock handler with isValidation)
- lockBook persistence (entity-level aggregated view)
- Account.locks Map (bilateral lock storage)
- HTLC reveal handler (exists, needs integration)
- HTLC timeout handler (exists, needs testing)

### ❌ What's Missing
- **Onion envelope unwrapping** (Hub doesn't know how to forward)
- **Multi-hop routing** (Hub doesn't forward Alice→Bob)
- **Secret backward propagation** (Bob reveals, but doesn't reach Alice)
- **Envelope encoding** (no structure for layered routing info)

### 🔍 Current Failure
```
lock-ahb.ts assertion:
  Alice lockBook size: 1 ✓ (Alice created lock)
  Hub lockBook size: 0 ❌ (Hub should have forwarded to Bob)
```

**Issue:** Hub receives Alice's htlc_lock but doesn't forward it to Bob.

---

## Onion Routing Design (Per User Guidance)

### Privacy-Preserving Multi-Hop

**Each node only knows:**
- Previous hop (who sent them the HTLC)
- Next hop (where to forward)
- **NOT:** Full route, final recipient

**Example: Alice → Hub1 → Hub2 → Bob**
- Alice knows: nextHop = Hub1
- Hub1 knows: prevHop = Alice, nextHop = Hub2 (doesn't know Bob exists!)
- Hub2 knows: prevHop = Hub1, nextHop = Bob (doesn't know Alice)
- Bob knows: prevHop = Hub2 (final recipient)

### Envelope Structure (Based on 2024/2019)

**Alice creates layered envelopes:**
```typescript
// Layer 3 (innermost - for Bob)
bobEnvelope = {
  finalRecipient: true,
  secret: "preimage_abc123"  // Bob can unlock
}

// Layer 2 (for Hub2)
hub2Envelope = {
  nextHop: bob.id,
  innerEnvelope: encode(bobEnvelope)  // Bob's layer (encrypted in production)
}

// Layer 1 (outermost - for Hub1)
hub1Envelope = {
  nextHop: hub2.id,
  innerEnvelope: encode(hub2Envelope)  // Hub2's layer
}

// Alice's htlc_lock includes hub1Envelope
htlc_lock.data = {
  lockId, hashlock, timelock, revealBeforeHeight, amount, tokenId,
  envelope: hub1Envelope  // Only first hop's envelope!
}
```

**Hub1 receives, unwraps:**
```typescript
const envelope = htlc_lock.data.envelope;
const nextHop = envelope.nextHop;  // Hub2
const innerEnvelope = envelope.innerEnvelope;  // For Hub2

// Forward to Hub2 with innerEnvelope
htlc_lock_forwarded = {
  lockId: `${original.lockId}-fwd`,
  hashlock: original.hashlock,  // Same hashlock!
  timelock: original.timelock - 10000,  // Reduce by 10s
  revealBeforeHeight: original.revealBeforeHeight - 1,  // Reduce by 1 block
  amount: original.amount - feeAmount,  // Deduct hop fee
  tokenId: original.tokenId,
  envelope: decode(innerEnvelope)  // Hub2's envelope (unwrapped)
}
```

**Bob receives (final recipient):**
```typescript
const envelope = htlc_lock.data.envelope;
if (envelope.finalRecipient) {
  // This is for me! Extract secret
  const secret = envelope.secret;
  // Reveal immediately
  htlc_reveal.data = { lockId, secret };
}
```

### Envelope Encoding (Skip Encryption for Now)

**Simple JSON encoding:**
```typescript
// Alice creates
const envelope = JSON.stringify({ nextHop, innerEnvelope: JSON.stringify({...}) });

// Hub unwraps
const parsed = JSON.parse(envelope);
const nextHop = parsed.nextHop;
const innerEnvelope = parsed.innerEnvelope;  // Still a string
```

**Future (Phase 2):** Add encryption per hop using ECIES or similar.

---

## Implementation Plan

### Step 1: Create Envelope Types

**File:** `runtime/htlc-envelope-types.ts`

```typescript
export interface HtlcEnvelope {
  nextHop?: string;           // Next entity to forward to (undefined if final)
  finalRecipient?: boolean;   // Is this the last hop?
  secret?: string;            // Only in final recipient's envelope
  innerEnvelope?: string;     // Encoded envelope for next hop (JSON string)
}

export interface HtlcRoutingContext {
  route: string[];            // Full route (used by sender to create envelopes)
  currentHopIndex: number;    // Which hop we're at (for debugging)
}

// Helper: Create layered envelopes from route
export function createOnionEnvelopes(
  route: string[],  // [alice, hub1, hub2, bob]
  secret: string    // Final recipient's secret
): HtlcEnvelope {
  // Build from innermost (final) to outermost (first hop)
  let envelope: HtlcEnvelope = {
    finalRecipient: true,
    secret
  };

  // Wrap each layer (reverse order)
  for (let i = route.length - 2; i >= 0; i--) {
    envelope = {
      nextHop: route[i + 1],
      innerEnvelope: JSON.stringify(envelope)
    };
  }

  return envelope;  // Outermost envelope (for first hop)
}

// Helper: Unwrap one layer
export function unwrapEnvelope(encoded: string): HtlcEnvelope {
  return JSON.parse(encoded);
}
```

### Step 2: Update htlc_lock Handler

**File:** `runtime/account-tx/handlers/htlc-lock.ts`

**Add envelope to HtlcLock type:**
```typescript
export interface HtlcLock {
  lockId: string;
  hashlock: string;
  timelock: bigint;
  revealBeforeHeight: number;
  amount: bigint;
  tokenId: number;
  senderIsLeft: boolean;
  envelope?: HtlcEnvelope;  // NEW: Onion routing info
}
```

**Store envelope in lock:**
```typescript
const lock: HtlcLock = {
  lockId, hashlock, timelock, revealBeforeHeight, amount, tokenId, senderIsLeft,
  envelope: accountTx.data.envelope  // Pass through from tx
};
accountMachine.locks.set(lockId, lock);
```

### Step 3: Update Entity Forwarding Logic

**File:** `runtime/entity-tx/handlers/account.ts:189-288` (HTLC forwarding)

**Current code checks for `routingInfo` (old structure).**
**Replace with envelope unwrapping:**

```typescript
// After line 191: Found htlc_lock in committed frame
if (accountTx.type === 'htlc_lock') {
  const lock = accountMachine.locks.get(accountTx.data.lockId);
  if (!lock || !lock.envelope) continue;

  // Unwrap envelope
  const envelope = lock.envelope;

  if (envelope.finalRecipient) {
    // WE are final recipient - reveal immediately (if we have secret)
    if (envelope.secret) {
      mempoolOps.push({
        accountId: input.fromEntityId,  // Reply to sender
        tx: {
          type: 'htlc_reveal',
          data: { lockId: lock.lockId, secret: envelope.secret }
        }
      });
      console.log(`🎯 HTLC: Final recipient, auto-revealing`);
    }
  } else if (envelope.nextHop) {
    // Intermediary - forward to next hop
    const nextHop = envelope.nextHop;
    const nextAccount = newState.accounts.get(nextHop);

    if (nextAccount) {
      // Unwrap inner envelope
      const innerEnvelope = envelope.innerEnvelope
        ? unwrapEnvelope(envelope.innerEnvelope)
        : undefined;

      // Calculate fees
      const { calculateHtlcFee, calculateHtlcFeeAmount } = await import('../../htlc-utils');
      const forwardAmount = calculateHtlcFee(lock.amount);
      const feeAmount = calculateHtlcFeeAmount(lock.amount);

      newState.htlcFeesEarned += feeAmount;

      // Forward with reduced timelock and inner envelope
      mempoolOps.push({
        accountId: nextHop,
        tx: {
          type: 'htlc_lock',
          data: {
            lockId: `${lock.lockId}-fwd`,
            hashlock: lock.hashlock,  // Same hashlock!
            timelock: lock.timelock - 10000n,  // Reduce by 10s
            revealBeforeHeight: lock.revealBeforeHeight - 1,
            amount: forwardAmount,
            tokenId: lock.tokenId,
            envelope: innerEnvelope  // Next hop's envelope
          }
        }
      });

      console.log(`➡️ HTLC: Forwarding to ${nextHop.slice(-4)}, amount ${forwardAmount} (fee ${feeAmount})`);
    }
  }
}
```

### Step 4: Secret Backward Propagation

**When Bob reveals:**
```typescript
// Bob → htlc_reveal → Hub receives
// Hub sees Bob revealed secret
// Hub needs to propagate to Alice

// In entity-tx/handlers/account.ts (after htlc_reveal processing):
if (accountTx.type === 'htlc_reveal') {
  const { lockId, secret } = accountTx.data;

  // Check htlcRoutes for backward route
  const route = newState.htlcRoutes.get(hashlock);
  if (route) {
    // Propagate reveal to inbound entity
    mempoolOps.push({
      accountId: route.inboundEntity,  // Previous hop
      tx: {
        type: 'htlc_reveal',
        data: {
          lockId: route.inboundLockId,  // Original lock ID
          secret
        }
      }
    });
    console.log(`⬅️ HTLC: Propagating reveal to ${route.inboundEntity.slice(-4)}`);
  }
}
```

### Step 5: Update lock-ahb.ts Test Scenario

**Replace direct_payment with htlc_lock:**

```typescript
// Frame 10: Alice creates HTLC A→H→B $125K
const secret = 'my_secret_preimage_for_bob';
const hashlock = ethers.keccak256(ethers.toUtf8Bytes(secret));

const envelope = createOnionEnvelopes(
  [alice.id, hub.id, bob.id],
  secret
);

await process(env, [{
  entityId: alice.id,
  signerId: alice.signer,
  entityTxs: [{
    type: 'lockPayment',  // Entity-level HTLC initiation
    data: {
      targetEntityId: bob.id,  // Final recipient
      route: [hub.id],         // Intermediate hops
      tokenId: USDC_TOKEN_ID,
      amount: usd(125_000),
      timelock: Date.now() + 3600000,  // 1 hour
      revealBeforeHeight: currentJHeight + 100,
      secret  // Alice knows secret, encodes for Bob
    }
  }]
}]);

// This should:
// 1. Create htlc_lock on Alice-Hub with envelope for Hub
// 2. Hub receives, unwraps, forwards to Bob with inner envelope
// 3. Bob receives, sees finalRecipient, reveals
// 4. Secret propagates: Bob→Hub→Alice
// 5. All HTLCs settle
```

---

## Architecture Decisions

### Q1: Envelope Encoding
**Decision:** JSON for now (simple, debuggable)
**Future:** ECIES encryption per hop for privacy

### Q2: Timelock Reduction
**Decision:** Reduce by fixed amount per hop (10s or 1 block)
**Rationale:** Gives each hop time to process before deadline

### Q3: Fee Model
**Decision:** Fixed percentage per hop (e.g., 0.1%)
**Rationale:** Incentivizes routing, simple to calculate

### Q4: Route Discovery
**Decision:** Manual route for now (sender specifies full path)
**Future:** Gossip-based route finding (like Lightning)

---

## Test Requirements

**lock-ahb.ts must verify:**

1. ✅ Lock creation (Alice locks on Alice-Hub account)
2. ✅ Lock forwarding (Hub creates lock on Hub-Bob account)
3. ✅ Bob receives lock (Bob's account.locks has entry)
4. ✅ Bob reveals secret (htlc_reveal tx)
5. ✅ Secret propagates to Hub (Hub sees reveal)
6. ✅ Secret propagates to Alice (Alice sees reveal)
7. ✅ All locks settle (deltas updated correctly)
8. ✅ Fees collected (Hub's htlcFeesEarned increases)
9. ✅ Timelock cascade (each hop has less time)

**Assertions needed:**
```typescript
// After Alice locks
assert(aliceRep.state.lockBook.size > 0, 'Alice lockBook populated');
const aliceAccount = aliceRep.state.accounts.get(hub.id);
assert(aliceAccount.locks.size > 0, 'Alice account has lock');

// After Hub forwards
assert(hubRep.state.lockBook.size > 0, 'Hub lockBook populated');
const hubBobAccount = hubRep.state.accounts.get(bob.id);
assert(hubBobAccount.locks.size > 0, 'Hub-Bob account has forwarded lock');

// After Bob reveals
const bobAccount = bobRep.state.accounts.get(hub.id);
assert(bobAccount.locks.size === 0, 'Bob lock settled after reveal');

// After propagation complete
assert(aliceAccount.locks.size === 0, 'Alice lock settled');
assert(hubBobAccount.locks.size === 0, 'Hub-Bob lock settled');

// Verify deltas
assert(aliceHubDelta.offdelta < 0, 'Alice paid (left gives = negative)');
assert(bobHubDelta.offdelta > 0, 'Bob received (right receives = positive)');
assert(hubState.htlcFeesEarned > 0, 'Hub collected fee');
```

---

## Reference Implementations

### 2024 Channel.ts
**File:** `.archive/2024_src/app/Channel.ts`
- Search for: "hashlock", "routing", "forward"
- Pattern: Onion envelope unwrapping at each hop

### 2019 Source
**File:** `.archive/2019src.txt:2549`
```
// every 'add' transition must pass an encrypted envelope (onion routing)
```
- Simpler design, good for understanding basics

---

## Implementation Checklist

**Phase 1: Envelope Types & Helpers**
- [ ] Create `runtime/htlc-envelope-types.ts`
- [ ] Implement `createOnionEnvelopes(route, secret)`
- [ ] Implement `unwrapEnvelope(encoded)`
- [ ] Add tests for envelope creation/unwrapping

**Phase 2: Lock Handler Integration**
- [ ] Add `envelope?: HtlcEnvelope` to HtlcLock type
- [ ] Update htlc-lock handler to store envelope
- [ ] Ensure envelope persists through validation/commit

**Phase 3: Forwarding Logic**
- [ ] Update `entity-tx/handlers/account.ts:189-288`
- [ ] Replace `routingInfo` with `envelope` unwrapping
- [ ] Generate htlc_lock mempoolOp with innerEnvelope
- [ ] Test Hub forwards to Bob

**Phase 4: Secret Propagation**
- [ ] Add htlcRoutes tracking (hashlock → {inbound, outbound})
- [ ] When htlc_reveal received, check htlcRoutes
- [ ] Generate htlc_reveal mempoolOp for previous hop
- [ ] Test Bob→Hub→Alice propagation

**Phase 5: Settlement**
- [ ] Verify htlc_reveal updates deltas correctly
- [ ] Test multi-hop settlement (all deltas update)
- [ ] Verify fee collection

**Phase 6: Timeout Handling**
- [ ] Test htlc_timeout after revealBeforeHeight
- [ ] Verify refund to sender
- [ ] Test multi-hop timeout cascade

---

## Known Issues to Address

### Issue 1: lockBook vs AccountMachine.locks
**Current:** Entity lockBook (aggregated view) separate from account locks (actual state)
**Question:** Should lockBook mirror account.locks, or is it independent?
**Decision needed:** Clarify relationship and sync mechanism

### Issue 2: Envelope Size Limits
**Current:** No size limit on envelope
**Risk:** Deeply nested envelopes (many hops) could exceed frame size
**Fix:** Add MAX_HOPS limit (e.g., 5) and validate envelope depth

### Issue 3: Timelock Cascade Validation
**Current:** Each hop reduces timelock by fixed amount
**Risk:** If too many hops, final recipient has no time to reveal
**Fix:** Validate minimum timelock at each hop (e.g., must have >1 hour remaining)

---

## Testing Strategy

### Unit Tests
- Envelope creation (1 hop, 3 hops, 5 hops)
- Envelope unwrapping (each layer)
- Hashlock verification (same across all hops)
- Timelock cascade (each hop has less time)

### Integration Tests (lock-ahb.ts)
- Alice→Hub→Bob (2 hops)
- Verify forwarding works
- Verify reveal propagates
- Verify settlement completes

### Edge Cases
- Invalid envelope (malformed JSON)
- Missing nextHop (final recipient check)
- Timelock expired at intermediate hop
- Insufficient capacity at intermediate hop
- Secret mismatch (wrong preimage)

---

## Success Criteria

**Functional:**
- ✅ lock-ahb.ts passes completely
- ✅ Multi-hop routing works (Alice→Hub→Bob)
- ✅ Secret revelation propagates backward
- ✅ All locks settle with correct deltas
- ✅ Fees collected at each hop

**Quality:**
- ✅ Deterministic (same route → same result)
- ✅ Privacy-preserving (each hop knows only nextHop)
- ✅ No envelope size bombs (MAX_HOPS enforced)
- ✅ Clear error messages for debugging

**Compatibility:**
- ✅ ahb.ts still passes (no regression)
- ✅ swap.ts still passes
- ✅ Build clean

---

## Estimated Effort

**Implementation:** 2-3 hours (with references)
**Testing:** 1 hour (assertions, edge cases)
**Documentation:** 30 min (update RJEA guide)

**Total:** ~4 hours for production-ready HTLC onion routing

---

## Next Steps

1. **Read 2024 Channel.ts** for exact envelope structure
2. **Implement envelope types** and helpers
3. **Update htlc-lock** to store/forward envelopes
4. **Update forwarding logic** to unwrap and forward
5. **Implement propagation** for htlc_reveal
6. **Test lock-ahb.ts** end-to-end
7. **Commit and verify** all scenarios pass

---

**Context for Next Session:**
- ahb.ts and swap.ts are production-ready ✓
- ProofBody architecture complete ✓
- All Codex critical issues fixed ✓
- HTLC infrastructure exists, just needs onion routing wiring

**Start here:** Create `runtime/htlc-envelope-types.ts` and implement `createOnionEnvelopes()`
