# xln Next Session

## 🚨 NEXT SESSION PRIORITIES

### 🔴 CRITICAL: Replace Mock Signatures with Real ECDSA
**Status:** Production blocker - mock signatures can be forged

**Current state (src/account-crypto.ts):**
```typescript
// Mock: sig_${Buffer.from(content).toString('base64')}
```

**Action plan:**
1. Create `src/signer-registry.ts` for server-side private key storage
2. Derive keys deterministically: `keccak256(signerId + entityId + salt)`
3. Replace `signAccountFrame()` with real `wallet.signMessage()`
4. Replace `verifyAccountSignature()` with `ethers.verifyMessage()`

**Estimated time:** 2-3 hours

---

### 🔴 CRITICAL: Fix frameHash Derivation from State
**Status:** Byzantine vulnerability - frames not cryptographically bound to state

**Current:** `frameHash = frame_${height}_${timestamp}` (just string interpolation)
**Should:** `frameHash = keccak256(RLP(prevFrameHash, height, timestamp, deltas, transactions))`

**Why critical:** Without state-derived hashes, frames can be replayed onto wrong state ancestry. More fundamental than mock signatures for consensus correctness.

**Estimated time:** 2-3 hours

---

### 🟡 MEDIUM: Complete C→R Withdrawal Flow
**Status:** Handlers ready, needs UI wiring + on-chain submission

**What's done:**
- ✅ request_withdrawal + approve_withdrawal AccountTx types
- ✅ Handlers with bilateral approval logic
- ✅ pendingWithdrawals state tracking

**What's needed:**
1. Wire withdrawal UI to AccountPanel (currently shows alert)
2. Implement C→R on-chain submission via settle() with negative collateralDiff
3. Add withdrawal timeout checker to crontab (60s → suggest dispute)
4. Test full bilateral withdrawal flow

**Estimated time:** 3-4 hours

---

### 🟡 MEDIUM: Atomic Rebalance Batch Coordination
**Status:** Detection works, needs full coordination flow

**What's done:**
- ✅ Hub scans for net-spenders ↔ net-receivers every 30s
- ✅ Generates rebalance opportunity chat messages
- ✅ request_rebalance AccountTx for entities to signal need

**What's needed:**
1. Hub collects withdrawal signatures from net-spenders
2. Atomic batch: C→R from spenders + R→C to receivers
3. Timeout handling (some spenders offline)
4. Test multi-entity rebalance coordination

**Estimated time:** 6-8 hours

---

## ✅ COMPLETED THIS SESSION (2025-10-06 - Part 3: Token Efficiency & Visual Polish)

### Token Efficiency System (~1 hour)
**Major win:** Function index system prevents 600k token waste in future sessions

**Created:**
1. ✅ **Function Index** in NetworkTopology.svelte (lines 163-282)
   - 59 functions organized into 14 logical sections
   - Exact line ranges for every function
   - Embedded workflow instructions

2. ✅ **Documentation:** `docs/editing-large-files.md`
   - Complete workflow guide
   - Token savings calculations (97% reduction per edit)
   - Index regeneration commands
   - Example editing session

3. ✅ **Updated CLAUDE.md**
   - Added "FUNCTION INDEX FOR LARGE FILES" section
   - Workflow example for future sessions
   - Updated golden rule

**Workflow:**
```typescript
// 1. Check function index (lines 163-282)
→ animate: 1863-2093 (230 lines)

// 2. Read ONLY that function
Read offset=1863 limit=230

// 3. Edit
Edit old_string="..."

// Saves: 58k tokens per edit (97% reduction)
```

---

### Visual Polish & Bug Fixes (~2 hours)

**Lightning System - 3-Phase Animation:**
- ✅ Phase 1 (0%-45%): Travel source → entity
- ✅ Phase 2 (45%-55%): **Explosive flash** at entity (emissive 3x, scale 3.5x)
- ✅ Phase 3 (55%-100%): Continue entity → destination
- ✅ Changed color: Orange → **Electric blue** (0x00ccff)
- ✅ Both live mode and replay mode working
- ✅ Bilateral visibility (tracks incoming + outgoing)
- Lines: 1600-1640, 2297-2372

**Account Bar Opacity:**
- ✅ **Unused credit (pink):** 20% opacity + wireframe (mental clarity)
- ✅ **Used credit (red):** 100% opacity + solid + bright
- ✅ **Collateral (green):** 100% opacity + solid + bright
- File: `AccountBarRenderer.ts:242-255`

**UI Improvements:**
- ✅ Active Flows moved to sidebar (from floating overlay)
- ✅ TPS slider: 0-100 → 0.1-5 (reasonable demo range)
- ✅ Entity dropdowns show short IDs everywhere (not 0x0000...)
- ✅ SettlementPanel max-height removed (was 600px, now full height)
- ✅ Visual Demo Panel enabled (applies effects to random entities)

**Broadcast Ripples:**
- ✅ Trigger on `deposit_collateral` and `reserve_to_collateral`
- ✅ Bright green expanding torus when entity grows
- ✅ Lines: 1542, 1577, 1656-1658

**Code Organization:**
- ✅ Deleted broken `AccountManager.ts` (543 lines)
- ✅ Deleted unused `BarAnimator.ts` (82 lines)
- ✅ Created `AccountBarRenderer.ts` (clean 283-line extraction)
- ✅ Fixed `getEntityNumber` bug (entity #9 parsing)
- ✅ Net deletion: 693 lines removed, 283 added = **410 lines cleaned**

---

## 📊 2019 Prototype Feature Comparison

See `docs/2019spec` for full reference architecture.

**XLN is NOT replicating 2019** - it's a deterministic consensus MVP with different design goals:
- 2019: HTLC + onion routing + disputes
- 2025: Deterministic frames + simple forwarding + mock signatures

**2019 Features NOT in current XLN:**
- ❌ HTLC (hash time locked contracts)
- ❌ Onion routing (encrypted multi-hop)
- ❌ Dispute mechanism (on-chain adjudication)
- ❌ Coordinator integration
- ❌ Websocket RPC fabric
- ❌ ACK timeout enforcement
- ❌ Cooperative close
- ❌ Lock expiry handling

**Shared concepts (implemented differently):**
- ✅ Bilateral accounts (channel → account)
- ✅ Credit limits
- ✅ Multi-hop payments (simplified)
- ✅ Rebalance (reserve ↔ collateral)
- ✅ Batch settlement (jBatch vs sharedState.batch)

---

## 🔮 DEFERRED TASKS

### AccountManager Unification (OBSOLETE - AccountBarRenderer extracted instead)
- ~~Delete 440 lines from NetworkTopology.svelte~~
- **Status:** Replaced with cleaner extraction approach
- **Result:** 410 lines deleted net

### Smooth Bar Transitions (~1 hour)
- Add per-account state tracking for previous/current values
- Lerp bar heights in animation loop
- Visual: Bars gradually grow/shrink on payments (fluid feel)
- **Status:** Low priority - current bars work fine

---

## 📝 SESSION NOTES (2025-10-06 Part 3)

**Major Achievements:**
1. Function Index system prevents future token waste (97% savings)
2. Account bars properly modularized (AccountBarRenderer.ts)
3. Visual effects significantly improved (3-phase lightning, bright bars)
4. 410 net lines deleted (code cleanup)

**Token Usage:** ~227k tokens (~23% of budget)
**Files Modified:** 8 files
**Net Code Change:** +333 insertions, -1026 deletions

**Build Status:** ✅ Passes with 0 errors
