# xln improvement tasks for parallel subagents

## execution rules
- each task works in its own branch: `improve/task-XX-short-name`
- NO merging to main - only PRs for review
- tasks are isolated by file/module to avoid conflicts
- run `bun run check` before committing

---

## batch 1: graph3d visual improvements (can run parallel)

### task-01: grid-floor-redesign
**branch:** `improve/task-01-grid-floor`
**files:** `frontend/src/lib/view/panels/Graph3DPanel.svelte` (lines 1200-1300 only - grid creation)
**scope:** Replace current white grid line with subtle gradient floor plane
**details:**
- Create PlaneGeometry with ShaderMaterial
- Gradient from center (dark) to edges (lighter)
- Remove or make optional the current GridHelper
- Add fog effect for depth perception

### task-02: connection-glow-effect
**branch:** `improve/task-02-connection-glow`
**files:** `frontend/src/lib/view/panels/Graph3DPanel.svelte` (lines 2800-3000 - connection lines)
**scope:** Add glow/bloom effect to connection lines between entities
**details:**
- Use LineBasicMaterial with transparent: true
- Add second line slightly thicker with lower opacity for glow
- Color based on connection health/activity
- Animate pulse on active data flow

### task-03: entity-hover-tooltip
**branch:** `improve/task-03-hover-tooltip`
**files:** `frontend/src/lib/view/panels/Graph3DPanel.svelte` (lines 4000-4200 - raycasting)
**scope:** Add HTML tooltip on entity hover showing details
**details:**
- Create CSS2DObject or DOM overlay
- Show: entity name, reserve balance, connection count
- Fade in/out animation
- Position tracking with camera

### task-04: camera-presets
**branch:** `improve/task-04-camera-presets`
**files:** `frontend/src/lib/view/panels/Graph3DPanel.svelte` (lines 800-1000 - camera setup)
**scope:** Add camera preset buttons (top, front, isometric, follow-entity)
**details:**
- Smooth GSAP-like transitions between views
- Save last camera position to localStorage
- Keyboard shortcuts (1,2,3,4 for presets)

### task-05: particle-system-mempool
**branch:** `improve/task-05-particles`
**files:** `frontend/src/lib/view/panels/Graph3DPanel.svelte` (lines 3500-3800 - mempool viz)
**scope:** Improve mempool visualization with particle effects
**details:**
- Use THREE.Points for better performance
- Particle trail effects for moving transactions
- Color coding by transaction type
- Size variation by amount

---

## batch 2: panels & UI (can run parallel - different files)

### task-06: architect-scenario-thumbnails
**branch:** `improve/task-06-thumbnails`
**files:** `frontend/src/lib/view/panels/ArchitectPanel.svelte`
**scope:** Add visual thumbnails/previews for scenarios
**details:**
- Generate SVG topology previews
- Cache thumbnails in localStorage
- Show entity count, connection pattern
- Hover to see description

### task-07: entities-panel-charts
**branch:** `improve/task-07-entity-charts`
**files:** `frontend/src/lib/view/panels/EntitiesPanel.svelte`
**scope:** Add mini sparkline charts for entity balances over time
**details:**
- Track balance history in memory (last 50 frames)
- SVG-based sparklines (no external lib)
- Show trend arrow (up/down/stable)
- Click to expand full chart

### task-08: console-log-filtering
**branch:** `improve/task-08-console-filter`
**files:** `frontend/src/lib/view/panels/ConsolePanel.svelte`
**scope:** Add log level filtering and search
**details:**
- Filter by: info, warn, error, debug
- Regex search in log messages
- Highlight search matches
- Export logs button

### task-09: settings-theme-system
**branch:** `improve/task-09-themes`
**files:** `frontend/src/lib/view/panels/SettingsPanel.svelte`
**scope:** Add theme presets (dark, light, cyberpunk, minimal)
**details:**
- CSS variables for all colors
- Theme preview before applying
- Save to localStorage
- Auto-detect system preference

### task-10: runtime-io-visualization
**branch:** `improve/task-10-runtime-viz`
**files:** `frontend/src/lib/view/panels/RuntimeIOPanel.svelte`
**scope:** Visual timeline for runtime inputs/outputs
**details:**
- Horizontal timeline view
- Color-coded event types
- Click to inspect event details
- Zoom in/out on time axis

---

## batch 3: new components (isolated new files)

### task-11: keyboard-shortcuts-help
**branch:** `improve/task-11-shortcuts`
**files:** NEW `frontend/src/lib/view/components/KeyboardHelp.svelte`
**scope:** Create keyboard shortcuts overlay (press ?)
**details:**
- Modal showing all available shortcuts
- Grouped by category (navigation, playback, panels)
- Register shortcuts in a central map
- Customizable bindings (future)

### task-12: minimap-component
**branch:** `improve/task-12-minimap`
**files:** NEW `frontend/src/lib/view/components/Minimap.svelte`
**scope:** Create minimap showing entity positions
**details:**
- Small canvas in corner of Graph3D
- Show all entities as dots
- Highlight current camera view frustum
- Click to navigate

### task-13: notification-toast
**branch:** `improve/task-13-toasts`
**files:** NEW `frontend/src/lib/view/components/Toast.svelte`, NEW `frontend/src/lib/stores/toastStore.ts`
**scope:** Create toast notification system
**details:**
- Success/error/info/warning variants
- Auto-dismiss with progress bar
- Stack multiple toasts
- API: toast.success("message")

### task-14: command-palette
**branch:** `improve/task-14-command-palette`
**files:** NEW `frontend/src/lib/view/components/CommandPalette.svelte`
**scope:** Create cmd+k command palette
**details:**
- Fuzzy search across all actions
- Recent commands history
- Keyboard navigation
- Extensible command registry

### task-15: connection-inspector
**branch:** `improve/task-15-connection-inspector`
**files:** NEW `frontend/src/lib/view/components/ConnectionInspector.svelte`
**scope:** Detailed view when clicking a connection line
**details:**
- Show both entities
- Balance breakdown (left/right deltas)
- Transaction history on this connection
- Settlement status

---

## batch 4: runtime/backend improvements (different directory)

### task-16: scenario-validator
**branch:** `improve/task-16-validator`
**files:** NEW `runtime/scenario-validator.ts`
**scope:** Validate scenario JSON before execution
**details:**
- Check entity IDs exist
- Validate transaction amounts
- Check balance constraints
- Return detailed error messages

### task-17: replay-export
**branch:** `improve/task-17-replay-export`
**files:** NEW `runtime/replay-export.ts`
**scope:** Export scenario replay as JSON
**details:**
- Capture all frames with timestamps
- Include entity states at each frame
- Compressed format option
- Import function for playback

### task-18: metrics-collector
**branch:** `improve/task-18-metrics`
**files:** NEW `runtime/metrics.ts`
**scope:** Collect performance metrics
**details:**
- Frame processing time
- Entity count over time
- Transaction throughput
- Memory usage estimates

---

## batch 5: documentation & testing (safe - no code changes)

### task-19: component-storybook
**branch:** `improve/task-19-storybook`
**files:** NEW `frontend/src/stories/` directory
**scope:** Create component documentation
**details:**
- Document each panel component
- Show props and usage examples
- Interactive examples
- No runtime changes needed

### task-20: e2e-test-scenarios
**branch:** `improve/task-20-e2e-tests`
**files:** NEW `tests/e2e/` directory
**scope:** Create Playwright e2e tests
**details:**
- Test scenario loading
- Test time machine controls
- Test panel interactions
- Screenshot comparisons

---

## parallel execution groups

**group A (graph3d - sequential within group):**
- task-01, task-02, task-03, task-04, task-05

**group B (panels - full parallel):**
- task-06, task-07, task-08, task-09, task-10

**group C (new components - full parallel):**
- task-11, task-12, task-13, task-14, task-15

**group D (runtime - full parallel):**
- task-16, task-17, task-18

**group E (docs/tests - full parallel):**
- task-19, task-20

---

## agent prompt template

```
You are working on xln improvement task-XX.

CRITICAL RULES:
1. Create branch: git checkout -b improve/task-XX-name
2. ONLY modify files listed in the task
3. Run `bun run check` before any commit
4. DO NOT merge to main
5. Create PR when done: gh pr create --draft

Task details:
[paste task from above]

When done, report:
- Files changed
- Lines added/removed
- Any issues encountered
- PR link
```
