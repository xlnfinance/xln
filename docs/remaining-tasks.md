# xln Remaining Implementation Tasks

## High Priority

### 1. Consolidate Settings Modal

**Current State:**
- Settings gear icon exists in AdminTopBar
- Modal shows only theme toggle
- J-Block stats, Scale slider, Proposers list scattered in admin bar

**Target State:**
Admin bar should ONLY have:
```
[xln] [Home] [BrainVault] [Graph3D] [Graph2D] [Panels] [Terminal] ... [Settings ⚙️]
```

**Settings Modal Sections:**

```typescript
// UI Preferences
- Theme (dark/light)
- Dropdown Hierarchy Mode (Jur→Signer→Entity vs Jur→Entity→Signers)
- Portfolio Scale ($500 - $50,000)
- Label Size (0.5x - 5.0x)

// Network Statistics (Read-only)
- J-Block: 9
- J-Events: 0
- S-Block (Height): 15
- Proposers: s1@9, s2@2, s3@2, s4@2, s5@2, s6@2 | Next: 0.3s
- Total Entities: 6
- Total Connections: 5

// Developer Tools
- Server Processing Delay (0-1000ms)
- Debug Mode toggle
- Show Console Logs toggle
- Performance Stats toggle

// VR Settings
- Passthrough Default (on/off)
- Controller Sensitivity (0.5-2.0x)
- Subtitle Distance (1-5 meters)
```

**Implementation:**
- Expand AdminTopBar.svelte Settings modal
- Add tabbed sections or collapsible accordions
- Move all stats from admin bar JSX to Settings modal
- Keep admin bar minimal (just view mode buttons)

### 2. BrainVault Integration

**Read:** `frontend/bv.html`

**Port to:** `frontend/src/lib/components/BrainVault/BrainVaultView.svelte`

**Integration:**
1. Add to viewModeStore: `type ViewMode = 'home' | 'brainvault' | 'graph3d' | ...`
2. Add button in AdminTopBar after Home
3. Render in +page.svelte when `$viewMode === 'brainvault'`
4. No time machine on BrainVault view (like Home)

**Careful Porting:**
- Extract all inline styles to `<style>` block
- Convert vanilla JS to Svelte reactive statements
- Import xln functions from xlnStore
- Maintain exact visual appearance
- Keep all functionality

### 3. Draggable Sidebar Width

**Add to NetworkTopology.svelte:**

```typescript
let sidebarWidth = 350; // px, saved to localStorage

function startResizeSidebar(event: MouseEvent) {
  const startX = event.clientX;
  const startWidth = sidebarWidth;

  function onMouseMove(e: MouseEvent) {
    const delta = startX - e.clientX; // Drag left = wider
    sidebarWidth = Math.max(250, Math.min(600, startWidth + delta));
  }

  function onMouseUp() {
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    localStorage.setItem('xln-sidebar-width', String(sidebarWidth));
  }

  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);
}
```

**HTML:**
```html
<div class="topology-overlay" style="width: {sidebarWidth}px">
  <div class="resize-handle" on:mousedown={startResizeSidebar}></div>
  <!-- rest of sidebar -->
</div>
```

**CSS:**
```css
.resize-handle {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 4px;
  cursor: ew-resize;
  background: rgba(0, 122, 204, 0.3);
  opacity: 0;
  transition: opacity 0.2s;
}

.resize-handle:hover {
  opacity: 1;
}
```

### 4. Fix Zen Mode

**Current Issue:**
Zen mode might reset time machine state or view settings.

**Fix:**
Make zen mode purely cosmetic:

```typescript
// In +page.svelte
let zenMode = false; // Local state only, no store

function toggleZenMode() {
  zenMode = !zenMode;
  // Don't touch viewMode, timeStore, or any other state
}
```

**CSS-only:**
```css
.app.zen-mode :global(.admin-top-bar),
.app.zen-mode :global(.time-machine) {
  display: none !important;
}
```

No state changes, just hide/show.

## Medium Priority

### 5. URL Parameter Handling

Parse `?s=<base64>&loop=0:8` on page load:

```typescript
// In +page.svelte onMount
const params = new URLSearchParams(window.location.search);
const scenarioParam = params.get('s');
const loopParam = params.get('loop');

if (scenarioParam) {
  const scenarioText = atob(scenarioParam);
  // Execute scenario
  // If loop param, enable looping
}
```

### 6. Create 8 Tutorial Scenarios

Missing scenarios from home page list:
- lightning-inbound-capacity.scenario.txt
- credit-expansion.scenario.txt
- collateral-backstop.scenario.txt
- multi-hop-routing.scenario.txt
- hub-liquidity-crisis.scenario.txt
- bilateral-settlement.scenario.txt
- rebalancing.scenario.txt
- multi-jurisdiction.scenario.txt

Each ~50 lines, demonstrates specific financial mechanism.

## Low Priority

### 7. Draggable Sidebar Width
(Moved to high priority per user request)

### 8. Command History
- ↑/↓ arrows in Live Command input
- Store last 20 commands in localStorage
- Fuzzy search history

### 9. Scenario Marketplace
- Browse community scenarios
- Fork/remix
- Upvote/comment

## Implementation Notes

**Token Usage:** Currently 56% (559k/1000k)

**Recommended Next Session:**
1. Settings consolidation (requires careful refactoring)
2. BrainVault port (needs bv.html analysis)
3. Draggable sidebar (straightforward)
4. Zen mode fix (trivial)

All four tasks should complete in one focused session with fresh context.
