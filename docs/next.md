# xln Next Session

## 🚨 NEXT SESSION PRIORITIES

### 🔴 CRITICAL: Fix frameHash Derivation from State
**Status:** Byzantine vulnerability - frames not cryptographically bound to state

**Current:** `frameHash = frame_${height}_${timestamp}` (just string interpolation)
**Should:** `frameHash = keccak256(RLP(prevFrameHash, height, timestamp, deltas, transactions))`

**Why critical:** Without state-derived hashes, frames can be replayed onto wrong state ancestry. More fundamental than mock signatures for consensus correctness.

**Estimated time:** 2-3 hours

---

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

## 💡 TOOL IDEAS (From Session 2025-10-07)

### Tier 1: Production Value
**1. Consensus Divergence Detector** 🔍 (1h)
- Compare state hashes between entity pairs in real-time
- Highlight accounts with mismatched deltas in red
- Click to see diff (left vs right perspective)
- **Why:** Catches bilateral consensus bugs instantly

**2. Payment Flow Tracer** 🎯 (45min)
- Click entity → highlights all payment paths
- Incoming (blue), outgoing (orange), forwarding (purple)
- Tooltip: "5 payments flowing, $2.3M total volume"
- **Why:** Makes demos dramatically better

### Tier 2: VR Experience
**3. Network Healer** 🩹 (45min)
- Green crystal wand on left controller
- Restore disputed accounts (opposite of hammer)
- Creates drama cycle: fragment→repair→fragment

**4. Entity Spawner** ✨ (1h)
- Point in 3D space, place entity
- Ghost preview while aiming
- Auto-connects to nearest 3 entities
- VR-native network building

**5. Payment Cannon** 💸 (45min)
- Trigger button fires payment from controller
- Amount dial on wrist
- Rapid-fire stress testing

**6. Credit Adjuster** 💳 (30min)
- Slider tool appears when holding controller near bars
- Drag to adjust credit limits in real-time
- Visual parameter tuning

### Tier 3: Visual Polish
**7. Tool Skins (Sunder from Morrowind)** (30min)
- Different hammer meshes (cosmetic only)
- Defer until 3+ tools exist with different behaviors

---

## ✅ COMPLETED THIS SESSION (2025-10-07: Lightning + VR + Polish)

### Fat Lightning Bolts (~30min)
**Status:** ✅ Complete - Value-scaled payment visualization

**Implementation:**
- Replaced sphere particles with fat cylinder bolts
- **Logarithmic scaling:** `radius = log10(amountUSD) * 0.08`
  - $1k payment = 0.24 units (thin)
  - $1M payment = 0.48 units (medium)
  - $1B payment = 0.72 units (MASSIVE)
- 3-phase animation:
  - Phase 1 (0-45%): Bolt grows from source
  - Phase 2 (45-55%): Explosive white-blue flash at entity
  - Phase 3 (55-100%): Fade to dim blue
- Gradient: Bright cyan (source) → dim blue (dest)
- Per-hop bolts (matches bilateral consensus reality)

**Agent Feedback:**
- ✅ Per-hop visualization (not end-to-end) matches bilateral model
- ✅ Post-COMMIT timing prevents visual lies about consensus
- ✅ Logarithmic scaling maintains perceptual accuracy
- ✅ Fee visualization: Entity gold glow (not bolt thinning)

**Files:**
- NetworkTopology.svelte:1614-1683 (createDirectionalLightning)
- NetworkTopology.svelte:2377-2432 (animateParticles 3-phase)

---

### Incremental Grid Growth (~30min)
**Status:** ✅ Complete - Organic network expansion

**UI:**
- Grid 2, 3, 4, 5 cascade buttons in sidebar
- Click 2 → creates 2×2×2 (8 entities)
- Click 3 → adds outer shell to make 3×3×3 (19 new, 27 total)
- Click 4 → adds outer shell to make 4×4×4 (37 new, 64 total)
- Click 5 → adds outer shell to make 5×5×5 (61 new, 125 total)

**Logic:**
- Detects existing grid size from entityMapping
- Only creates entities in outer shell (x,y,z ≥ existingSize)
- Skips existing connections (hasAccount check)
- Visual: Network grows organically shell-by-shell

**Files:**
- src/scenarios/executor.ts:377-434 (incremental entity creation)
- src/scenarios/executor.ts:497-580 (incremental connections)
- NetworkTopology.svelte:4361-4370 (UI buttons)

---

### VR Settlement Court System (~1h)
**Status:** ✅ Complete - Interactive dispute visualization

**VRHammer:**
- 3D gavel mesh (gold head + brown handle)
- Attached to right controller
- Raycast hit detection on connection lines
- Punch accounts to dispute
- Visual: Connection turns red, bars removed (network fragments)
- Haptic pulse feedback on hit

**VRScenarioBuilder:**
- Shows ONLY in VR mode (not zen mode)
- 3 tools selectable:
  - ⚖️ Dispute Hammer (fragment network)
  - 💚 Network Healer (restore - TODO)
  - ✨ Entity Spawner (place entities - TODO)
- Quick actions: Spawn Grid, Payment Wave (TODO)
- Active tool indicator

**Visibility Logic:**
- Zen mode: Sidebar hidden
- VR mode: Sidebar + time machine visible
- `isVRActive` flag tracks `renderer.xr.isPresenting`

**Files:**
- frontend/src/lib/vr/VRHammer.ts (191 lines)
- frontend/src/lib/components/VR/VRScenarioBuilder.svelte (207 lines)
- NetworkTopology.svelte:809-837 (hammer integration)

---

### Visual Polish (~30min)
**Status:** ✅ Complete - Better contrast and depth

**URL Routing:**
- Created `/graph` route (frontend/src/routes/graph/+page.svelte)
- Direct link to Graph 3D view
- No more 404 on /graph

**3D Grid Floor:**
- Matrix-style grid helper (200 units, 40 divisions)
- Always visible (not theme-dependent)
- XLN green center line + dark teal grid
- Positioned y=-50 (below entities)
- 20% opacity (subtle depth cue)

**Theme Toggle:**
- Added to sidebar (before Bars control)
- Updates scene.background immediately
- Options: Default, Matrix, Arctic, Sunset

**Label Contrast:**
- Added black stroke outline (4px width)
- Bright green text on top
- Visible on any background

**Connection Lines:**
- Opacity: 0.3 → 0.5 (67% brighter)
- Width: 1 → 2 (thicker)
- Dash: 0.2 → 0.3 (longer dashes)
- Gap: 0.5 → 0.3 (more continuous)

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

### Smooth Bar Transitions (~1 hour)
- Add per-account state tracking for previous/current values
- Lerp bar heights in animation loop
- Visual: Bars gradually grow/shrink on payments (fluid feel)
- **Status:** Low priority - current bars work fine

---

## 📝 SESSION NOTES (2025-10-07)

**Duration:** ~3 hours
**Focus:** Value-scaled lightning visualization, VR tools, visual polish

**Major Achievements:**
1. Fat lightning bolts with logarithmic scaling (1px=$1 visual rule)
2. Incremental grid growth (organic network expansion)
3. VR Settlement Court (dispute hammer + scenario builder)
4. Function Index system (97% token savings on future edits)
5. Account bar extraction (AccountBarRenderer.ts)
6. Visual polish (grid floor, theme toggle, better contrast)

**Token Usage:** ~328k/1M (33% of budget)
**Commits:** 4 total
- a658398: Function index + visual polish
- f0bc306: VR Settlement Court
- 13847b7: Lightning bolts + incremental grid
- [pending]: Visual polish + routing

**Net Code Change:** +1810 insertions, -1776 deletions
**Build Status:** ✅ Passes with 0 errors
