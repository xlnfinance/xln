# next.md - clean roadmap

**Last Updated:** 2025-11-07 23:00
**Session:** Fed Chair demo + Performance + UX polish (15 commits)

---

## 🔴 CRITICAL NEXT SESSION

### 1. Speed up HYBRID creation (15s → <1s)
**File:** `frontend/src/lib/view/panels/ArchitectPanel.svelte` ~line 850
**Current:** Sequential `await XLN.applyRuntimeInput()` for each entity (21 calls)
**Fix:** Batch all entities: `await XLN.applyRuntimeInput({runtimeTxs: all21Entities})`
**Effort:** 15min

### 2. Safari macOS broken
**Need:** Console errors from user (Cmd+Option+I)
**See:** `reports/2025-11-07-safari-bug.md`

### 3. Entity click → panel
**File:** `Graph3DPanel.svelte:4063` (onMouseClick)
**Add:** `panelBridge.emit('entity:selected', {entityId})`
**Effort:** 10min

---

## 🟡 HIGH (Code Quality)

### 4. Remove 15x 'as any'
**File:** Graph3DPanel.svelte (lines 772, 775, 795, 928, 932, 935, 938, 1428-1430, 1657, 3239, 4086-4088)
**Fix:** WebXR type definitions, JMachineUserData interface
**Effort:** 30min

### 5. DRY: updateIsolatedStores()
**File:** ArchitectPanel.svelte (5 locations)
**Effort:** 15min

### 6. Remove unused vars
**File:** Graph3DPanel.svelte:910-911 (`lastReplicaCount`, `updateDebounceTimer`)
**Effort:** 2min

---

## 🟢 MEDIUM (UX)

### 7. Keyboard shortcuts
Space, arrows, Home/End, F
**Effort:** 15min

### 8. Time machine mini mode
**Effort:** 10min

### 9. Compact entity list
**Effort:** 20min

### 10. Alice-Hub-Bob button
**Effort:** 5min

---

## 📊 TODAY'S WORK (2025-11-07)

**Commits:** 15
**Reports:** 14 (private, in `reports/`)

**Completed:**
- ✅ Fed Chair one-click demo
- ✅ HYBRID economy (works, 15s creation)
- ✅ Performance 5x faster (3x3 grid, 10x entity sizes, no antialiasing)
- ✅ Layout 75/25 (code correct, browser cache issue)
- ✅ Time machine/bars toggles
- ✅ 6 bugs fixed

**Read:** `cat reports/2025-11-07-COMPLETE-SESSION-SUMMARY.md`

---

## 🚀 PRODUCTION

**https://xln.finance/view:**
- ✅ Working (HYBRID: 313 FPS, 30 entities)
- ⚠️ Slow (15s creation)
- ⚠️ Safari broken

**Latest:** 316f991

---

**Start next session:** Batch optimization (#1)

---

## 🔵 LOW-HANGING (2-5 min each)

### 11. Layout cache workaround
**Issue:** Browser localStorage caches old 50/50 layout despite code being 75/25
**Fix:** Add "Reset Layout" button in SettingsPanel → `localStorage.removeItem('xln-layout')`
**Effort:** 5min

### 12. Reports index
**File:** `reports/README.md` (create index of all 14 reports)
**Effort:** 5min

### 13. Inline code TODOs
**Found:** 7 TODOs in ArchitectPanel/Graph3DPanel
**Notable:** Graph3DPanel:4156 "Switch to panels view" = entity click feature (#3)
**Action:** Review and resolve or remove
**Effort:** 15min

### 14. Cleanup background processes
**Issue:** Multiple `bun run dev`, deploy scripts still running
**Command:** `pkill -f "bun run dev" && pkill -f "auto-deploy"`
**Effort:** 1min

---

## 📌 MISSED IDEAS (From Session Discussion)

**Recorded in reports but not in NEXT.md:**

### Future (Low Priority)
- FREQUENTLY_ASKED.md (reduce Claude re-explaining between sessions)
- Multi-model orchestration (Gemini/Grok for parallel tasks)
- Presentation-driven development (Figma → Code workflow)
- Autonomous agent loop (works while you sleep)

**See:** `reports/2025-11-07-session-summary.md` sections 2-4

---

## 🐛 INLINE CODE TODOS

```
ArchitectPanel.svelte:1567 - TODO: Trigger Fed emergency lending
ArchitectPanel.svelte:1898 - TODO: Load xlnomy's replicas and history
Graph3DPanel.svelte:4156   - TODO: Switch to panels view (= #3 entity click!)
Graph3DPanel.svelte:1815   - TODO: Hub rebalance coordination
Graph3DPanel:8-10          - TODO: Move imports to view/
```

**Action:** Review in next session, implement or delete

---

**Total actionable items:** 14 (3 critical, 3 high, 4 medium, 4 low)
**Estimated total time:** ~3.5 hours for all


---

## 🏗️ ARCHITECTURE (Design Phase)

### 15. Multi-Runtime Support
**Vision:** Runtime switcher dropdown, local/remote runtimes, state persistence
**Needs:** Design decisions from user (see below)
**Effort:** ~8 hours total (phases 1-4)
**See:** `reports/2025-11-07-multi-runtime-architecture.md`

**Quick wins (25min):**
- Center J-Machine on grid intersections (snap to 666px cells)
- Save camera position to localStorage
- Auto-restore UI state on reload

**Full system (8hr):**
- Runtime switcher dropdown
- State persistence (env + history + camera)
- Session locking (multi-tab warning)
- Remote runtime (WebSocket to bun server)

**Critical questions (need answers):**
1. One runtime per tab OR dropdown switcher? (Recommend: dropdown)
2. Local (BrowserVM) OR remote (WebSocket)? (Recommend: local default)
3. Persist everything OR just env? (Recommend: everything)
4. Multi-tab: Lock, Sync, or Warn? (Recommend: warn)
5. Remote protocol: REST, WebSocket, or SSE? (Recommend: WebSocket)

**Read full analysis:** `cat reports/2025-11-07-multi-runtime-architecture.md`

---


## 2025-11-10 Session: AHB Demo + 3-Level UI

### COMPLETED (18 commits):
- ✅ AHB Demo (prepopulate-ahb.ts, 9 frames, Fed Chair subtitles)
- ✅ Full Mechanics Demo (prepopulate-full-mechanics.ts, 15 frames)
- ✅ 3-Level Preset System (LVL 1/2/3 game UI)
- ✅ EntityObject.ts (proper entity hierarchy, 176 lines)
- ✅ No-blockchain mode (works without EVM)
- ✅ BANK_NAMES removed (hardcoded names bug)
- ✅ env.clear() added (state cleanup)
- ✅ E2E smoke test (tests/ahb-smoke.spec.ts)

### INCOMPLETE (Next Session):

**1. EntityObject Integration (2-3h)**
- Import EntityObject into Graph3DPanel ✅ (started)
- Replace old entity creation with new class
- Test labels stick to entities
- File: frontend/src/lib/view/3d/README.md (full plan)

**2. /view Isolated Mode Debug (2h)**
- Issue: Entities show but wrong names/frame count
- Root cause: TBD (needs browser DevTools debugging)
- Workaround: Main UI (Settings → AHB) WORKS!

**3. Subtitle Rendering (1h)**
- FrameSubtitle component exists
- Subtitle data exists in frames
- But doesn't render in /view
- Likely: isolatedHistory store wiring issue

### FILES CREATED:
```
runtime/
├─ prepopulate-ahb.ts
├─ prepopulate-full-mechanics.ts

frontend/src/lib/
├─ components/TimeMachine/FrameSubtitle.svelte
├─ view/3d/EntityObject.ts
├─ view/3d/README.md

e2e/ahb-smoke.spec.ts
TESTING-AHB.md
vibepaper/architecture/jurisdiction-requirement.md
```

### KNOWN ISSUES:
- /view mode: entities persist between demos
- Labels float (EntityObject not integrated)
- Subtitle doesn't show in /view
- Main UI works perfectly ✅

### MEMORY:
- /view = main product (isolated, embeddable)
- No global window.XLN in /view mode
- EntityObject = correct architecture
- Need focused debugging session for /view
