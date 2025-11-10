# bugs found during verification - 2025-11-07

---

## 🐛 bug #1: FPS shows "Infinity"

**Severity:** 🟡 Low (cosmetic, not functional)
**When:** Empty scene (no entities)
**Why:** `deltaTime = 0` → `FPS = 1000/0 = Infinity`

**Location:** Graph3DPanel.svelte (FPS calculation)
**Fix:**
```typescript
// Before:
const fps = deltaTime > 0 ? 1000 / deltaTime : 0;

// After:
const fps = deltaTime > 0 ? Math.min(1000 / deltaTime, 9999) : 0;
// Clamp to 9999 max (Infinity looks unprofessional)
```

**Priority:** Low (fix when touching Graph3DPanel)

---

## 🐛 bug #2: Topology presets need jurisdiction

**Severity:** 🔴 High (breaks user experience)
**When:** Clicking HYBRID/STAR/MESH/TIERED/CORRESPONDENT/S&P 500
**Error:** "❌ Create jurisdiction first"

**Location:** ArchitectPanel.svelte (createEconomyWithTopology function)
**Fix:** Apply same auto-create pattern as Step 1 demo

**Impact:** All 6 economy presets broken for new users

**Priority:** Critical (same as Fed Chair demo fix)

---

## 🐛 bug #3: Console error on topology click

**Error:**
```
[ERROR] [Architect] No active xlnomy
```

**Why:** Topology functions check `if (!$isolatedEnv?.activeXlnomy)` and error instead of creating

**Fix:** Auto-create jurisdiction in `createEconomyWithTopology()`

---

## 🐛 bug #4: No Alice-Hub-Bob simple preset

**Severity:** 🟡 Medium (missing feature)
**Issue:** Most basic payment demo (A→H→B) doesn't exist
**Need:** Dead-simple 3-entity demo for beginners

**Proposal:**
```
Alice ←→ Hub ←→ Bob

- Alice sends $100 to Bob
- Routed through Hub
- Simplest possible payment path
```

**Priority:** High (educational value)

---

## summary

| Bug | Severity | Status | Priority |
|-----|----------|--------|----------|
| #1 FPS Infinity | 🟡 Low | Found | Low |
| #2 Topology broken | 🔴 High | Found | Critical |
| #3 Console error | 🟡 Medium | Found | Medium |
| #4 Missing A-H-B | 🟡 Medium | Found | High |

**Action:** Fix #2 (same pattern as Fed Chair demo), then add #4

---

**Next steps:**
1. Find createEconomyWithTopology() function
2. Add auto-jurisdiction creation
3. Test all 6 topologies
4. Add Alice-Hub-Bob preset
5. Fix FPS Infinity (low priority)
