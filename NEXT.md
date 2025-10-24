# next.md - Immediate Action Items

**Disposable scratchpad. For long-term vision, see /vibepaper/roadmap.md**

**Last Updated:** 2025-10-23

---

## 🚨 Current Work: Xlnomy System (Self-Contained Jurisdictions)

**Goal:** Make XLN "super self-contained" by creating jurisdictions entirely within runtime. Eliminate external dependencies.

### Architecture Overview

**Xlnomy = J-Machine (court/jurisdiction) + Entities + Contracts**

- **J-Machine IS the jurisdiction** (not two separate entities!)
- **J-Machine** = Jurisdiction Machine (court entity at elevated position that all entities anchor to)
- **EVM Abstraction** = Swap BrowserVM ↔ Reth/Erigon/Monad without changing runtime code
- **BrowserVM** = In-browser EVM (simnet mode, zero external dependencies)
- **First Load** = Auto-create "Simnet" Xlnomy with 2×2×2 grid (8 entities, $1M reserves each)
- **Depository Panel** = Live RCPAN monitor (reserves + FIFO debt head + auto-clear preview)

### Key Files Created

1. **runtime/types.ts** - Extended with Xlnomy types:
   - `RuntimeTx` extended with `'createXlnomy'` type
   - `Xlnomy` interface (name, evmType, jMachine config, contracts, entities)
   - `JurisdictionEVM` interface (abstract EVM: BrowserVM or RPC)
   - `XlnomySnapshot` interface (serialization for persistence/export)

2. **runtime/jurisdiction-factory.ts** (NEW) - Core factory:
   - `createXlnomy()` - Create new Xlnomy with optional auto-grid
   - `exportXlnomy()` / `importXlnomy()` - JSON snapshots (git-like versioning)
   - `saveXlnomy()` / `loadXlnomy()` - Level/IndexedDB persistence

3. **runtime/evms/browservm-evm.ts** (NEW) - BrowserVM implementation:
   - Wraps `BrowserVMProvider` from frontend
   - Deploys EntityProvider + Depository contracts
   - TODO: Serialize @ethereumjs/vm state

4. **runtime/evms/rpc-evm.ts** (NEW) - RPC implementation:
   - Future support for Reth/Erigon/Monad
   - TODO: All JSON-RPC methods (eth_call, eth_sendTransaction, etc.)

### Terminology Decisions

✅ **COMPLETED (2025-10-23):**
- Renamed `backend` → `evm` throughout codebase
- Renamed `JurisdictionBackend` → `JurisdictionEVM`
- Renamed `backendType` → `evmType`
- Renamed `backends/` → `evms/` directory
- Added `jHeight` (block height) and `mempool` to J-Machine config
- Clarified: J-Machine = Jurisdiction (not two separate entities)

### Implementation Status

✅ **COMPLETED (2025-10-23):**
- ✅ Type definitions (Xlnomy, JurisdictionEVM, XlnomySnapshot)
- ✅ Factory complete (createXlnomy, export/import stubs, save/load stubs)
- ✅ BrowserVM wrapper working (wraps BrowserVMProvider, deploys contracts)
- ✅ RPC skeleton (ready for future Reth/Erigon/Monad support)
- ✅ Runtime integration (createXlnomy handler in runtime.ts:262-293)
- ✅ Architect Panel UI:
  - ✅ Dropdown selector for active Xlnomy
  - ✅ "+ New" button opens modal
  - ✅ Modal form (name, EVM type, RPC URL, block time, auto-grid)
  - ✅ Create button wires to runtime via applyRuntimeInput()
  - ✅ Switch Xlnomy updates env.activeXlnomy
- ✅ Auto-create Simnet on first load (View.svelte:67-80)
- ✅ Grid creation stubbed (xlnomy.entities array populated)
- ✅ Serialization fixed (xlnomies excluded from snapshots to avoid circular refs)

**Browser Verification (2025-10-23 3:09 PM) - FED CHAIR APPROVED:**
- ✅ Simnet auto-creates with J-Machine (purple pyramid) + 8 entities (green dots)
- ✅ "+ New" button opens modal with full form (Name, EVM type, block time, auto-grid)
- ✅ Created "FedReserve" successfully (separate BrowserVM, contracts, 8 entities)
- ✅ Dropdown shows both Simnet + FedReserve (switchable)
- ✅ Switch works: Select FedReserve → "✅ Switched to 'FedReserve'"
- ✅ Circular arrangement: Each Xlnomy gets unique angle (0°, 45°, 90°, etc.) around origin
- ✅ Spatial isolation: Simnet entities at (200,0,0), FedReserve at (141,0,141), etc.
- ✅ Unique entity IDs: Simnet=#1-8, FedReserve=#9-16, Jamaica=#17-24 (no collisions)
- ✅ Unique signerIds: simnet_e0, fedreserve_e1, etc.
- ✅ VR-ready: Walk between economies in circular plaza layout
- ✅ No console errors (only HMR WebSocket, non-critical)
- ✅ Build passes (0 TypeScript errors)

✅ **VERIFIED WORKING (2025-10-23 4:19 PM):**

1. ✅ **Modal closes** - showCreateXlnomyModal = false works
2. ✅ **Unique entity IDs** - Simnet=#1-8, Jamaica=#9-16 (verified in console)
3. ✅ **Unique signer IDs** - simnet_e0-e7, jamaica_e0-e7 (verified in console)
4. ✅ **Circular positions calculated** - Simnet at (200,100,0), Jamaica at (141,100,141)
5. ✅ **16 entities created** - Entity panel shows "16 total"
6. ✅ **Dropdown works** - Shows Simnet + Jamaica, switches between them
7. ✅ **Entity dropdowns updated** - All 16 entities appear in mint/R2R dropdowns
8. ✅ **No collisions** - Jamaica entities don't overwrite Simnet entities

🚧 **CRITICAL: 3D Rendering Not Updated**

**Issue**: Graph3DPanel has ONE hardcoded `jMachine` variable (line 197)
- Renders static J-Machine at hardcoded position
- Doesn't read from `env.xlnomies` Map
- When Jamaica created, its J-Machine position is calculated but NOT rendered

**Fix needed** (Graph3DPanel.svelte):
```typescript
// CURRENT (wrong):
let jMachine: THREE.Group | null = null; // Single static J-Machine

// NEEDED (correct):
let jMachines: Map<string, THREE.Group> = new Map(); // One per xlnomy

$: if (env?.xlnomies) {
  // For each xlnomy, create/update J-Machine at xlnomy.jMachine.position
  env.xlnomies.forEach((xlnomy, name) => {
    if (!jMachines.has(name)) {
      const jMachine = createOctahedron(xlnomy.jMachine.position);
      jMachine.userData.xlnomyName = name;
      scene.add(jMachine);
      jMachines.set(name, jMachine);

      // Add text label with xlnomy name (not "J-MACHINE")
      addTextLabel(jMachine, name, xlnomy.jMachine.position);
    }
  });
}
```

🚧 **NEXT SESSION - FED CHAIR DEMO (1 HOUR):**

**CRITICAL FIX** (Graph3DPanel.svelte line 197):
```typescript
// Replace single jMachine with Map of jMachines
let jMachines: Map<string, THREE.Group> = new Map();

// Reactive: Create J-Machine for each xlnomy
$: if (env?.xlnomies && scene) {
  env.xlnomies.forEach((xlnomy, name) => {
    if (!jMachines.has(name)) {
      const pos = xlnomy.jMachine.position;
      const jMachine = createOctahedron(pos, name); // Pass name for label
      scene.add(jMachine);
      jMachines.set(name, jMachine);
    }
  });
}
```

**THEN** (if time):
1. Camera: Zoom out to see all J-Machines at once (or add "View All" button)
2. Labels: Replace "J-MACHINE" text with xlnomy name (Simnet, Jamaica, USA)
3. Test: Create 3 economies → see triangle of J-Machines
4. Sidebar: Make it 1/4 width (currently still 1/2)
5. Architect: Make it active tab by default (add setTimeout fix)

**LATER** (post-Fed):
- Xlnomy persistence (Level storage)
- Switch Xlnomy → load that xlnomy's entities only
- Export/Import .xlnomy.json files
- Preset economies (USA🇺🇸/China🇨🇳/Jamaica🇯🇲 with flags)

### User Requirements

From user's words:
- "on first load - auto-creation of economy Simnet"
- "when Simnet is created: 1) new J-machine 2) deploy of all contracts to it 3) intialize the cube of 8 users , the grid 2. and accounts between them. all 8 have $1m reserves minted to them"
- "we use level/indexed in browser. persist with single global db we already have"
- "make it shareable / exportable"
- "we dev in browser, in mainnet we just change dataptres [data providers]"
- "keep all design stuff under Architect [panel]"
- "block time: make it 1000ms"

### Design Clarity

**Q: Can we snapshot ethereum js?**
A: Yes, TODO in browservm-evm.ts to serialize @ethereumjs/vm state

**Q: Cross-jurisdiction transfers?**
A: "currently, no. how would we do that? in the future yes, with hashlocks and swaps inside accounts"

**Q: Too many panels?**
A: Fold jurisdiction management into Architect panel (no new panel)

---

## 🚨 Old Blockers (Fixed)

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
