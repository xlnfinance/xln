# Visual Effects System - NetworkTopology Integration Guide

**File:** `src/lib/components/Network/NetworkTopology.svelte` (5933 lines)

This guide shows exact locations for integrating the visual effects system.

---

## 1. Add Imports (After line 11)

```typescript
// Visual effects system
import { effectOperations, activeEffectCount } from '../../stores/visualEffects';
import { SpatialHash, RippleEffect } from '../../vr/EffectsManager';
import { GestureManager } from '../../vr/GestureDetector';
import VisualDemoPanel from '../Views/VisualDemoPanel.svelte';
```

---

## 2. Add Variables (After line 93 - `let entities: EntityData[] = [];`)

```typescript
// Visual effects system
let spatialHash: SpatialHash | null = null;
let gestureManager: GestureManager | null = null;
let entityMeshMap = new Map<string, THREE.Object3D>();
let lastJEventId: string | null = null; // Track processed j-events
```

---

## 3. Initialize in onMount (After renderer setup, around line 550)

Find where renderer is created, add after `scene.add(renderer.xr.getController(1))`:

```typescript
// ===== VISUAL EFFECTS INITIALIZATION =====
spatialHash = new SpatialHash(100); // 100-unit cells
gestureManager = new GestureManager();

// Register shake-to-rebalance callback
gestureManager.on((event) => {
  if (event.type === 'shake-rebalance') {
    console.log('🤝 SHAKE REBALANCE TRIGGERED:', event.entityId);
    handleRebalanceGesture(event.entityId);
  }
});

console.log('✅ Visual effects system initialized');
```

---

## 4. Add Helper Functions (After onMount, around line 700)

```typescript
// ===== VISUAL EFFECTS HANDLERS =====

/**
 * Handle shake-to-rebalance gesture
 */
async function handleRebalanceGesture(entityId: string) {
  try {
    console.log(`🔄 Initiating automatic rebalance for entity: ${entityId}`);

    // Get XLN functions
    const xln = await getXLN();
    if (!xln) {
      console.error('❌ XLN not loaded');
      return;
    }

    // TODO: Implement hub rebalance coordination
    // 1. Scan all accounts for net-spenders (negative delta)
    // 2. Scan all accounts for net-receivers (requestedRebalance > 0)
    // 3. Match spenders with receivers
    // 4. Collect withdrawal signatures
    // 5. Submit atomic batch (C→R from spenders, R→C to receivers)

    console.log('⚠️ Rebalance coordination not yet implemented');

    // For now, just trigger a visual feedback ripple
    if (spatialHash) {
      const entity = entities.find(e => e.id === entityId);
      if (entity) {
        const ripple = new RippleEffect(
          `rebalance-ripple-${Date.now()}`,
          entity.position.clone(),
          500n, // Medium intensity
          entityId,
          spatialHash
        );
        effectOperations.enqueue(ripple);
      }
    }
  } catch (error) {
    console.error('❌ Rebalance gesture failed:', error);
  }
}

/**
 * Handle j-event ripple effects
 */
function handleJEventRipple(jEvent: any) {
  if (!spatialHash || !jEvent) return;

  // Deduplicate - only process each event once
  const eventId = `${jEvent.type}-${jEvent.blockNumber}-${jEvent.transactionHash}`;
  if (lastJEventId === eventId) return;
  lastJEventId = eventId;

  console.log('🌊 J-Event ripple triggered:', jEvent.type);

  // Find entity that triggered the event
  const entity = entities.find(e => e.id === jEvent.entityId || jEvent.from === e.id);
  if (!entity) {
    console.warn('⚠️ Entity not found for j-event:', jEvent);
    return;
  }

  // Calculate gas-weighted intensity
  let gasUsed = 100n; // Default

  switch (jEvent.type) {
    case 'TransferReserveToCollateral':
      gasUsed = 500n; // Medium ripple
      break;
    case 'ProcessBatch':
      // Large ripple based on batch size
      const batchSize = jEvent.data?.batchSize || 1;
      gasUsed = BigInt(Math.min(batchSize * 100, 1000));
      break;
    case 'Dispute':
      gasUsed = 200n; // Small-medium ripple
      break;
    case 'Settlement':
      gasUsed = 300n; // Medium ripple
      break;
  }

  // Create ripple effect
  const ripple = new RippleEffect(
    `jevent-${eventId}`,
    entity.position.clone(),
    gasUsed,
    entity.id,
    spatialHash
  );

  effectOperations.enqueue(ripple);
}
```

---

## 5. Update Animation Loop (Line ~1979-2000)

Find the `animate()` function, add right after `requestAnimationFrame(animate)`:

```typescript
function animate() {
  // VR uses setAnimationLoop, don't double-call requestAnimationFrame
  if (!renderer?.xr?.isPresenting) {
    animationId = requestAnimationFrame(animate);
  }

  // ===== PROCESS VISUAL EFFECTS QUEUE =====
  if (scene && spatialHash) {
    const deltaTime = clock.getDelta() * 1000; // to milliseconds
    effectOperations.process(scene, entityMeshMap, deltaTime, 10);
  }

  // Update VR grabbed entity position
  if (vrGrabbedEntity && vrGrabController) {
    const controllerPos = new THREE.Vector3();
    controllerPos.setFromMatrixPosition(vrGrabController.matrixWorld);

    vrGrabbedEntity.mesh.position.copy(controllerPos);
    vrGrabbedEntity.position.copy(controllerPos);

    // ===== UPDATE GESTURE DETECTOR =====
    if (gestureManager) {
      gestureManager.updateEntity(
        vrGrabbedEntity.id,
        vrGrabbedEntity.position,
        Date.now()
      );
    }

    // ... rest of animate function
```

---

## 6. Update Spatial Hash When Entities Move

Find where entities are updated (around line 800-900 in the reactive `$: if` blocks).
Add after entity positions are set:

```typescript
// Update spatial hash for efficient neighbor queries
if (spatialHash) {
  entities.forEach(entity => {
    spatialHash.update(entity.id, entity.position);
    entityMeshMap.set(entity.id, entity.mesh);
  });
}
```

---

## 7. Add Reactive J-Event Watcher (After other reactive statements, around line 750)

```typescript
// ===== WATCH FOR J-EVENTS =====
$: if ($xlnEnvironment?.lastJEvent) {
  handleJEventRipple($xlnEnvironment.lastJEvent);
}
```

**Note:** This requires adding `lastJEvent` to the Env type in `src/types.ts`:

```typescript
export interface Env {
  // ... existing fields
  lastJEvent?: {
    type: string;
    entityId: string;
    from: string;
    blockNumber: number;
    transactionHash: string;
    data?: any;
  };
}
```

---

## 8. Add Visual Demo Panel to UI (In the HTML template, around line 3500)

Find the sidebar/controls section, add:

```svelte
{#if !zenMode}
  <!-- Existing controls here -->

  <!-- Visual Effects Demo Panel -->
  <div class="effects-panel-container">
    <VisualDemoPanel
      {scene}
      {entityMeshMap}
      {spatialHash}
    />
  </div>
{/if}
```

Add corresponding CSS:

```css
.effects-panel-container {
  position: fixed;
  top: 80px;
  right: 20px;
  z-index: 100;
  max-height: calc(100vh - 100px);
  overflow-y: auto;
}

@media (max-width: 768px) {
  .effects-panel-container {
    right: 10px;
    top: 60px;
  }
}
```

---

## 9. Cleanup on Destroy (In onDestroy, around line 2400)

```typescript
onDestroy(() => {
  // ... existing cleanup

  // Clean up visual effects
  if (gestureManager) {
    gestureManager.clear();
  }
  if (spatialHash) {
    spatialHash.clear();
  }
  effectOperations.clear();
  entityMeshMap.clear();
});
```

---

## Testing Checklist

- [ ] Effects panel appears in sidebar
- [ ] Clicking "Ripple (Small)" creates visible ripple
- [ ] VR shake gesture triggers rebalance (console log)
- [ ] J-events trigger automatic ripples
- [ ] Network Pulse affects all entities
- [ ] No performance issues with 100+ entities
- [ ] Spatial hash efficiently limits affected entities
- [ ] Effects clean up properly (no memory leaks)

---

## Performance Notes

- **Spatial Hash:** Limits ripple calculations to nearby entities only
- **Max Concurrent:** 10 effects at once prevents frame drops
- **GPU Shaders:** Displacement calculated on GPU, not CPU
- **Effect Pooling:** Materials reused where possible
- **Cleanup:** All resources disposed properly on effect completion

---

## Next Steps (Post-Integration)

1. **Implement Rebalance Coordination:** Complete `handleRebalanceGesture()`
   - Scan accounts for net-spenders/receivers
   - Collect signatures
   - Submit atomic batch

2. **Add More Effects:**
   - Lightning strike for payments
   - Camera shake for disputes
   - Particle burst for settlements

3. **VR Enhancements:**
   - Haptic feedback on shake detection
   - Visual shake progress indicator
   - Sound effects for ripples

4. **Optimize:**
   - Profile with 1000+ entities
   - Tune spatial hash cell size
   - Adjust max concurrent effects
