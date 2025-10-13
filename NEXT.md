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

### 2. Fix /view Workspace
**Goal:** Get 4 panels working at /view

**Panels:**
- Graph3D (3D network visualization)
- Entities (entity list with live state)
- Depository (BrowserVM queries, J-state viewer)
- Architect (god-mode controls - 5 modes)

**Status:** Panels created, Dockview integrated, imports broken

---

### 3. BrowserVM → Depository Integration
**Goal:** Live contract queries in Depository panel

**Current:** Mock data
**Target:** Real DepositoryV1.sol queries via browserVMProvider

**Blocker:** Artifact import path (jurisdictions/ outside frontend/)

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
- ✅ Lowercase all .md files
- ✅ Demo HTML cleanup
- ✅ next.md + roadmap.md created

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
