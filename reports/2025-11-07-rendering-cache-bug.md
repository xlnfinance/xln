# rendering cache bug - hybrid sometimes doesn't appear - 2025-11-07

**Problem:** Click "Create HYBRID Economy" → console shows entities created but Graph3D empty
**Workaround:** Create J-Machine → everything appears

---

## 🐛 root cause analysis

### rendering pipeline (from first principles)

```
1. User clicks "Create HYBRID Economy"
2. ArchitectPanel calls XLN.applyRuntimeInput()
3. Entities added to $isolatedEnv.replicas (Map)
4. ArchitectPanel calls isolatedEnv.set($isolatedEnv)
5. Graph3DPanel reactive statement triggers: $: if ($isolatedEnv && scene)
6. Checks: currentCount !== lastReplicaCount
7. If different: calls updateNetworkData() after 16ms debounce
8. updateNetworkData() syncs entities to Three.js scene
9. Scene renders
```

### where it fails

**Line 912-924 (Graph3DPanel):**
```typescript
$: if ($isolatedEnv && scene) {
  const currentCount = $isolatedEnv.replicas?.size || 0;
  if (currentCount !== lastReplicaCount) {  // ← PROBLEM HERE
    lastReplicaCount = currentCount;
    // updateNetworkData() scheduled
  }
}
```

**Issue:** Svelte batches updates. Sometimes:
- `isolatedEnv.set($isolatedEnv)` happens
- Reactive statement runs
- But `replicas.size` comparison happens BEFORE the Map actually updates
- So `currentCount === lastReplicaCount` (both 0 or both 9)
- updateNetworkData() never called
- Entities exist in data but not in scene

**Why J-Machine fixes it:**
- Creating J-Machine triggers xlnomies reactive statement (line 582)
- That causes a different update path
- Eventually triggers full re-render
- Entities appear

---

## 🔧 fixes (ordered by confidence)

### fix 1: force update on topology creation (95% confidence)

**In ArchitectPanel after creating topology:**
```typescript
// Current:
isolatedEnv.set($isolatedEnv);

// Better:
isolatedEnv.update(env => {
  return {...env, replicas: new Map(env.replicas)}; // Force new Map reference
});
```

**Why:** Svelte detects Map replacement, guaranteed reactivity

### fix 2: bypass debounce on topology creation (90% confidence)

**In Graph3DPanel:**
```typescript
$: if ($isolatedEnv && scene) {
  const currentCount = $isolatedEnv.replicas?.size || 0;
  // Remove the if check - always update
  lastReplicaCount = currentCount;
  updateNetworkData(); // Call immediately, no debounce
}
```

**Why:** Debouncing might cause race condition with batched updates

### fix 3: manual scene.add() in createEntitiesFromTopology (80% confidence)

**In ArchitectPanel:**
```typescript
await createEntitiesFromTopology(topology);

// Add immediate render trigger:
window.dispatchEvent(new CustomEvent('xln:entities-created'));
```

**In Graph3DPanel:**
```typescript
window.addEventListener('xln:entities-created', () => {
  updateNetworkData();
});
```

**Why:** Explicit event bypasses Svelte reactivity timing

---

## 🎯 recommended fix (combine 1 + 2)

**Simple, high confidence:**

1. In ArchitectPanel, use `.update()` instead of `.set()`
2. In Graph3DPanel, call updateNetworkData() immediately (no debounce check)

**Code:**
```typescript
// ArchitectPanel.svelte - After topology creation
isolatedEnv.update(env => ({...env})); // Force reference change

// Graph3DPanel.svelte:912-924
$: if ($isolatedEnv && scene) {
  updateNetworkData(); // Remove debounce, always update
}
```

---

## 🔍 why this is hard to debug

**Symptoms:**
- Works in Playwright tests (timing different)
- Works after creating J-Machine (different code path)
- Works sometimes (race condition)
- Console shows entities exist (data is correct)
- Graph3D empty (rendering not triggered)

**Classic:** Svelte reactivity + async updates + debouncing = timing hell

---

## 🚀 immediate workaround (for user)

**If HYBRID doesn't appear:**
1. Click "Create Jurisdiction" button (creates J-Machine)
2. HYBRID entities will appear
3. OR reload page and try again

---

## ✅ verification after fix

**Test:**
1. Reload page (fresh state)
2. Click "Create HYBRID Economy" 10 times
3. Should work 10/10 times (not 7/10 or 8/10)

**If still fails:**
- Check browser console for errors
- Check if updateNetworkData() is being called
- Add console.log in reactive statement

---

**Prepared by:** Claude
**Date:** 2025-11-07
**Confidence:** 90% (Svelte reactivity timing issue)
**Time to fix:** 15 minutes
