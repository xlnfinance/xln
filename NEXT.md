# next.md - Immediate Action Items

**Disposable scratchpad. For long-term vision, see /vibepaper/roadmap.md**

**Last Updated:** 2025-10-11

---

## 🚨 Current Blockers (Fix First)

### 1. /view Route Broken
**Problem:** https://localhost:8080/view throws 500 errors

**Root cause:**
- Graph3DPanel imports missing components (AdminPanel, VisualDemoPanel, VRScenarioBuilder)
- Dockview 504 cache errors
- BrowserVM artifact path (can't bundle jurisdictions/artifacts from frontend)

**Solutions:**
- Option A: Use existing NetworkTopology at /view (it works)
- Option B: Strip Graph3DPanel to minimal (just canvas + EntityManager)
- Option C: Fix all imports (move AdminPanel etc to /view)

**Status:** Main route (/) works perfectly, /view needs fixing

---

## 🎯 This Week (High Impact)

### 1. Landing Page - Broadcast vs Unicast Demo
**Route:** / or /learn

**Interactive features:**
- Split-screen animation (centralized hub vs mesh network)
- "Run a Node" button → launches BrowserVM in browser
- Live attack simulation (click Coinbase → all clients fail, click XLN node → network survives)
- Code comparison (trust API vs verify locally)

**Goal:** Explain XLN's value prop in 30 seconds

---

### 2. /view Workspace - 90% Complete

**✅ Working:**
- Dockview tiling (4 panels: Graph3D, Entities, Depository, Architect)
- BrowserVM deploys real DepositoryV1.sol (verified 100 USDC balances)
- TimeMachine bottom bar (scrubbing, play/pause, 0/0 when empty)
- Isolated env architecture (each View instance independent)
- Simnet grid scenario creates 8 entities successfully
- Providence pyramid primitive (N-sided, M-steps) ready

**✅ Just Fixed (2025-10-13 evening):**
1. **Gossip routing** - Added `getNetworkGraph()` stub to gossip.ts (returns empty Map)
2. **Graph3D isolated env** - Changed line 1032 to read from `$isolatedEnv.replicas`
3. **Runtime rebuilt** - gossip.ts changes compiled to frontend/static/runtime.js

**❌ Remaining (test next session):**
- Verify entities now visible in Graph3D after scenario runs
- Check if 8 entities render as 3D cube
- Confirm TimeMachine scrubbing updates visualization
- Test Entities panel shows list

**Next Session Priority:**
- Open /view → Click Simnet Grid → Verify 8 entities appear
- If still broken: Check console logs for new errors
- Add gossip → entities connection if needed

**Learnings:**
- Dockview panels mount outside Svelte tree → setContext() doesn't work → use props
- Svelte 5 needs `mount()` API, not `new Component()`
- TimeOperations object methods need arrow functions (this binding)
- .scenario.txt (text DSL) easier than .xln.js (needs wrapper) for simnet
- HMR doesn't always trigger - sometimes need pkill + fresh restart
- Vite watch works but browser cache can be sticky

**Tech Debt:**
- **TimeMachine isolation broken** - Mirrors to global stores (breaks multi-View)
  - Line: ArchitectPanel.svelte:77 `xlnEnvironment.set(currentEnv)`
  - Fix: Refactor TimeMachine to accept history prop OR make it a Dockview panel
- Remove excessive debug logging (runtime.js has 100+ console.log lines)
- Silence warnings (wheel events, unused exports, a11y)
- Add error boundaries to panels
- Implement draggable TimeMachine (currently fixed bottom position)

---

## ✅ Completed This Session

- ✅ Repository restructure (vibepaper, runtime, jurisdictions, worlds, proofs)
- ✅ BrowserVM prototype (DepositoryV1 deploys + executes in <3s)
- ✅ AGPL-3.0 license applied everywhere
- ✅ WebGPU/WebGL toggle in NetworkTopology
- ✅ Panel system foundation (4 panels created, utils built)
- ✅ v0.0.1 release tagged + pushed
- ✅ /view moved to /frontend/src/lib/view (all Svelte together)
- ✅ Server → Runtime rename (code + docs)
- ✅ Lowercase all .md files (2025-10-13: enforced everywhere, updated all refs)
- ✅ Demo HTML cleanup
- ✅ next.md + roadmap.md created
- ✅ /view route fixed (2025-10-13: Dockview + React deps, dual HTTP/HTTPS)
- ✅ /view Bloomberg Terminal 90% (2025-10-13):
  - Dockview tiling system (VSCode-quality, framework-agnostic)
  - BrowserVM deploys real DepositoryV1.sol (25M gas, verified balances)
  - TimeMachine bottom bar (scrubbing works, fixed 0/-1 → 0/0)
  - Isolated env per View (multiple instances on same page)
  - Providence pyramid primitive (N-sided, M-steps geometric)
  - Simnet lazy grid scenario creates 8 entities
  - Fixed timeOperations `this` binding (arrow functions)
  - Fixed Svelte 5 mount API for Dockview integration

---

## 📋 Later (Post-MVP)

- Extract sidebar → ArchitectPanel fully (Economy mode with BrowserVM)
- Time machine with dual timeline (RuntimeFrames + J blocks)
- Multi-network tabs (Simnet | Testnet | Mainnet switcher)
- Layout persistence (localStorage + URL sharing)
- iPad/mobile responsive panels
- VR panel adaptations

---

**Continue next session from:** Fix /view route OR create landing page
