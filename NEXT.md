# NEXT.md - Priority Tasks

## 🔥 COMPLETED (2025-11-29): EntityEnvContext Integration Fix

### STATUS: /view EntityPanel context fully integrated ✅

**FIXED THIS SESSION:**

### EntityEnvContext Integration (Junior Review Fixes)
- ✅ **EntityPanel.svelte** - Now consumes context for replicas, xlnFunctions, history, timeIndex
- ✅ **EntityDropdown.svelte** - Uses getEntityEnv() with global fallback
- ✅ **AccountPanel.svelte** - Uses context for xlnFunctions and xlnEnvironment
- ✅ **PaymentPanel.svelte** - Fixed context replicas priority over props over global
- ✅ **SettlementPanel.svelte** - Uses context for replicas, xlnFunctions, xlnEnvironment
- ✅ **TransactionHistory** - Now receives time-aware history/timeIndex from context
- ✅ **ChatMessages** - Now receives time-aware currentTimeIndex from context

### Subscription Leak Fixes (panelBridge cleanup)
- ✅ **EntitiesPanel.svelte** - Added onDestroy with unsubscribe()
- ✅ **ArchitectPanel.svelte** - Added onDestroy with unsubscribe() for vr:payment, auto-demo:start
- ✅ **View.svelte** - Added onDestroy with unsubscribe() for openEntityOperations

### Build Status
- **0 TypeScript errors**
- **208 warnings** (unchanged, non-blocking)

---

## 📁 FILES MODIFIED THIS SESSION:

```
frontend/src/lib/components/Entity/
├─ EntityPanel.svelte (context consumption + history/timeIndex)
├─ EntityDropdown.svelte (context consumption)
├─ AccountPanel.svelte (context consumption)
├─ PaymentPanel.svelte (context priority fix)
├─ SettlementPanel.svelte (context consumption)

frontend/src/lib/view/panels/
├─ EntitiesPanel.svelte (subscription leak fix)
├─ ArchitectPanel.svelte (subscription leak fix)

frontend/src/lib/view/
├─ View.svelte (subscription leak fix + onDestroy)
```

---

## 🔧 PATTERN USED (EntityEnvContext):

```typescript
// In component script:
import { getEntityEnv, hasEntityEnvContext } from '$lib/view/components/entity/shared/EntityEnvContext';

// Get context if available (for /view route)
const entityEnv = hasEntityEnvContext() ? getEntityEnv() : null;

// Extract stores
const contextReplicas = entityEnv?.replicas;
const contextXlnFunctions = entityEnv?.xlnFunctions;
const contextHistory = entityEnv?.history;
const contextTimeIndex = entityEnv?.timeIndex;

// Reactive: prioritize context over global stores
$: activeReplicas = contextReplicas ? $contextReplicas : $visibleReplicas;
$: activeXlnFunctions = contextXlnFunctions ? $contextXlnFunctions : $xlnFunctions;
$: activeHistory = contextHistory ? $contextHistory : $history;
$: activeTimeIndex = contextTimeIndex !== undefined ? $contextTimeIndex : $currentTimeIndex;
```

---

## 🎯 NEXT SESSION PRIORITIES:

### 1. Time Machine Testing in /view (HIGH)
- Verify time travel works with entity panel open
- Test historical frame displays correct data
- Check TransactionHistory shows correct history

### 2. Click-to-Expand Entity Flow (MEDIUM)
- Fix entity sphere click detection positions
- Verify mini-panel → expand → entity panel flow
- Test entity dropdown shows selected entity

---

## 📝 ARCHITECTURE NOTES:

**EntityEnvContext Purpose:**
- Pierces store boundary once at wrapper level
- Child components consume via getEntityEnv()
- Falls back to global stores for backward compatibility
- Enables time travel in /view workspace

**panelBridge Cleanup Pattern:**
```typescript
import { onDestroy } from 'svelte';

const unsub = panelBridge.on('event', handler);

onDestroy(() => {
  unsub();
});
```
