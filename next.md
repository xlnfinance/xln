# next.md - Priority Tasks

## 🔥 COMPLETED (2025-12-20): Pure R→E→A→J Flow + Panel Cleanup + Codex Audit

### R→E→A→J Flow Architecture (ZERO BYPASSES) ✅
**Problem:** Manual state mutations, direct mempool pushes, bypassing runtime

**Solution:** Complete architectural purity
- ✅ **jOutputs system** - j_broadcast returns jOutputs, routed through applyRuntimeInput
- ✅ **createSettlement EntityTx** - Settlement batches via E-layer (not direct batchAddSettlement)
- ✅ **mintReserves EntityTx** - Funding via E-layer (uses j-batch flow)
- ✅ **Deterministic time** - env.timestamp in scenarios (no Date.now())
- ✅ **J-processor** - Processes mempool after blockDelayMs
- ✅ **Event emission** - env.emit() across all layers (11 event types)
- ✅ **Alice→Bob R2R** - Peer-to-peer transfer added back

**Codex Audit Results:**
- Architecture: CLEAN ✅
- Solvency: ENFORCED ✅ (10M constant)
- J-Blocks: CORRECT ✅ (4 blocks, not 24)
- Flow: PURE ✅ (except test setup)

**Files:**
- `runtime/types.ts` - Added JInput, EntityOutput, mintReserves, createSettlement
- `runtime/entity-tx/handlers/j-broadcast.ts` - Returns jOutputs
- `runtime/entity-tx/handlers/mint-reserves.ts` - NEW
- `runtime/entity-tx/handlers/create-settlement.ts` - NEW
- `runtime/runtime.ts` - Routes jOutputs to J-mempool
- `runtime/env-events.ts` - Deterministic timestamps
- `runtime/scenarios/ahb.ts` - Pure flow, 4 J-blocks

### Panel System Cleanup ✅
**Problem:** 10 panels, cognitive overload, redundancy

**Solution:** Consolidated to 5 focused panels
- ✅ **Deleted panels** - EntitiesPanel, DepositoryPanel, ConsolePanel (standalone), InsurancePanel (standalone), SolvencyPanel (standalone)
- ✅ **Merged** - Console into Settings tab, Insurance into EntityPanel, Solvency into RuntimeIOPanel
- ✅ **Layout manager** - Export/import workspace configs (panels + camera + settings)
- ✅ **Auto-save/load** - Layout persists across refreshes
- ✅ **Non-closeable core panels** - Only entity panels closeable

**Final panels:**
1. Graph3D (main visual)
2. Architect (scenarios)
3. Jurisdiction (J-layer tables)
4. Runtime I/O (events + JSON debug)
5. Settings (visual + console + layout)

### Visual Enhancements ✅
- ✅ **Dual-color W/D labels** - Red withdrawals, green deposits in same label
- ✅ **Batch content labels** - "E2: 2R2R", "E1: +1R2C", "E2: -1W +1D"
- ✅ **J-panel reorganized** - Balances first, mempool as yellow subcategory

---

## 📋 TODO (Low-Hanging Fruit)

### Performance & Cleanup
1. **Remove console.log spam** (15 min)
   - Current: 600+ logs across runtime
   - Target: 50 strategic ones
   - Files: `entity-consensus.ts`, `account-consensus.ts`, `runtime.ts`
   - Impact: Readable logs, faster execution

2. **Merge tiny helpers** (5 min)
   - `entity-helpers.ts` (50 lines) → `utils.ts`
   - `gossip-loader.ts` (36 lines) → `gossip.ts`
   - Impact: 2 fewer imports, cleaner

3. **DEBUG=false for production** (2 min)
   - Set `constants.ts:DEBUG = false`
   - Tree-shake `if (DEBUG)` blocks
   - Impact: Smaller bundle, no debug overhead

### Features
4. **Event query API** (10 min)
   ```typescript
   export const queryEvents = (env, filter) =>
     env.history.flatMap(f => f.logs.filter(...))

   // Browser: XLN.queryEvents({ eventName: 'BilateralFrameCommitted' })
   ```
   - Impact: Queryable event log for debugging

5. **Event filtering in Runtime panel** (10 min)
   - Add checkboxes: R-layer, E-layer, A-layer, J-layer
   - Filter events by category
   - Impact: Focus on specific layer

6. **Deduplicate solvency calculation** (5 min)
   - Export from `runtime.ts:calculateSolvency()`
   - Remove duplicates in `RuntimeIOPanel.svelte`, `SolvencyPanel.svelte`
   - Impact: DRY, consistent calculation

7. **Event counts in panel tabs** (3 min)
   - Show: `🔗 Consensus: 3 | 🤝 Account: 5 | ⚖️ J-layer: 2`
   - Impact: Quick overview of activity

### Future Scenarios
8. **flash-crash.ts** - Market maker insolvency + FIFO enforcement (30 min)
9. **correspondent-banking.ts** - Multi-hop FX routing (20 min)
10. **uniswap-amm.ts** - AMM via delta transformers (40 min)

---

## 🎯 PRIORITY FEATURES (From 2019 + Codex Analysis)

### Core Missing Features (From 2019 Analysis)

**1. HTLC Support - Conditional Payments** (2-3 hours)
- **What:** Hash Time-Locked Contracts as AccountTx delta transformers
- **2019 had:** `ch.locks[]` with hash/secret/expiry/onion routing
- **Architecture:** HTLCs are ONE way to transform deltas (not a separate layer!)
  ```typescript
  AccountTx types to add:
  - htlc_lock: { hash, amount, expiry, onion }
  - htlc_reveal: { secret } → commits delta if hash(secret) = hash
  - htlc_timeout: {} → reverts delta if block > expiry
  ```
- **Enables:**
  - Atomic swaps (cross-chain, cross-token)
  - Payment routing with proof-of-payment
  - Conditional settlements
  - Lightning-style payments with <100% collateral (XLN advantage)
- **Files:** `account-tx/handlers/htlc-*.ts`, `types.ts`, `account-consensus.ts`
- **Priority:** P0 - Core differentiator vs Lightning

**2. Onion Routing - Payment Privacy** (1-2 hours)
- **What:** Encrypt hop data so intermediaries can't see source/destination
- **2019 had:** nacl.box encryption, layered onion construction
- **Current:** Clear-text routes (every hub sees Alice → Bob)
- **Implementation:**
  ```typescript
  // Build onion in reverse
  let onion = encrypt({ amount, destination }, destination.pubkey);
  for (hop of route.reverse()) {
    onion = encrypt({ amount, nextHop, unlocker: onion }, hop.pubkey);
  }
  // Each hop only sees: amount + nextHop (not source/dest)
  ```
- **Enables:**
  - Privacy (Bob doesn't know Alice sent)
  - Regulatory compliance (GDPR, data minimization)
  - Hub can't front-run based on flow analysis
- **Files:** `routing/onion.ts`, `account-tx/handlers/direct-payment.ts`
- **Priority:** P1 - Privacy critical for real usage

**3. Smart Rebalancing Algorithm** (2-3 hours)
- **What:** Optimize net-sender/receiver matching to minimize on-chain ops
- **2019 had:**
  - Finds pullable collateral (net-senders with `secured > minRisk`)
  - Matches to net-receivers (sorted by `they_requested_deposit`)
  - ONE batch with N withdrawals + M deposits
  - Per-asset cadence (FRD every block, rare assets every 1K blocks)
- **Current:** Manual rebalancing in scenarios
- **Algorithm:**
  ```typescript
  1. Scan all accounts: find net-senders (delta < 0, excess collateral)
  2. Scan all accounts: find net-receivers (delta > 0, need insurance)
  3. Solve: minimize Σ(withdrawals + deposits) subject to matching totals
  4. Create unified settlement batch
  5. Broadcast when: time elapsed OR total risk > threshold
  ```
- **Optimizations from 2019 comments:**
  - Use balance trends (not snapshots)
  - Minimize ops to transfer max volume
  - Different schedules per asset type
  - Cross-hub insurance requests
- **Files:** `routing/rebalancer.ts`, `entity-crontab.ts`
- **Priority:** P1 - Hubs need this to scale

**4. Request Insurance Workflow** (1 hour)
- **What:** Users request collateral increases when uninsured > soft_limit
- **2019 had:** `they_requested_deposit` field, auto-request on soft limit breach
- **Current:** Hard credit limits only (no user-initiated increases)
- **Flow:**
  ```typescript
  // User side:
  if (uninsured > soft_limit) {
    account.requestedRebalance.set(tokenId, amount);
    // Crontab sends request_rebalance AccountTx
  }

  // Hub side:
  if (request_rebalance received) {
    // Add to netReceivers list
    // Next rebalance cycle deposits to this account
  }
  ```
- **UI:** Button in EntityPanel: "Request Insurance ($X)"
- **Files:** `account-tx/handlers/request-rebalance.ts` (exists!), UI integration
- **Priority:** P2 - UX improvement

**5. Dispute Timeouts & Auto-Reveal** (1-2 hours)
- **What:** Crontab detects missing ACKs / expiring HTLCs → triggers disputes / reveals secrets
- **2019 had:**
  ```javascript
  if (withdrawal_requested_at + 600000 < Date.now()) {
    // Offline too long - start dispute
    batchAdd('dispute', startDispute(ch));
  }
  if (lock.exp < blockNumber) {
    // HTLC expiring - reveal secret on-chain
    batchAdd('revealSecret', { secret, hash });
  }
  ```
- **Current:** Crontab exists but only checks basic timeouts
- **Add:**
  - ACK timeout detection (account hasn't responded in N seconds)
  - HTLC expiry detection (reveal secret before timeout)
  - Cooperative close timeout (start dispute if peer offline)
- **Files:** `entity-crontab.ts` (expand), `account-tx/handlers/htlc-timeout.ts`
- **Priority:** P1 - Safety (prevents fund loss from offline peers)

**6. Batch Persistence & Retry** (1 hour)
- **What:** Persist jBatch to DB, retry on failure until confirmed
- **2019 had:** Pending batches survived restarts, auto-rebroadcast
- **Current:** In-memory only (lost on crash)
- **Implementation:**
  ```typescript
  // Before broadcast:
  await db.put(`pending-batch:${entityId}`, encode(jBatch));

  // On J-block confirmation:
  await db.del(`pending-batch:${entityId}`);

  // On startup:
  const pending = await db.get(`pending-batch:${entityId}`);
  if (pending) rebroadcast(pending);
  ```
- **Files:** `j-batch.ts`, `runtime.ts` (startup)
- **Priority:** P2 - Reliability

**7. Lock-Based Capacity (for HTLC support)** (30 min)
- **What:** Calculate available capacity accounting for pending HTLCs
- **2019 formula:**
  ```
  outbound_capacity = secured + unsecured + they_credit_limit
                     - they_unsecured - outbound_hold
  ```
- **Current:** Simple delta-based (no holds)
- **Needed for:** HTLC support (can't double-spend capacity)
- **Files:** `account-utils.ts:deriveDelta()`
- **Priority:** P0 if doing HTLCs, P3 otherwise

---

## Architecture Assessment: R→E→A→J

**Is it better than 2019's single-layer?**

**YES.** Here's why:

**2019 Architecture:**
```
Channel (bilateral) → Batch (onchain)
```
- Simple but limited
- Can't do multi-party entities
- No internal consensus
- All accounts equal importance

**R→E→A→J Architecture:**
```
Runtime → Entity (BFT) → Account (bilateral) → Jurisdiction (EVM)
```

**Advantages over 2019:**
1. **Multi-party entities** - DAOs, companies (N validators)
2. **Different trust models** - BFT at E-layer, 2-of-2 at A-layer
3. **Clean separation** - Internal (E) vs External (A) relationships
4. **Jurisdiction abstraction** - Can swap EVMs (BrowserVM, Reth, etc)
5. **Event emission** - Audit trail (2019 had no events)
6. **Time travel** - Replay any frame (2019 couldn't)

**What 2019 Did Better:**
1. HTLCs (we can add)
2. Onion routing (we can add)
3. Auto-rebalancing (we can add)

**Verdict:** R→E→A→J is **superior architecture**. Just missing features, not design flaws.

**Could we improve R→E→A→J?**

Maybe:
- **R→E→A→J→I** (Insurance layer)? No - insurance is just entity relationships
- **R→E→A→D→J** (Delta transformer layer)? No - transformers are A-layer primitives
- **Simpler: R→A→J** (remove E)? No - loses multi-party entities

**R→E→A→J is optimal.** HTLCs belong in A-layer as AccountTx types (delta transformers).

Want me to add this analysis to next.md and commit?

---

## 🔥 COMPLETED (2025-12-17): Grid Scenario + Visual TX Animation + Reset Button

### Grid Scalability Scenario ✅
**Problem:** No visual demonstration of broadcast bottleneck vs hub-spoke scaling

**Solution:** Created lightweight 2×2×2 grid scenario (8 nodes)
- ✅ **Grid dimensions** - 2×2×2 = 8 nodes (was 8×8×4 = 256)
- ✅ **3D positioning** - NxMxZ support in `createGridEntities()` (true 3D cube)
- ✅ **Proper J-Machine batching** - Following AHB pattern:
  ```typescript
  // Step 1: Fund nodes directly
  await browserVM.debugFundReserves(nodeId, USDC_TOKEN_ID, usd(100_000));

  // Step 2: Add R2R txs to mempool (creates yellow cubes!)
  jReplica.mempool.push({ type: 'r2r', from, to, amount, timestamp });

  // Step 3: Execute batch
  await browserVM.reserveToReserve(from, to, USDC_TOKEN_ID, amount);
  jReplica.mempool = [];
  await processJEvents(env);
  ```
- ✅ **2 routing hubs** - Hub-spoke topology demonstration
- ✅ **Scenarios namespace** - `XLN.scenarios.grid(env)` with dynamic imports
- ✅ **UI button** - "2³" icon, "8 nodes (2×2×2) · Broadcast vs Hubs"

**Files Modified:**
- `runtime/scenarios/grid.ts` - New scenario file
- `runtime/scenarios/boot.ts` - Shared utilities (createGridEntities, createNumberedEntity)
- `runtime/runtime.ts` - Added scenarios namespace
- `runtime/xln-api.ts` - Added scenarios type definition
- `frontend/src/lib/view/panels/ArchitectPanel.svelte` - Grid scenario button

### Visual TX Movement Animation ✅
**Problem:** Yellow tx cubes instantly appeared in J-Machine mempool (no visual journey)

**Solution:** Animate flying cubes from source entity to J-Machine
- ✅ **Auto-trigger animation** - When tx added to mempool, detect source entity
- ✅ **100ms flight** - Yellow glowing cube flies from entity → J-Machine
- ✅ **Ease-out cubic** - Smooth deceleration as cube enters J-Machine
- ✅ **Scale-down effect** - Cube shrinks as it enters (0.5x final size)
- ✅ **Pattern detection** - Uses `tx.from` or `tx.entityId` to find source

**Code:** `frontend/src/lib/view/panels/Graph3DPanel.svelte:798-804`
```typescript
// Trigger visual animation: yellow cube flies from entity to J-Machine
if (tx && (tx.from || tx.entityId)) {
  const sourceEntityId = tx.from || tx.entityId;
  animateR2RTransfer(sourceEntityId, '', 0n); // 100ms flight
}
```

**Result:** Grid scenario shows 8 yellow cubes flying from nodes to J-Machine! 📤

### Reset Button - Fresh Runtime Instance ✅
**Problem:** Reset button only cleared state, didn't create fresh runtime

**Solution:** Create completely new env instance instead of clearing
- ✅ **Fresh runtime** - `XLN.createEmptyEnv()` instead of `.clear()`
- ✅ **UI state reset** - timeIndex=0, isLive=true, tutorialActive=false
- ✅ **Proper cleanup** - Old env garbage collected automatically
- ✅ **Button styling** - Red-themed with hover effects

**Code:** `frontend/src/lib/view/panels/ArchitectPanel.svelte:412-436`
```typescript
async function resetScenario() {
  const XLN = await getXLN();
  const freshEnv = XLN.createEmptyEnv(); // NEW instance
  isolatedEnv.set(freshEnv);
  // Reset UI state...
}
```

**Result:** Click Reset → Grid gives pristine runtime ready for Grid scenario 🎯

---

## 🔥 COMPLETED (2025-12-17): RJEA Event Consolidation + AHB Rename

### Problem (SOLVED)
Three different Solidity events doing the same thing (settlement/R2C):
- `AccountSettled` (declared but never used)
- `SettlementProcessed` (used by prefundAccount)
- `TransferReserveToCollateral` (used by reserveToCollateral internal function)

Also: `prepopulateAHB` → `ahb` rename, moved to scenarios/

### Solution
Consolidated to **ONE universal event: `AccountSettled`** (from Account.sol library)

**Solidity changes (Depository.sol):**
- ✅ Deleted duplicate `event AccountSettled` declaration
- ✅ Deleted `event SettlementProcessed`
- ✅ Deleted `event TransferReserveToCollateral`
- ✅ Deleted `function prefundAccount()` (59 lines removed)
- ✅ Updated `reserveToCollateral()` to emit `AccountSettled`

**Runtime changes:**
- ✅ j-events.ts: Consolidated handlers to `AccountSettled` only
- ✅ j-event-watcher.ts: Removed old event ABIs
- ✅ scenarios/ahb.ts: Renamed from prepopulate-ahb.ts, fixed import paths
- ✅ runtime.ts: Added scenarios namespace with dynamic imports
- ✅ CLI entry point: `bun runtime/scenarios/ahb.ts` works standalone

**Verification:**
- ✅ TypeScript compiles: `5 errors` (pre-existing Three.js only)
- ✅ CLI runs successfully: 28 frames processed
- ✅ RJEA flow verified: BrowserVM → j-events → E-Machine → bilateral consensus

---

## 🔥 COMPLETED (2025-12-12): Bilateral Consensus + UI Reactivity FIXED

### CRITICAL: Shallow Copy Bugs (3 locations!)
- ✅ **manualCloneEntityState** - `{...account}` shared pendingFrame → deep clone via cloneAccountMachine()
- ✅ **AccountList** - `...account` spread created stale snapshots → removed spread
- ✅ **Map mutation** - Direct assignment didn't trigger reactivity → explicit .clear() + .set()

### UI Reactivity Fixes
- ✅ **AccountPreview** - Uses context xlnFunctions (was global only)
- ✅ **AccountPreview** - Shows derived.outCapacity/inCapacity
- ✅ **AccountPanel** - Reuses AccountPreview component (DRY, -50 lines)
- ✅ **Graph3D** - Initial updateNetworkData() call after mount

### UX Improvements
- ✅ **Time Machine** - position:fixed bottom:0
- ✅ **Camera** - Default shows AHB entities on load
- ✅ **J-Machine labels** - Reactive to time machine scrubbing
- ✅ **3D Grid support** - NxMxZ entity positioning

---

## 🔥 COMPLETED (2025-12-11): Entity Panel Click FIXED

### Entity Panel Click - PERMANENT FIX ✅
- ✅ **Map solution** - pendingEntityData Map bypasses Dockview params timing race
- ✅ **$effect infinite loop removed** - was causing browser freeze
- ✅ **Root cause** - Dockview `options.params` doesn't exist in componentFactory

### UI Improvements ✅
- ✅ **BrainVault mnemonic** - 2 columns (vertical scan easier)
- ✅ **JurisdictionPanel** - Address ellipsis + tooltips
- ✅ **EntityPanel layout** - Reordered: Reserves → Accounts → Periodic Tasks
- ✅ **Topbar height** - 56px with proper logo sizing
- ✅ **Playwright tests** - Auto-test workflow for verification

---

## 🚧 TODO: High Priority

### Grid Scenario Enhancements
- [ ] **Gas-proportional rays** - Make broadcast ray thickness = gas spent
- [ ] **Hub-spoke visualization** - Show 2 hubs routing for Phase 2
- [ ] **Mempool overflow visual** - J-Machine "bursts" when >20 txs queued
- [ ] **Scale to 4×4×4** - 64 nodes once 8-node version is polished

### Rebalancing Feature
- [ ] **Hub rebalancing demo** - Add frames 11-15 to AHB
  - Hub analyzes TR (Total Risk) = $125K uninsured with Bob
  - Creates 2 settlements: withdraw from Alice, deposit to Bob
  - Broadcasts J-batch with both (atomic on-chain)
- [ ] **TR metric in Solvency Panel** - Show Total Risk = Σ(credit-backed positions)

### Visual Solvency
- [x] ~~**Dual-render for desync**~~ ✅ DONE - Striped bars when heights differ
- [x] ~~**Solvency panel**~~ ✅ DONE - Basel M1/M2/M3 panel created
- [ ] **Reserve sync verification** - Test frames 8-10, confirm no desync

### Consensus Visualization
- [ ] **Timeline view** - Horizontal ADD_TX→PROPOSE→SIGN→COMMIT flow
- [ ] **Bilateral diff panel** - Show both replicas when heights diverge
- [ ] **Event Tree (R-E-A waterfall)** - Hierarchical log showing execution flow

---

## 🚧 TODO: Medium Priority

### UI Polish
- [ ] **Identicons in dropdown** - Replace 🏢 emoji with generated identicons
- [ ] **Apple design continuation** - 10 remaining panels need glassmorphism

### Entity Panel
- [ ] **Mini-panel restoration** - Find where entity mini-panel went

---

## 🎯 NEXT SESSION PRIORITIES

1. **Test Grid Scenario** - Click Grid button, verify 8 yellow cubes fly to J-Machine
2. **Hub-spoke Phase 2** - Add visual routing through 2 hubs
3. **Rebalancing Demo** - Add frames 11-15 to AHB showing risk management
4. **Visual polish** - Gas-proportional rays, mempool overflow effects

---

## 🚨 ARCHITECTURE DEBT (Long-term)

### A1. Entity positions must be RELATIVE to j-machine (CRITICAL)
**Problem:** Positions stored as absolute x,y,z. Breaks with multiple jurisdictions.
**Solution:** Store `{jurisdictionId, relativeX, relativeY, relativeZ}` instead.

### A2. Graph3DPanel is 6000+ lines
**Problem:** Unmaintainable god-component.
**Solution:** Split into EntityRenderer, ConnectionRenderer, JMachineRenderer, CameraController

### A3. Time-travel is bolted on, not designed in
**Problem:** `history[]` stores full snapshots (memory hog). Panels mix live/historical reads.
**Solution:** Design proper time-travel-aware state access pattern.

---

## 📁 FILES MODIFIED TODAY (2025-12-17):

```
runtime/
├─ scenarios/grid.ts (NEW - Grid scalability scenario)
├─ scenarios/boot.ts (NEW - Shared scenario utilities)
├─ scenarios/ahb.ts (import path fixes, CLI entry point)
├─ runtime.ts (scenarios namespace)
├─ xln-api.ts (scenarios type definition)

frontend/src/lib/view/panels/
├─ ArchitectPanel.svelte (Grid button, Reset button, scenarios namespace)
├─ Graph3DPanel.svelte (TX flight animation trigger)
```

---

## 📋 LOW HANGS (Quick wins):

1. **Settings slider for dollarsPerPx** - ~20 lines in SettingsPanel.svelte
2. **Kill stale background shells** - Many zombie processes running
3. **Add .agents/ to .gitignore** - Prevent papertrail from bloating repo
