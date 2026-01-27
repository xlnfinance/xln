# Archive Code Review

## Executive Summary

The `.archive/2024_src/` folder contains a production-ready MVP with battle-tested bilateral channel consensus, HTLC routing, and signature verification patterns. Key valuable patterns include:

1. **Frame-level bilateral consensus** with rollback handling (Channel.ts)
2. **Critical section mutex** for concurrent message handling (User.ts)
3. **Onion-encrypted HTLC routing** with fee calculation (User.ts)
4. **BigInt-safe msgpack serialization** (Codec.ts)
5. **Deterministic left/right entity ordering** ensuring consensus
6. **DryRun validation pattern** - validate on clone before commit

The current runtime has adopted most patterns correctly but has some gaps in error handling strictness and test coverage depth.

---

## Patterns to Bring Forward

### Critical Security Patterns

- [x] **Deterministic Left/Right Ordering**: `Channel.ts:102-104` - Lower address = left. Current code uses `isLeft()` function correctly.
- [x] **Counter-based Replay Protection**: `Channel.ts:620` - Sequential message counter. Current code validates strictly.
- [x] **Frame Hash Chain Linkage**: `Channel.ts:585` - `previousStateHash` links frames. Current code implements `prevFrameHash`.
- [x] **DryRun Before Commit**: `Channel.ts:175-198` - Validate on clone, verify sigs, then apply. Current code uses `clonedMachine`.

### Consensus Patterns

- [x] **Rollback on Simultaneous Proposals**: `Channel.ts:138-165` - Left wins tiebreaker, Right rolls back. Current code implements this.
- [x] **Pending Block State Machine**: `Channel.ts:166-234` - Track `pendingBlock`, `pendingSignatures`. Current code uses `pendingFrame`.
- [ ] **Rollback Counter Tracking**: `Channel.ts:142-157` - Limits rollbacks to prevent infinite loops. **PARTIALLY IMPLEMENTED** - current code tracks but doesn't enforce hard limit.

### Cryptographic Patterns

- [x] **Signature on State Hash**: `Channel.ts:287,537` - Sign `keccak256(encode(state))`. Current code signs `stateHash`.
- [x] **Subchannel Proof Signatures**: `Channel.ts:425-546` - Separate signatures per proof + global. Current code has `newHanko` + `newDisputeHanko`.
- [ ] **Message Encryption via ECIES**: `User.ts:498-509` - End-to-end encrypted messages. **NOT IN CURRENT CODE** - could add for P2P privacy.

### State Management Patterns

- [x] **Mempool Pattern**: `User.ts:83-94` - `addToMempool()` with flush trigger. Current code has `accountMachine.mempool`.
- [x] **Storage Point with Signatures**: `StoragePoint.ts:1-9` - Store `(block, state, leftSigs, rightSigs)`. Current code has `frameHistory`.
- [ ] **Periodic Flush Loop**: `User.ts:421-438` - Background flush for pending txs. **NOT IN CURRENT CODE** - relies on event-driven.

### Error Handling Patterns

- [ ] **Fatal Error with Process Exit**: `Channel.ts:154,188,196` - `process.exit(1)` on consensus failure. **CURRENT CODE IS SOFTER** - logs errors but doesn't crash.
- [ ] **Debug State in Messages**: `Channel.ts:181,318-322` - Send `debugState` hex for verification. **NOT IN CURRENT CODE** - would help debugging.
- [x] **Throw on Invalid State**: `Channel.ts:314-316` - `isValidFlushMessage()` guard. Current code validates `AccountInput`.

### Testing Patterns

- [ ] **Offdeltas Verification Map**: `onionpayment.test.ts:19-30` - Track expected vs actual deltas. **NOT IN CURRENT TESTS** - should add.
- [ ] **shouldSkipRemainingTests Flag**: `onionpayment.test.ts:32-45` - Stop tests on first failure. **NOT IN CURRENT TESTS**.
- [ ] **Setup/Teardown Hooks**: `channel.test.ts:19-36` - `before()`, `after()`, `afterEach()` for cleanup. **PARTIALLY** - scenarios have cleanup.

---

## Security Measures Missing in Current Code

### HIGH Priority

1. **[ ] Hard Rollback Limit Enforcement**
   - Archive: `Channel.ts:153-157` enforces max 1 rollback per side
   - Current: Tracks `rollbackCount` but no hard enforcement
   - Risk: Infinite rollback loop could DoS consensus
   - Fix: Add `if (rollbackCount > MAX_ROLLBACKS) throw Error('Consensus failure')`

2. **[ ] Fatal Error Escalation**
   - Archive: `process.exit(1)` on signature mismatch, state divergence
   - Current: Logs error, continues
   - Risk: Silent state divergence
   - Fix: Add strict mode that throws/halts on consensus violations

3. **[ ] Debug State Transmission**
   - Archive: `FlushMessage.debugState` sends full state for verification
   - Current: Only sends frame/signatures
   - Risk: Harder to debug state divergence
   - Fix: Add optional debug payload in `AccountInput`

### MEDIUM Priority

4. **[ ] Timelock Validation on HTLC Add**
   - Archive: `AddPayment.ts:58-63` checks `timelock > block.timestamp`
   - Current: Checks in reveal, not add
   - Risk: Could add expired HTLCs
   - Fix: Validate timelock on lock creation

5. **[ ] Capacity Check Before HTLC Forward**
   - Archive: `User.ts:663-668` checks `inCapacity >= amount`
   - Current: Checks in handler but not pre-routing
   - Risk: Routes through insufficient capacity channels
   - Fix: Pre-validate capacity in pathfinding

6. **[ ] E2E Message Encryption**
   - Archive: ECIES encryption for onion packages
   - Current: Cleartext envelopes (Phase 2 mentioned)
   - Risk: Privacy leak on multi-hop
   - Fix: Implement RSA-OAEP encryption (already has key fields)

### LOW Priority

7. **[ ] Periodic State Persistence**
   - Archive: `Channel.save()` called after every state change
   - Current: Relies on snapshot system
   - Risk: State loss on crash
   - Fix: Add auto-save hook in frame commit

8. **[ ] Message Counter Overflow Protection**
   - Archive: Not explicit but uses `number`
   - Current: Has `MAX_MESSAGE_COUNTER = 1000000`
   - Risk: Counter overflow after 1M messages
   - Fix: Consider BigInt or wraparound with nonce

---

## State Machine Patterns

### Bilateral Consensus (Channel.ts)

```
┌─────────────────────────────────────────────────────────────────────┐
│                     BILATERAL FRAME CONSENSUS                       │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  PROPOSER (us)                         RECEIVER (them)              │
│  ┌───────────────┐                    ┌───────────────┐            │
│  │ 1. Build block│                    │               │            │
│  │    from       │    FlushMessage    │ 4. Validate   │            │
│  │    mempool    │ ─────────────────▶ │    block      │            │
│  │               │                    │               │            │
│  │ 2. Apply      │                    │ 5. Apply      │            │
│  │    dryRun     │                    │    dryRun     │            │
│  │               │                    │               │            │
│  │ 3. Sign       │    ACK + Sigs      │ 6. Compare    │            │
│  │    newState   │ ◀───────────────── │    states     │            │
│  │               │                    │               │            │
│  │ 7. Verify ACK │                    │ 8. Sign if    │            │
│  │    sigs       │                    │    match      │            │
│  │               │                    │               │            │
│  │ 8. Apply real │                    │ 9. Apply real │            │
│  │    commit     │                    │    commit     │            │
│  └───────────────┘                    └───────────────┘            │
│                                                                     │
│  SIMULTANEOUS PROPOSAL HANDLING (Line 138-165):                     │
│  - If both send same blockId: LEFT WINS (deterministic tiebreaker) │
│  - Right increments rollbackCount, discards own block              │
│  - Right processes Left's block as receiver                        │
│  - Max 1 rollback per side prevents infinite loops                 │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### HTLC Multi-Hop Routing (User.ts)

```
┌─────────────────────────────────────────────────────────────────────┐
│                     HTLC ONION ROUTING FLOW                         │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  Alice ───────▶ Bob (Hub) ───────▶ Charlie ───────▶ Dave           │
│                                                                     │
│  1. Alice creates payment:                                          │
│     - Generate secret, compute hashlock = keccak256(secret)         │
│     - Build onion layers (innermost = secret for Dave)              │
│     - Encrypt each layer for hop's public key                       │
│                                                                     │
│  2. Forward path (AddPayment):                                      │
│     - Each hop peels one onion layer                                │
│     - Verifies capacity >= amount                                   │
│     - Creates new AddPayment to next hop (amount - fee)             │
│     - Stores hashlock → {inAddress, outAddress} mapping             │
│                                                                     │
│  3. Dave reveals secret:                                            │
│     - Decrypts final layer, gets secret                             │
│     - Creates SettlePayment with secret                             │
│                                                                     │
│  4. Backward path (SettlePayment):                                  │
│     - Each hop receives secret, looks up hashlockMap                │
│     - Creates SettlePayment to inbound channel                      │
│     - Collects fee (payment.amount - forwarded.amount)              │
│                                                                     │
│  Key Security Properties:                                           │
│  - Hashlock ensures atomicity (all-or-nothing)                      │
│  - Timelock ensures timeout (prevent stuck funds)                   │
│  - Onion encryption hides route from intermediaries                 │
│  - Fee rate = 0.1% (FEE_RATE = 0.001)                               │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### Critical Section Pattern (User.ts:825-900)

```typescript
// Archive Pattern: Mutex per channel preventing concurrent state mutations
async criticalSection<T>(key: string, description: string, job: Job<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const queueItem: QueueItem<T> = [job, description, resolve, reject];

    if (!this.sectionQueue[key]) {
      this.sectionQueue[key] = [];
    }

    // Queue overflow protection (DoS prevention)
    const queueLength = this.sectionQueue[key].push(queueItem);
    if (queueLength > 10000) {
      reject(new Error(`Queue overflow for: ${key}`));
      return;
    }

    // If first item, start processing
    if (queueLength === 1) {
      this.processQueue(key);
    }
  });
}

// Current code status: NOT IMPLEMENTED
// The current runtime uses single-threaded frame processing
// but doesn't have explicit mutex for concurrent entity operations
```

---

## Key Files Reviewed

| File | Lines | Purpose | Value |
|------|-------|---------|-------|
| `.archive/2024_src/app/Channel.ts` | 804 | Bilateral consensus, frame signing, rollback handling | HIGH - Core consensus patterns |
| `.archive/2024_src/app/Transition.ts` | 558 | State transitions (payments, swaps, HTLCs) | HIGH - Type guards, apply patterns |
| `.archive/2024_src/app/User.ts` | 907 | Onion routing, critical sections, mempool | HIGH - Multi-hop, concurrency |
| `.archive/2024_src/utils/Codec.ts` | 36 | BigInt-safe msgpack encoding | MEDIUM - Serialization safety |
| `.archive/2024_src/types/ChannelState.ts` | 29 | Channel state structure | LOW - Type definitions |
| `.archive/2024_src/types/Subchannel.ts` | 70 | Delta structure with credit limits | MEDIUM - Financial types |
| `.archive/2024_src/types/Block.ts` | 14 | Block/Frame structure | LOW - Type definitions |
| `.archive/2024_src/types/FlushMessage.ts` | 66 | Message validation | MEDIUM - Input validation |
| `.archive/2024_src/test/channel.test.ts` | 153 | Channel unit tests | MEDIUM - Test patterns |
| `.archive/2024_src/test/onionpayment.test.ts` | 333 | Multi-hop payment tests | HIGH - E2E test patterns |
| `.archive/2024_src/test/directpayment.test.ts` | 190 | Direct payment tests | MEDIUM - Unit test patterns |
| `.archive/2019_docs/05_consensus.md` | 56 | Consensus theory (2/3+ BFT) | LOW - Background reading |
| `.archive/2019_docs/12_threat_model.md` | 84 | Security threat analysis | HIGH - Attack vectors |
| `.archive/2019_docs/02_hashlocks.md` | 32 | HTLC theory | LOW - Background reading |

---

## Recommendations

### Immediate Actions

1. **Add hard rollback limit** in `account-consensus.ts`:
   ```typescript
   const MAX_ROLLBACKS = 2;
   if (accountMachine.rollbackCount >= MAX_ROLLBACKS) {
     throw new Error('FATAL: Consensus failure - max rollbacks exceeded');
   }
   ```

2. **Add offdeltas verification helper** for scenario tests:
   ```typescript
   // From onionpayment.test.ts pattern
   async function verifyOffdeltas(channels: Map<string, Account>, expected: Record<string, bigint>) {
     for (const [key, expectedDelta] of Object.entries(expected)) {
       const actual = channels.get(key)?.deltas.get(0)?.offdelta;
       assert(actual === expectedDelta, `Delta mismatch: ${key}`);
     }
   }
   ```

3. **Consider critical section** for concurrent entity operations if/when multi-threading is added.

### Future Enhancements

1. **ECIES message encryption** for P2P privacy (Phase 3)
2. **Debug state transmission** for production debugging
3. **Periodic persistence hook** for crash recovery
4. **Fee calculation standardization** (archive uses 0.1% = 10 bps)

---

## Current vs Archive Comparison

| Feature | Archive (2024) | Current | Status |
|---------|----------------|---------|--------|
| Bilateral consensus | Channel.ts | account-consensus.ts | Implemented |
| Rollback handling | Hard limit + dedup | Soft tracking | NEEDS WORK |
| HTLC routing | Full onion | Envelope system | Implemented |
| Signature verification | ethers.verifyMessage | hanko system | Enhanced |
| Critical sections | User.criticalSection | None | NOT NEEDED (single-thread) |
| State persistence | Channel.save() | Snapshot system | Different approach |
| Message validation | isValidFlushMessage | validateAccountFrame | Implemented |
| Test coverage | Mocha + assertion | Scenario system | Different approach |
| Debug logging | Logger timeline | Console + ASCII | Implemented |
| BigInt serialization | msgpack extension | safeStringify | Implemented |

---

*Generated: 2026-01-27*
*Archive revision: 2024_src (Nov 2024)*
*Current runtime: types.ts (1853 lines), account-consensus.ts (1420 lines)*
