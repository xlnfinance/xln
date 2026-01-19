# R→E→A→J Architecture

## Why This Order?

The naming `R→E→A→J` reflects **hierarchical containment** (what contains what), not execution order.

### The Containment Tree:

```
Runtime (R)
  ├─ jReplicas: Map<name, JReplica>          ┐
  │   └─ Jurisdiction state (on-chain)       │ Siblings
  │                                           │ (parallel)
  └─ eReplicas: Map<replicaKey, EntityReplica> ┘
      └─ entity.state.accounts: Map<counterpartyId, AccountMachine>
          └─ account.deltas: Map<tokenId, Delta>
```

**Key insight:** J and E are **siblings** (both children of Runtime), but J comes last because it's the **terminal layer** - everything flows TOWARD J for final settlement.

---

## Layer Definitions

### Runtime (R) - Coordinator

**What it contains:**
- `env.jReplicas` - Jurisdiction state machines
- `env.eReplicas` - Entity state machines
- `env.history` - Time machine snapshots
- `env.frameLogs` - Event audit trail

**What it does:**
- Tick orchestration (100ms discrete steps)
- Input routing (`entityInputs` → E-layer, `jInputs` → J-layer)
- Output merging (prevents same-tick cascades)
- Time control (deterministic `env.timestamp`)

**What it does NOT:**
- Make consensus decisions (that's E-layer)
- Hold money (that's E/A/J layers)
- Enforce business logic (that's tx handlers)

**Metaphor:** Operating system scheduler

---

### Entity (E) - BFT State Machine

**What it contains:**
- `entity.state.accounts` - Bilateral account machines (A-layer!)
- `entity.state.reserves` - Reserve balances (mirrors J-layer)
- `entity.state.proposals` - Governance state
- `entity.state.jBatchState` - Pending J-operations

**What it does:**
- Multi-party consensus (threshold signatures)
- Account ownership (creates/manages bilateral relationships)
- J-batch accumulation (builds operations for on-chain)
- Internal governance (proposals, votes)

**What it does NOT:**
- Process bilateral frames (that's A-layer, called by E-layer)
- Execute on-chain (that's J-layer)

**Metaphor:** Company/DAO with multiple decision-makers

---

### Account (A) - Bilateral Machine

**What it contains:**
- `account.deltas` - Per-token balances (THE MONEY)
- `account.currentFrame` - Last agreed bilateral state
- `account.mempool` - Pending account transactions
- `account.frameHistory` - Audit trail

**What it does:**
- 2-of-2 consensus (both entities must sign)
- Frame validation (state hash, prevFrameHash chain)
- Delta transformations (payments, HTLCs, swaps, limits)
- Replay protection (sequential counter validation)

**What it does NOT:**
- Decide on-chain settlement timing (that's E-layer via jBatch)
- Execute on EVM (that's J-layer)

**Metaphor:** Bilateral payment channel (Lightning-style)

---

### Jurisdiction (J) - Settlement Layer

**What it contains:**
- `jReplica.mempool` - Pending batches (yellow cubes)
- `jReplica.reserves` - On-chain reserve balances (synced from EVM)
- `jReplica.collaterals` - On-chain account collaterals (synced from EVM)
- `jReplica.stateRoot` - EVM state root (for time travel)

**What it does:**
- Mempool queueing (batches wait here)
- Block processing (execute after `blockDelayMs`)
- EVM execution (Depository.processBatch)
- Event emission (ReserveUpdated, AccountSettled)
- FIFO debt enforcement (enforceDebts on reserve updates)

**What it does NOT:**
- Know about bilateral accounts (only sees settlements)
- Route payments (that's E/A layers)

**Metaphor:** Blockchain (Ethereum, Arbitrum, etc)

---

## Why NOT Other Orders?

### J→E→A→R (Jurisdiction-first)

**Reads as:** "Jurisdictions contain Entities contain Accounts contain Runtime"

**Why wrong:**
- J doesn't contain E (E registers WITH J)
- R is outermost, not innermost
- Mental model: "Blockchains run operating systems" (backwards)

**Confidence: 100/1000** ❌

---

### E→A→J→R (Entity-first)

**Reads as:** "Entities contain Accounts contain Jurisdictions contain Runtime"

**Why wrong:**
- A doesn't contain J (A settles TO J)
- R contains E, not vice versa
- Mental model: "Companies run operating systems" (inverted)

**Confidence: 200/1000** ❌

---

### A→E→J→R (Account-first)

**Reads as:** "Accounts contain Entities..."

**Why wrong:**
- Completely backwards (E owns A, not A owns E)
- Nonsensical containment

**Confidence: 50/1000** ❌

---

## Execution Flow Example: Alice Pays Bob $100

```
Step 1: User action → Runtime
  process(env, [{
    entityId: alice,
    signerId: '1',
    entityTxs: [{
      type: 'directPayment',
      data: { targetEntityId: bob, amount: 100n }
    }]
  }])

Step 2: Runtime → Entity
  applyEntityInput(env, aliceReplica, input)
  → applyEntityFrame(env, aliceState, [directPaymentTx])
  → applyEntityTx(env, aliceState, directPaymentTx)

Step 3: Entity → Account
  // directPayment handler finds Alice-Bob account
  account = aliceState.accounts.get(bob.id)
  account.mempool.push({
    type: 'direct_payment',
    data: { amount: 100n }
  })
  // Auto-propose triggered
  → proposeAccountFrame(env, account)
  → processAccountTx(account, paymentTx)
  → Creates AccountFrame with new delta
  → Returns AccountInput to send to Bob

Step 4: Account → Entity (bilateral)
  // Bob receives AccountInput
  handleAccountInput(env, bobAccount, accountInput)
  → Validates counter, prevSignatures
  → Applies frame, verifies state hash
  → Both sides agree → payment committed

Step 5: (Later) Entity → Jurisdiction
  // Hub rebalances (pull from Alice, deposit to Bob)
  Hub creates createSettlement EntityTx
  → batchAddSettlement(hubBatch, alice, bob, diffs)
  Hub sends j_broadcast EntityTx
  → Returns jOutputs

Step 6: Runtime → Jurisdiction
  // Runtime routes jOutputs to J-mempool
  for (jOutput of jOutputs) {
    jReplica.mempool.push(jTx)  // Yellow cube appears
  }

Step 7: Jurisdiction executes (after blockDelayMs)
  // J-processor runs
  for (jTx of jReplica.mempool) {
    broadcastBatch(jTx.data.batch)
    → BrowserVM.processBatch()
    → Emits AccountSettled events
  }

Step 8: Jurisdiction → Entity (j-events)
  // J-watcher routes events back
  j-watcher queues j_event EntityTxs
  → Entities process j-events
  → Update account.deltas.collateral
```

**Complete cycle:** R → E → A → (bilateral) → E → J → (on-chain) → E

---

## Why R→E→A→J is Optimal

**Compared to alternatives:**

| Order | Containment | Execution | Mental Model | Score |
|-------|-------------|-----------|--------------|-------|
| **R→E→A→J** | ✅ Correct | ✅ Natural | ✅ Clear | **850/1000** |
| C→E→A→J | ✅ Correct | ✅ Natural | ⚠️ "Coordinator" verbose | 720/1000 |
| T→E→A→J | ⚠️ Tick too narrow | ✅ Natural | ⚠️ Time-focused | 580/1000 |
| S→E→A→J | ⚠️ System vague | ✅ Natural | ⚠️ Generic | 650/1000 |
| J→E→A→R | ❌ Backwards | ❌ Confusing | ❌ Nonsense | 100/1000 |
| E→A→J (no R) | ❌ No coordinator | ❌ Who merges? | ❌ Loses orchestration | 400/1000 |

**R→E→A→J is the natural order.** Don't change it.

---

## Common Misconceptions

### "Shouldn't J come first since it's the blockchain?"

**No.** J is the TERMINAL layer (like gravity), not the starting point.

Think of it like physics:
- Runtime = Space (contains everything)
- Entities = Planets (orbit in space)
- Accounts = Moons (orbit planets)
- Jurisdiction = Sun (everything falls toward it for finality)

**Order:** Container → Orbiter → Satellite → Gravity Well

Not: Gravity Well → Space (nonsense)

### "Shouldn't execution order be E→A→J→R?"

**No.** Execution starts at R (user calls `process()`), not at E.

```typescript
// User doesn't call:
entity.process(tx)  // ❌ No such thing

// User calls:
Runtime.process(env, inputs)  // ✅ Correct
```

Runtime is the **entry point**. E/A/J are internal.

### "Why is J both parallel to E AND terminal?"

**J-replicas are parallel** in the containment tree:
```
Runtime.jReplicas (sibling to)
Runtime.eReplicas
```

**But J is terminal** in the execution flow:
```
E → A → (settle) → J
         ↓
    Final truth
```

Both are true. J is:
- **Structurally:** Sibling to E (both children of R)
- **Functionally:** Terminal layer (E settles TO it)

---

## Conclusion

**R→E→A→J is optimal because:**

1. ✅ Matches containment hierarchy (outer → inner)
2. ✅ Matches execution flow (coordinator → consensus → bilateral → settlement)
3. ✅ Readable left-to-right (Runtime runs Entities managing Accounts settling via Jurisdictions)
4. ✅ Separates concerns (each layer has single responsibility)
5. ✅ Extensible (can add delta transformers to A-layer without new layers)

**Confidence: 850/1000**

**Don't rename. Just document thoroughly.**

The architecture is **fundamentally correct**.
