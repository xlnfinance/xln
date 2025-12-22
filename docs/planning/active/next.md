# next.md - Priority Tasks

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

## 📋 LOW HANGS (Quick wins)

1. **Settings slider for dollarsPerPx** - ~20 lines in SettingsPanel.svelte
2. **Kill stale background shells** - Many zombie processes running
3. **Add .agents/ to .gitignore** - Prevent papertrail from bloating repo
