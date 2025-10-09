# Frontend Refactoring Plan - Breaking Down God Components

## 🎯 Problem: Monster Files

**Current State:**
- `NetworkTopology.svelte`: **5933 lines** (3879 script + 1462 style) - 62+ functions
- `AccountPanel.svelte`: **1609 lines**
- `SettingsView.svelte`: **1201 lines**
- `EntityPanel.svelte`: **1100 lines**

**Total bloat:** 9,843 lines across 4 files = maintenance nightmare

---

## 📦 NetworkTopology.svelte Split Strategy (Priority: HIGH)

### Current Structure Analysis

**62 Functions grouped by responsibility:**

1. **Entity Management** (~800 lines)
   - `createEntityNode()` - Creates Three.js mesh + label
   - `createEntityLabel()` - Sprite text labels
   - `updateEntityLabels()` - Billboard effect (face camera)
   - `getEntitySizeForToken()` - Cached size calculation
   - `getEntityBalanceInfo()` - Balance tooltips
   - `getEntityShortName()` - Display name formatting

2. **Connection Management** (~600 lines)
   - `createConnections()` - All lines between entities
   - `createConnectionLine()` - Single line geometry
   - `createProgressBars()` - 7-region capacity bars
   - `updateConnectionsForEntity()` - Selective updates on drag
   - `buildConnectionIndexMap()` - O(1) lookup optimization
   - `createChannelBars()` - Detailed bar rendering
   - `createDeltaSeparator()` - Visual separators

3. **Layout Algorithms** (~400 lines)
   - `applyForceDirectedLayout()` - Physics simulation
   - `applySimpleRadialLayout()` - Hub-spoke pattern
   - `enforceSpacingConstraints()` - Collision detection
   - `applyCollisionRepulsion()` - Entity push-apart

4. **Animation System** (~500 lines)
   - `animate()` - Main loop (60fps)
   - `animateParticles()` - Transaction particles
   - `animateEntityPulses()` - Hub glow effect
   - `updateRipples()` - Broadcast ripples
   - `createTransactionParticles()` - Particle spawner
   - `createDirectionalLightning()` - Hub lightning bolts

5. **VR Controllers** (~150 lines)
   - `setupVRControllers()` - XR session init
   - `onVRSelectStart()` - Grab entity
   - `onVRSelectEnd()` - Release entity

6. **Input Handlers** (~400 lines)
   - `onMouseDown/Up/Move/Click/DoubleClick()`
   - `onTouchStart/Move/End()`
   - `handleResizeStart/Move/End()` - Canvas resize

7. **Route System** (~300 lines)
   - `calculateAvailableRoutes()` - Dijkstra pathfinding
   - `highlightRoutePath()` - Visual feedback
   - `clearRouteHighlight()` - Cleanup

8. **Settings & Persistence** (~200 lines)
   - `loadBirdViewSettings()` - localStorage
   - `saveBirdViewSettings()` - Persist camera/bars
   - `saveEntityPositions()` - Manual pins

9. **UI Helpers** (~200 lines)
   - `formatFinancialAmount()` - BigInt display
   - `getTokenSymbol()` - Token names
   - `getDualConnectionAccountInfo()` - Bilateral data
   - `logActivity()` - Sidebar log

10. **Effects & Particles** (~300 lines)
    - `createBroadcastRipple()` - On-chain event viz
    - `createRipple()` - Generic ripple
    - `detectJurisdictionalEvents()` - J-watcher integration

---

## 🔨 Proposed Refactor (Idiomatic Svelte)

### Strategy 1: Extract Pure Logic to TypeScript Modules

```
/frontend/src/lib/network3d/
├── EntityManager.ts         (Entity creation, labels, sizing)
├── ConnectionManager.ts     (Lines, bars, channel rendering)
├── LayoutEngine.ts          (Force-directed, radial, collision)
├── AnimationController.ts   (Main loop, particles, pulses)
├── VRControllers.ts         (XR session, grab/release)
├── InputHandler.ts          (Mouse, touch, drag handlers)
├── RouteCalculator.ts       (Pathfinding, highlighting)
├── SettingsPersistence.ts   (localStorage, camera state)
└── types.ts                 (EntityData, ConnectionData, etc.)
```

**Benefits:**
- **Testable:** Pure functions, no Svelte magic
- **Reusable:** Import into other components
- **Type-safe:** Full TypeScript inference
- **Small files:** 150-300 lines each

**Example - EntityManager.ts:**
```typescript
import * as THREE from 'three';
import type { EntityData } from './types';

export class EntityManager {
  private scene: THREE.Scene;
  private entities = new Map<string, EntityData>();

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  createEntity(profile: any, position: THREE.Vector3): EntityData {
    const geometry = new THREE.SphereGeometry(2, 32, 32);
    const material = new THREE.MeshLambertMaterial({
      color: profile.isHub ? 0x00ff88 : 0x007acc,
      emissive: profile.isHub ? 0x00ff88 : 0x000000,
      emissiveIntensity: profile.isHub ? 2.0 : 0
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.copy(position);
    this.scene.add(mesh);

    const entity: EntityData = {
      id: profile.entityId,
      position: position.clone(),
      mesh,
      profile,
      isHub: profile.isHub,
      pulsePhase: Math.random() * Math.PI * 2
    };

    this.entities.set(entity.id, entity);
    return entity;
  }

  updateLabels(camera: THREE.Camera) {
    this.entities.forEach(entity => {
      if (entity.label) {
        entity.label.quaternion.copy(camera.quaternion);
      }
    });
  }

  // ... more methods
}
```

**NetworkTopology.svelte becomes:**
```svelte
<script lang="ts">
  import { EntityManager } from '$lib/network3d/EntityManager';
  import { ConnectionManager } from '$lib/network3d/ConnectionManager';
  import { LayoutEngine } from '$lib/network3d/LayoutEngine';
  import { AnimationController } from '$lib/network3d/AnimationController';

  let entityManager: EntityManager;
  let connectionManager: ConnectionManager;
  let layoutEngine: LayoutEngine;
  let animationController: AnimationController;

  onMount(() => {
    // Initialize managers
    entityManager = new EntityManager(scene);
    connectionManager = new ConnectionManager(scene);
    layoutEngine = new LayoutEngine();
    animationController = new AnimationController(scene);

    // Setup entities
    $visibleReplicas.forEach(replica => {
      const position = layoutEngine.calculatePosition(replica);
      entityManager.createEntity(replica, position);
    });

    // Setup connections
    connectionManager.createAll(entityManager.getEntities());

    // Start animation
    animationController.start(() => {
      entityManager.updateLabels(camera);
      connectionManager.update();
    });
  });
</script>

<!-- Reduced to ~1000 lines from 5933 -->
```

---

### Strategy 2: Extract UI Components

```
/frontend/src/lib/components/Network/
├── NetworkTopology.svelte        (1000 lines - main orchestrator)
├── NetworkControls.svelte        (300 lines - bird view, tokens, bars)
├── RouteHighlighter.svelte       (200 lines - pathfinding UI)
├── NetworkSettings.svelte        (200 lines - camera, layout options)
└── NetworkStats.svelte           (150 lines - FPS, entity count)
```

---

### Strategy 3: Composition Pattern (Svelte Slots)

Keep NetworkTopology as a "shell" that accepts plugins:

```svelte
<!-- NetworkTopology.svelte - 500 lines -->
<script lang="ts">
  export let entityRenderer: EntityRenderer;
  export let connectionRenderer: ConnectionRenderer;
  export let animationLoop: AnimationLoop;

  // Minimal orchestration logic
</script>

<canvas bind:this={container} />

<slot name="controls" />
<slot name="overlay" />
```

---

## 📊 Estimated Line Reduction

| File | Before | After | Reduction |
|------|--------|-------|-----------|
| NetworkTopology.svelte | 5933 | 1000 | **-83%** |
| EntityManager.ts | 0 | 250 | +250 |
| ConnectionManager.ts | 0 | 300 | +300 |
| LayoutEngine.ts | 0 | 200 | +200 |
| AnimationController.ts | 0 | 300 | +300 |
| VRControllers.ts | 0 | 150 | +150 |
| InputHandler.ts | 0 | 250 | +250 |
| RouteCalculator.ts | 0 | 200 | +200 |
| **Net Change** | **5933** | **2650** | **-55%** |

---

## 🚦 Refactor Phases

### Phase 1: Extract Pure Logic (2-3 hours)
- Create `/lib/network3d/` directory
- Move layout algorithms → `LayoutEngine.ts`
- Move entity logic → `EntityManager.ts`
- Move connection logic → `ConnectionManager.ts`
- **Test:** Ensure 3D still renders correctly

### Phase 2: Extract Animation (1-2 hours)
- Move animation loop → `AnimationController.ts`
- Move particles → `ParticleSystem.ts`
- Move ripples → `RippleEffects.ts`
- **Test:** Ensure animations still work

### Phase 3: Extract Input (1 hour)
- Move mouse/touch → `InputHandler.ts`
- Move VR → `VRControllers.ts`
- **Test:** Ensure dragging/clicking works

### Phase 4: Extract UI Components (1 hour)
- Split controls → `NetworkControls.svelte`
- Split route UI → `RouteHighlighter.svelte`
- **Test:** Ensure UI interactions work

---

## 🎯 Priority Order

1. **NetworkTopology.svelte** (5933 lines) - HIGHEST PRIORITY
   - Most complex
   - Hardest to maintain
   - Blocking visual effects integration

2. **AccountPanel.svelte** (1609 lines) - MEDIUM PRIORITY
   - Can split into:
     - `AccountDetails.svelte` (balance, capacity)
     - `AccountFrames.svelte` (pending, mempool, history)
     - `AccountActions.svelte` (payment, withdraw, rebalance)

3. **SettingsView.svelte** (1201 lines) - LOW PRIORITY
   - Can split into tabs:
     - `GeneralSettings.svelte`
     - `ThemeSettings.svelte`
     - `JurisdictionSettings.svelte`
     - `DebugSettings.svelte`

4. **EntityPanel.svelte** (1100 lines) - LOW PRIORITY
   - Already uses sub-components (ControlsPanel, AccountList, etc.)
   - Just needs better organization

---

## ⚠️ Risks & Mitigation

**Risk 1: Breaking existing functionality**
- **Mitigation:** Incremental refactor, test after each phase

**Risk 2: Svelte reactivity breaks**
- **Mitigation:** Use TypeScript classes with explicit `.update()` methods

**Risk 3: Performance regression**
- **Mitigation:** Profile before/after, keep hot paths optimized

**Risk 4: Time investment (8-10 hours)**
- **Mitigation:** Do Phase 1 only (layout + entities), defer rest

---

## 💡 Recommendation

**Start with Phase 1 (Pure Logic Extraction):**
1. Create `EntityManager.ts` (250 lines)
2. Create `ConnectionManager.ts` (300 lines)
3. Create `LayoutEngine.ts` (200 lines)
4. Update NetworkTopology to use managers

**Result:** 5933 → ~3500 lines (-41%) in 2-3 hours

**Then:** Reassess. If it feels good, continue with Phases 2-4. If not, stop here.

---

## 🔗 Related Files to Refactor (Lower Priority)

- `AccountPanel.svelte` (1609 lines) - Split into 3 components
- `SettingsView.svelte` (1201 lines) - Split into 4 tabs
- `EntityPanel.svelte` (1100 lines) - Better composition

**Total potential reduction:** ~4000 lines across all 4 files
