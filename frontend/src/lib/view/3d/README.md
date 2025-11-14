# 3D Rendering Architecture

## Problem with Current Implementation

**Graph3DPanel.svelte = 5414 lines monolith**

Issues:
- Labels created separately from entities → floating bug
- No clear ownership (who owns what?)
- Hard to maintain/extend
- Physics, rendering, UI all mixed together

## Correct Architecture

### Hierarchy (Parent → Child):

```
Scene
└─ JurisdictionGroup (optional visual container)
    └─ EntityObject (THREE.Group)
        ├─ Mesh (octahedron body)
        ├─ Label (sprite - moves WITH entity)
        ├─ ReserveBar (cylinder - moves WITH entity)
        └─ Edges[] (lines to counterparties)
            └─ CollateralLabels (move WITH edge)
```

### Key Principle: **OWNERSHIP**

```typescript
// ✅ CORRECT: Label is OWNED by entity
class EntityObject extends THREE.Group {
  private label: THREE.Sprite;  // Child of this.group

  constructor() {
    this.label = createLabel();
    this.add(this.label);  // ← Automatic parenting
  }

  setPosition(x, y, z) {
    this.position.set(x, y, z);
    // Label moves automatically (it's a child!)
  }
}

// ❌ WRONG: Label created separately
function createEntity() {
  const group = new THREE.Group();
  const mesh = new THREE.Mesh(...);
  group.add(mesh);
  return group;
}

function createLabel(entity) {
  const label = new THREE.Sprite(...);
  label.position.copy(entity.position);  // ← WRONG! Needs manual sync every frame!
  scene.add(label);  // ← WRONG! Not parented to entity!
}
```

## Refactoring Plan

### Phase 1: Entity Encapsulation (DONE)

Created `EntityObject.ts`:
- Encapsulates mesh + label + reserveBar
- Label is child of entity group
- Position updates propagate automatically

### Phase 2: Extract Modules (TODO)

Split Graph3DPanel.svelte:

**1. EntityRenderer.ts** (300 lines)
```typescript
export class EntityRenderer {
  private entities: Map<string, EntityObject> = new Map();

  createEntity(data: EntityData): EntityObject {
    const entity = new EntityObject(data);
    this.entities.set(data.entityId, entity);
    return entity;
  }

  updateEntity(entityId: string, data: Partial<EntityData>) {
    const entity = this.entities.get(entityId);
    if (entity) {
      if (data.reserves) entity.setReserves(data.reserves);
      if (data.position) entity.setPosition(data.position.x, data.position.y, data.position.z);
    }
  }

  removeEntity(entityId: string) {
    const entity = this.entities.get(entityId);
    if (entity) {
      entity.dispose();
      this.entities.delete(entityId);
    }
  }
}
```

**2. EdgeRenderer.ts** (250 lines)
- Renders connections between entities
- Collateral visualization (thickness, color)
- Ondelta gradient

**3. ParticleSystem.ts** (200 lines)
- Broadcast particles
- R2R/R2C flow animations
- Reusable particle pool

**4. ForceLayout.ts** (300 lines)
- Force-directed positioning
- Collision detection
- Topology layouts (H-shape, Star, Mesh)

**5. CameraControls.ts** (150 lines)
- Orbit controls
- Auto-focus on entity
- Zoom/pan management

**6. AnimationLoop.ts** (200 lines)
- RAF loop
- Delta time handling
- Frame synchronization

**7. Graph3DCore.svelte** (500 lines)
- Composes all modules
- Reactive updates from stores
- Scene/renderer setup

### Phase 3: Testing

After refactor:
- All entities should move correctly
- Labels should stick to entities
- No floating artifacts

## Benefits

1. **Maintainability:** Clear module boundaries
2. **Testability:** Each module testable in isolation
3. **Reusability:** EntityObject can be used elsewhere
4. **Performance:** Easier to optimize specific parts
5. **Debugging:** Know exactly which module has bug

## Migration Strategy

1. Create new modules alongside existing code
2. Gradually migrate functionality
3. Keep old code until new code proven
4. Delete old monolith when 100% migrated

## Current Status

- ✅ EntityObject.ts created (Phase 1)
- ⏳ Module extraction (Phase 2)
- ⏳ Integration testing (Phase 3)
