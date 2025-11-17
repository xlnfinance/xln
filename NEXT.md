# NEXT.md - Priority Tasks

## 🔥 CURRENT SESSION (2025-11-17 PM): Critical Fixes COMPLETE

### STATUS: 2 MAJOR BUGS FIXED (autonomous session)

**FIXED THIS SESSION:**
- ✅ Entity names: Alice/Hub/Bob display correctly (was showing 0x000...001)
- ✅ Frame count: 9 frames exactly (was 18 - auto-snapshots now disabled in demos)
- ✅ All 3 prepopulate functions patched (AHB, H-Topology, Full Mechanics)

**STILL TODO:**
- ⏳ Subtitle doesn't render in /view (works in main UI)
- ⏳ EntityObject integration in Graph3D (labels float)
- ⏳ TypeScript errors (51 errors - pre-existing)

**PREVIOUS SESSION (2025-11-17 AM):**
- ✅ prepopulate-ahb.ts (Alice-Hub-Bob demo code)
- ✅ prepopulate-full-mechanics.ts (10 primitives)
- ✅ 3-level UI (ELEMENTARY/INTERMEDIATE/ADVANCED)
- ✅ EntityObject.ts architecture (176 lines)
- ✅ Main UI path works (localhost:8080 → Settings → AHB)

**ROOT CAUSES IDENTIFIED & FIXED:**

**Bug 1: Entity Names (0x000...001 instead of Alice)**
- **Cause:** buildEntityProfile() didn't include name in metadata
- **Fix:** Added name param + updated all setReservesAndAccounts calls
- **Files:** runtime/gossip-helper.ts, runtime/prepopulate-ahb.ts, frontend/EntitiesPanel.svelte

**Bug 2: 18 Frames Instead of 9**
- **Cause:** captureSnapshot() auto-created "Tick X" frames on EVERY XLN.process() call
- **Root:** state-helpers.ts:192 pushed to envHistory unconditionally
- **Fix:** Added env.disableAutoSnapshots flag, disabled during all prepopulate demos
- **Files:** runtime/types.ts (Env interface), runtime/state-helpers.ts, all 3 prepopulate files

---

## 🎯 NEXT SESSION PRIORITIES:

### 1. FIX /view Entity Names (CRITICAL - 1h)
**Problem:** Entities show 0x000...001 instead of Alice/Hub/Bob

**Solution:**
- Check gossip profile creation in prepopulateAHB
- Verify buildEntityProfile() called with name
- Debug name resolution in EntitiesPanel
- Test that Alice/Hub/Bob appear

**Files:**
- runtime/prepopulate-ahb.ts (check gossip.announce)
- frontend/src/lib/view/panels/EntitiesPanel.svelte (name display)

### 2. Fix Frame Count (HIGH - 1h)
**Problem:** 18 frames instead of 9

**Solution:**
- Count pushSnapshot calls in prepopulate-ahb.ts (verify = 9)
- Check if old frames persist after .clear()
- Add env.history = [] BEFORE prepopulate
- Test frame count correct

### 3. Integrate EntityObject (HIGH - 2h)
**Problem:** Labels float separately

**Solution:**
- Import EntityObject into Graph3DPanel ✅ (done)
- Find entity creation (~line 1040-1100)
- Replace with: new EntityObject(data)
- Test labels stick to entities

**File:** frontend/src/lib/view/panels/Graph3DPanel.svelte

### 4. Subtitle Rendering (MEDIUM - 30min)
**Problem:** FrameSubtitle doesn't show in /view

**Solution:**
- Check /view/core/TimeMachine.svelte wiring
- Verify currentSubtitle reactive var
- Test subtitle appears at bottom

---

## 📁 FILES CREATED THIS SESSION:

```
runtime/
├─ prepopulate-ahb.ts (AHB demo, 9 frames)
├─ prepopulate-full-mechanics.ts (15 frames, 10 mechanics)

frontend/src/lib/
├─ components/TimeMachine/FrameSubtitle.svelte (Fed Chair subtitles)
├─ view/3d/EntityObject.ts (proper entity hierarchy)
├─ view/3d/README.md (refactor plan)

e2e/ahb-smoke.spec.ts (smoke test)
tests/ahb-demo.spec.ts (E2E test)
TESTING-AHB.md (instructions)
vibepaper/architecture/jurisdiction-requirement.md
```

---

## 🧪 TESTING:

**Working Path (NOW):**
```
https://localhost:8080 (main UI)
→ Settings gear
→ Dropdown: "Alice-Hub-Bob Demo"
→ Click "Run"
→ Wait 3 sec
→ Navigate with arrow keys
→ Subtitles show! ✅
```

**Broken Path:**
```
https://localhost:8080/view
→ Architect → Economy → LVL 1 → Alice-Hub-Bob
→ Entities show but wrong names ❌
→ 18 frames (not 9) ❌
```

---

## 💾 COMMITS TODAY: 20

```
d13f0f8 debug: extensive logging in prepopulateAHB
059900e debug: extensive logging in ArchitectPanel
3aa7a59 fix: smoke test checks UI
16c0824 cleanup: remove ALL emojis from panels
3276257 fix: remove BANK_NAMES from Graph3D
42946d4 fix: remove hardcoded bank names (ROOT CAUSE)
1b663c9 fix: clear isolated env before tutorials
420868a arch: EntityObject encapsulation
... +12 more
```

---

## 🔧 ARCHITECTURAL NOTES:

**View Isolation (MUST REMEMBER):**
- /view uses localEnvStore (isolated, no window.XLN)
- Embeddable design
- No global state
- All stores passed as props

**Entity Hierarchy:**
```
EntityObject extends THREE.Group
├─ mesh (octahedron)
├─ label (sprite - CHILD, moves with entity)
├─ reserveBar (CHILD)
└─ edges[] (managed)
```

**Prepopulate Flow:**
```
1. .clear() replicas + history
2. createNumberedEntity() → importReplica
3. openAccount between entities
4. setReservesAndAccounts()
5. pushSnapshot() for each frame
```

---

## 🎯 QUICK WINS FOR NEXT SESSION:

1. **Hard refresh browser** (Ctrl+Shift+R)
2. **Check console for [AHB] logs**
3. **Verify gossip profiles have names**
4. **Fix name resolution** (EntitiesPanel)
5. **Test Alice/Hub/Bob appear**

**Estimated:** 2-3 hours focused work

---

## 📝 REMEMBER:

- prepopulateAHB code = CORRECT ✅
- Architecture = SOUND ✅
- Integration = INCOMPLETE ⏳
- Main UI = WORKS ✅

Next session = debugging + integration, NOT new features!
