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
