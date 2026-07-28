# /view — dock workspace

Panel workspace behind `/app` (dev mode) and `/embed`. Entry point is `View.svelte`.

## Layout

```
/view
├── View.svelte                 # Entry: wires runtime stores, picks user mode vs dock
├── DockRoot.svelte             # Dockview host. Panels are registered in code, not JSON
├── UserModePanel.svelte        # Simplified wallet surface (userMode=true)
│
├── core/
│   ├── TimeMachine.svelte      # Frame scrubber shown under the dock
│   └── NetworkMachineTimeline.svelte
│
├── panels/                     # One file per dock panel
│   ├── Graph3DPanel.svelte     # 3D network view (three.js)
│   ├── graph3d-*.ts            # Graph3D helpers: visuals, renderer, actions, settings, types
│   ├── ArchitectPanel.svelte   # Dev lab (lazy-loaded)
│   ├── JurisdictionPanel.svelte, SettingsPanel.svelte, ConsolePanel.svelte,
│   ├── RuntimeIOPanel.svelte, GossipPanel.svelte, SolvencyPanel.svelte, …
│   └── wrappers/EntityPanelWrapper.svelte
│
├── components/                 # Graph3D chrome: viewport, FPS overlay, VR HUD, mini panel
└── utils/                      # panelBridge (event bus), perfMonitor, frontendLogger
```

`network3d/` (sibling directory) holds the pure, testable layer: runtime→graph projection,
force layout, frame cache, account bar geometry, gesture state. It has no Svelte imports.

## Key decisions

1. **Dockview** hosts the panels; each panel is mounted imperatively in `DockRoot.createComponent`.
2. **Panels are declared in code** (`ensureWorkspacePanels`), not in layout JSON. User-modified
   layouts are serialized to `localStorage['xln-workspace-layout']`.
3. **panelBridge** is the panel-to-panel event bus. Only wire events that have both a producer
   and a consumer — see the comment in `utils/panelBridge.ts`.
4. **Graph3D owns its scene graph.** All graph content is attached to the `graphWorld` group,
   never to `scene` directly: cleanup removes from `graphWorld`, and VR rescales `graphWorld`.
   Attaching content to `scene` silently leaks it on every rebuild.

## Persisted state

| Key | Owner | Contents |
| --- | --- | --- |
| `xln-workspace-layout` | DockRoot | Dockview grid |
| `xln-view-settings` | SettingsPanel | Grid/camera/entity/perf settings, replayed to Graph3D on mount |
| `xln-bird-view-settings` | Graph3DPanel | Camera pose, bars mode, selected token |
| `xln-graph-position-overrides-v1` | graphPositionOverrides | Manually dragged entity positions |
| `xln-dock-entity-open-mode` | SettingsPanel | `replace` vs `new-tab` for entity panels |

## Testing

```bash
bun test tests/frontend/                       # projection, layout, helpers, bar parenting
bunx playwright test tests/dockview.spec.ts    # dock smoke
```
