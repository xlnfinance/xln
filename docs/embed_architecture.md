# XLN Embeddable Scenario Architecture

## Key Insight: Isolated Environments

**Problem:** Multiple scenario players on same page would conflict if sharing global state.

**Solution:** Each `IsolatedScenarioPlayer` creates its own XLN environment - completely separate from main app and other players.

---

## Two Player Components

### 1. ScenarioPlayer.svelte (Deprecated)
❌ **Don't use** - Uses global xlnStore, timeStore, IndexedDB
- Shares state with main app
- Can't have multiple instances
- Conflicts with main app state

### 2. IsolatedScenarioPlayer.svelte ✅
✅ **Use this** - Fully isolated per instance
- Creates own XLN environment
- Own Three.js scene
- Own playback state
- No global stores
- No localStorage/IndexedDB
- Can have 10+ on same page

---

## Architecture Comparison

### Global State (Main App)
```typescript
// Single shared environment
xlnStore → xlnEnvironment (global)
timeStore → currentTimeIndex (global)
IndexedDB → persistent history (global)

// Main Graph 3D uses this
<NetworkTopology /> // Reads from global stores
```

### Isolated State (Embeds)
```typescript
// Each player has its own
localEnv = XLN.createEnvironment()  // Isolated
localHistory = [...]                 // Isolated
currentFrame = 0                     // Isolated
Three.js scene/camera/renderer       // Isolated

// No stores, no persistence, no conflicts
```

---

## How IsolatedScenarioPlayer Works

```svelte
<IsolatedScenarioPlayer
  scenario="phantom-grid"
  height="500px"
  loop={true}
  slice="0:3"
/>
```

**Internal flow:**
1. **Load scenario** - fetch from `/scenarios/` or use inline
2. **Create isolated env** - `XLN.createEnvironment()` (fresh instance)
3. **Execute scenario** - `XLN.executeScenario(localEnv, parsed)`
4. **Capture history** - `localHistory = [...localEnv.history]`
5. **Render with Three.js** - Direct rendering, no NetworkTopology
6. **Playback** - Local `currentFrame` counter, no timeStore

**Result:** Completely self-contained, no side effects.

---

## Multiple Embeds Example

```svelte
<!-- Docs page with 3 independent scenarios -->

<IsolatedScenarioPlayer scenario="diamond-dybvig" height="400px" />

Some text here...

<IsolatedScenarioPlayer scenario="phantom-grid" height="500px" loop={true} />

More text...

<IsolatedScenarioPlayer
  scenario={`SEED inline
0: Custom demo
import alice, bob
`}
  height="300px"
/>
```

Each player:
- ✅ Has own timeline
- ✅ Independent play/pause
- ✅ Separate 3D scene
- ✅ No state conflicts
- ✅ No localStorage pollution

---

## Implementation Details

### Isolated Environment Creation

```typescript
// Each player gets fresh environment
const XLN = await import(`/server.js?v=${Date.now()}`);
localEnv = XLN.createEnvironment();  // Fresh, isolated

// Execute scenario on THIS env only
await XLN.executeScenario(localEnv, parsed.scenario);

// Capture history for playback
localHistory = [...localEnv.history];
```

### Direct Three.js Rendering

```typescript
// No NetworkTopology (too heavy, uses global stores)
// Simple direct rendering:

function renderFrame(frameIndex: number) {
  const frameState = localHistory[frameIndex];

  entities.clear();

  frameState.replicas.forEach((_, key: string) => {
    const mesh = createEntityMesh();
    scene.add(mesh);
    entities.set(key, mesh);
  });
}
```

### Playback Control

```typescript
// Local playback state (NOT timeStore)
let currentFrame = 0;
let playing = false;

function play() {
  playbackInterval = setInterval(() => {
    currentFrame++;
    renderFrame(currentFrame);
  }, 1000 / speed);
}
```

---

## Usage Patterns

### In Docs (Multiple Embeds)
```svelte
<!-- DocsView.svelte -->
<IsolatedScenarioPlayer scenario="demo1" />
<IsolatedScenarioPlayer scenario="demo2" />
<IsolatedScenarioPlayer scenario="demo3" />
```

### External iframe
```html
<!-- /embed route uses IsolatedScenarioPlayer -->
<iframe src="https://xln.finance/embed?scenario=phantom-grid&loop=true"></iframe>
```

### Blog Post (10 embeds)
```html
<iframe src="https://xln.finance/embed?scenario=demo1" width="800" height="400"></iframe>
<p>Explanation...</p>
<iframe src="https://xln.finance/embed?scenario=demo2" width="800" height="400"></iframe>
<!-- etc. - all independent -->
```

---

## State Isolation Guarantees

| Feature | Main App | IsolatedScenarioPlayer |
|---------|----------|------------------------|
| **Environment** | Global xlnStore | Local `localEnv` |
| **Time State** | Global timeStore | Local `currentFrame` |
| **History** | IndexedDB | Local `localHistory[]` |
| **Persistence** | localStorage | None (ephemeral) |
| **Three.js** | Shared scene | Own scene per instance |
| **Conflicts** | ❌ Shares state | ✅ Fully isolated |
| **Multiple instances** | ❌ Impossible | ✅ Unlimited |

---

## Performance

### Memory per Player
- XLN environment: ~1 MB
- History frames: ~100 KB (for 10 frames)
- Three.js scene: ~5 MB
- **Total:** ~6 MB per player

**Safe limit:** 5-10 players on one page (~60 MB total)

### Cleanup
Each player cleans up on unmount:
```typescript
onDestroy(() => {
  renderer?.dispose();
  entities.forEach(mesh => {
    mesh.geometry.dispose();
    mesh.material.dispose();
  });
});
```

---

## Future: Advanced Features

Once basic isolated player works, can add:

### EntityManager Integration
```typescript
import { EntityManager } from '$lib/network3d/EntityManager';
const entityManager = new EntityManager(scene);
entityManager.createEntity(profile, position);
```

### Account Connections
```typescript
import { AccountManager } from '$lib/network3d/AccountManager';
const accountManager = new AccountManager(scene);
accountManager.updateAll(entities, frameState.replicas, XLN);
```

### Visual Effects
```typescript
import { RippleEffect } from '$lib/vr/EffectsManager';
// Add ripples, particles, etc. per player instance
```

---

## Migration Guide

**Old (broken with multiple instances):**
```svelte
import ScenarioPlayer from '$lib/components/Embed/ScenarioPlayer.svelte';

<ScenarioPlayer scenario="demo" />  <!-- Uses global state -->
```

**New (isolated, embeddable):**
```svelte
import IsolatedScenarioPlayer from '$lib/components/Embed/IsolatedScenarioPlayer.svelte';

<IsolatedScenarioPlayer scenario="demo" />  <!-- Isolated state -->
```

---

## Summary

✅ **IsolatedScenarioPlayer = True Embeddability**
- No global stores
- No persistence
- No conflicts
- YouTube-style controls
- Unlimited instances per page

This is the foundation for:
- Interactive docs with floating xlnomies
- Blog posts with embedded demos
- External website integrations
- Multi-scenario comparison pages
