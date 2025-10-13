# /view - XLNView Panel Architecture

**New implementation** of XLNView with flexible panel-based workspace.

## Directory Structure

```
/view
├── README.md                       # This file
├── XLNView.svelte                  # Main orchestrator (replaces NetworkTopology)
│
├── core/                           # Core components
│   ├── PanelContainer.svelte       # Dockview wrapper
│   ├── PanelRegistry.ts            # Panel definitions and factory
│   └── TimeMachine.svelte          # Moveable time control
│
├── panels/                         # Individual panels
│   ├── Graph3DPanel.svelte         # 3D visualization (extracted from NetworkTopology)
│   ├── EntitiesPanel.svelte        # Entity list/grid with actions
│   ├── DepositoryPanel.svelte      # BrowserVM queries (J-state viewer)
│   ├── ArchitectPanel.svelte       # 5 modes (Explore/Build/Economy/Governance/Resolve)
│   ├── AccountsPanel.svelte        # Bilateral account details
│   ├── ConsolePanel.svelte         # Event log stream
│   └── NetworkPanel.svelte         # Gossip/consensus health
│
├── layouts/                        # Layout presets
│   ├── default.json                # Graph3D + Entities + Depository + Architect
│   ├── analyst.json                # Graph3D + Depository + Console
│   ├── builder.json                # Architect + Graph3D + Entities
│   ├── embed.json                  # Graph3D only (fullscreen)
│   └── tutorial.json               # Graph3D + Architect (with narrative)
│
└── utils/                          # Utilities
    ├── layoutManager.ts            # Save/load layouts to localStorage
    ├── panelBridge.ts              # Communication between panels
    └── browserVMProvider.ts        # BrowserVM integration
```

## Key Design Decisions

1. **Dockview Library**: Battle-tested (2.8k stars), zero deps, Vanilla TS
2. **Panel Isolation**: Each panel is self-contained Svelte component
3. **State Bridge**: Central event bus for panel-to-panel communication
4. **BrowserVM**: Depository panel queries in-browser EVM for J-state
5. **Layout Persistence**: Layouts saved to localStorage + shareable JSON
6. **Mobile-First**: Vertical stacking on iPad/mobile

## Migration Strategy

1. **Phase 0** (This PR): New /view structure, core panels
2. **Phase 1**: Extract Graph3D from NetworkTopology → Graph3DPanel
3. **Phase 2**: Build Entities + Depository + Architect panels
4. **Phase 3**: Wire up BrowserVM to Depository panel
5. **Phase 4**: Deprecate NetworkTopology, redirect to XLNView

## Usage

```svelte
<!-- New main app entry -->
<script>
  import XLNView from './view/XLNView.svelte';
</script>

<XLNView
  layout="default"
  networkMode="simnet"
/>
```

## Panel Communication Pattern

```typescript
// panels/Graph3DPanel.svelte
import { panelBridge } from '../utils/panelBridge';

function onEntityClick(entityId: string) {
  panelBridge.emit('entity:selected', { entityId });
}

// panels/EntitiesPanel.svelte
import { panelBridge } from '../utils/panelBridge';

panelBridge.on('entity:selected', ({ entityId }) => {
  // Scroll to and highlight entity
  selectedEntityId = entityId;
});
```

## Testing

```bash
# Run new view in isolation
bun run dev:view

# Compare with old NetworkTopology
bun run dev:legacy
```
