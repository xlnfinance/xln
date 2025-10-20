# next.md - Immediate Action Items

**Disposable scratchpad. For long-term vision, see /vibepaper/roadmap.md**

**Last Updated:** 2025-10-15

---

## 🚨 Current Blockers (Fix First)

*No current blockers*

---

## 🎯 Quick Wins (Next Session)

### 1. Frame 0 Empty State (10 min)
Use frame 0 as clean slate (empty env), frames 1+ are actual snapshots. Cleaner initial UX.

### 2. Delete Dead Sidebar Code (2 min)
Lines 406-407 in Graph3DPanel: `sidebarWidth`, `isResizingSidebar` - unused, safe to delete

### 3. Test VR on Quest (5 min)
Verify DOM overlay works, thumbstick controls responsive, panels visible

### 4. ASCII Formation Tool (20 min)
Extract from Graph3DPanel (lines 3829-3943) to Architect panel "Build" mode

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
- BrowserVM deploys real Depository.sol (verified 100 USDC balances)
- TimeMachine bottom bar (scrubbing, play/pause, 0/0 when empty)
- Isolated env architecture (each View instance independent)
- Simnet grid scenario creates 8 entities successfully
- Providence pyramid primitive (N-sided, M-steps) ready

**✅ Just Fixed (2025-10-13 evening):**
1. **Gossip routing** - Added `getNetworkGraph()` stub to gossip.ts (returns empty Map)
2. **Graph3D isolated env** - Changed line 1032 to read from `$isolatedEnv.replicas`
3. **Runtime rebuilt** - gossip.ts changes compiled to frontend/static/runtime.js

**✅ COMPLETED THIS SESSION (2025-10-14):**
- Fixed all path issues (`contracts/` → `jurisdictions/` in scripts)
- Fixed TypeScript errors (WebGPURenderer, imports, tsconfig)
- Isolated architecture working (localEnvStore, localHistoryStore, localTimeIndex)
- LevelDB persistence in runtime.ts (`saveEnvToDB`, `loadEnvFromDB`, `clearDB`)
- TimeMachine isolation (effectiveHistory, effectiveTimeIndex, effectiveIsLive)
- Graph3DPanel purged of global stores (`$visibleReplicas` → `env?.replicas`)
- BrowserVM deploys EntityProvider + Depository in-browser
- Console noise eliminated (verbose logs removed)
- Clear Database button added
- Build passes (`bun run check` clean)

**⚠️ DISCOVERED: DUPLICATE CODE PROBLEM**
- NetworkTopology (5842 lines) and Graph3DPanel (3900 lines) are redundant
- Both have `isolatedEnv` support but Graph3DPanel is broken partial copy
- Need unification (see blocker #1 above)

**📋 NEXT SESSION: Complete unification, then test VR**

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

- ✅ **View unification (2025-10-14):** Moved NetworkTopology → /view/panels/Graph3DPanel (6190 lines), proper `Writable<T>` types, shared stores, time-travel working
- ✅ **TimeMachine isolation (2025-10-14):** Accepts isolated stores as props, all panels sync to shared env/history/timeIndex, verified 1/5→5/5 navigation
- ✅ **Graph3D time-travel fix (2025-10-14):** Replaced `$visibleReplicas` with `env.replicas`, credit lines now appear/disappear correctly during time travel
- ✅ **VR button (2025-10-14):** Added to Architect panel, wired via panelBridge to Graph3DPanel's enterVR()
- ✅ **VR essential locomotion (2025-10-14):**
  - Credit lines update in real-time when dragging (position + rotation)
  - Camera starts at (40, 60, 250) to see whole grid
  - Left thumbstick: Movement (forward/back/strafe, camera-relative)
  - Right thumbstick ←→: Snap turn (30° increments, anti-motion-sickness)
  - Right thumbstick ↑↓: Zoom (scale world)
  - Huge intro sign (10m×5m) with all controls, auto-hides after 10s
  - VR HUD panel showing entities/accounts/time status
  - Access: https://192.168.0.197:8080/view from Quest 3
- ✅ Repository restructure (vibepaper, runtime, jurisdictions, worlds, proofs)
- ✅ BrowserVM prototype (Depository deploys + executes in <3s)
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
  - BrowserVM deploys real Depository.sol (25M gas, verified balances)
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
