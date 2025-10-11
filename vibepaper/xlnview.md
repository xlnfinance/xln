# XLNView: Panel-Based Workspace Architecture

**Version:** 4.0 (Panel System + BrowserEVM Integration)
**Last Updated:** 2025-10-11
**Status:** Implementation In Progress

---

## 🎯 Vision

**XLNView** is a flexible, panel-based workspace for XLN economy simulation and analysis. Think **Bloomberg Terminal meets VSCode meets Blender**.

### Key Features
- **Flexible Panels**: Drag, resize, dock, float, tab - full Chrome DevTools UX
- **Four Core Panels**: Graph3D, Entities, Depository, Architect (all open by default)
- **BrowserEVM**: Offline simnet via @ethereumjs/vm (no localhost:8545)
- **Dual Time Machine**: REA (off-chain) + J (on-chain) synchronized timelines
- **Multi-User**: Shareable layout URLs (remote viewing, later)
- **iPad-Optimized**: Vertical stacking on mobile, full-featured on tablet

---

## 🏗️ Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│ XLNView (Orchestrator + Dockview Integration)                  │
├─────────────────────────────────────────────────────────────────┤
│  [≡] [⊕] [⚙] [🔗]         XLN Economy Simulator      [💾] [❓]  │ ← Toolbar
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ╔═══════════════════════╗  ╔════════════════════════════════╗ │
│  ║ 🌐 Graph3D Panel      ║  ║ 🏢 Entities Panel             ║ │
│  ║                       ║  ║ ┌──────────────────────────┐   ║ │
│  ║   ●──────●            ║  ║ │ Entity #1 (Hub)          │   ║ │
│  ║   │      │            ║  ║ │ Reserves: 1.5M USDC      │   ║ │
│  ║   ●──────●──────●     ║  ║ │ Accounts: 12 active      │   ║ │
│  ║                       ║  ║ │ [Details] [Send]         │   ║ │
│  ║ Layout: Force-Directed║  ║ └──────────────────────────┘   ║ │
│  ║ [Grid] [Ring] [Custom]║  ║ Filter: [All] [Active] [Hubs]  ║ │
│  ╚═══════════════════════╝  ╚════════════════════════════════╝ │
│                                                                 │
│  ╔═══════════════════════╗  ╔════════════════════════════════╗ │
│  ║ 🎬 Architect Panel    ║  ║ 💰 Depository Panel (J-State)  ║ │
│  ║ ┌─────────────────┐   ║  ║ Block: 156/234 | Mode: Simnet  ║ │
│  ║ │ Mode: Economy   │   ║  ║ ┌──────────────────────────┐   ║ │
│  ║ └─────────────────┘   ║  ║ │ Token    │ Entity  │ Amt │   ║ │
│  ║ Actions:              ║  ║ ├──────────────────────────┤   ║ │
│  ║ • Mint 1M to Hub      ║  ║ │ USDC(1) │ 0x0001 │ 1.5M│   ║ │
│  ║ • Burn from Entity 3  ║  ║ │ ETH(2)  │ 0x0001 │ 100 │   ║ │
│  ║ • R2R Transfer        ║  ║ │ USDC(1) │ 0x0002 │ 250K│   ║ │
│  ║ [Execute]             ║  ║ └──────────────────────────┘   ║ │
│  ╚═══════════════════════╝  ╚════════════════════════════════╝ │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│ ⏮ ◀◀ ▶ ▶▶ ⏭  [████████░░░░░░░░░░░] t=42s  📍 Frame 847/1203  │ ← Time Machine (draggable)
│ REA: ████████████████ (1203 frames) | J: ██████ (234 blocks)   │
└─────────────────────────────────────────────────────────────────┘
```

---

## 📦 Panel System (Dockview)

### Technology Choice: Dockview

**Why Dockview?**
- **2.8k GitHub stars** (actively maintained, last release Sept 2025)
- **Zero dependencies**, framework-agnostic (Vanilla TS + React + Vue)
- **VSCode-style docking**: Split views, tabs, floating panels, popouts
- **Serialization**: Save/load layouts to JSON (localStorage + shareable URLs)
- **Battle-tested**: Used in production apps, extensive test coverage

**Installation:**
```bash
bun add dockview
```

**Integration with Svelte:**
```typescript
// Dockview uses Vanilla TS API - works perfectly with Svelte
import { DockviewApi, createDockview } from 'dockview';

// Wrap Svelte components in Dockview panels
const panel = dockview.addPanel({
  id: 'graph3d',
  component: 'graph3d-panel', // Registered Svelte component
  title: '🌐 Graph3D',
});
```

### Panel Container Architecture

```typescript
// view/core/PanelContainer.svelte
<script lang="ts">
  import { onMount } from 'svelte';
  import { createDockview } from 'dockview';
  import { panelRegistry } from './PanelRegistry';

  let container: HTMLDivElement;
  let dockview: DockviewApi;

  export let initialLayout: LayoutConfig = 'default';

  onMount(() => {
    // Initialize Dockview
    dockview = createDockview(container, {
      watermark: 'XLN Economy Simulator',
      components: panelRegistry.getAll(),
    });

    // Load layout from preset or localStorage
    const layout = loadLayout(initialLayout);
    dockview.fromJSON(layout);

    // Auto-save layout on changes
    dockview.onDidLayoutChange(() => {
      saveLayout(dockview.toJSON());
    });
  });
</script>

<div bind:this={container} class="dockview-container" />

<style>
  .dockview-container {
    width: 100%;
    height: 100%;
  }
</style>
```

---

## 🎨 Core Panels

### 1. Graph3D Panel (🌐)

**Purpose:** Pure 3D visualization of entity network topology

**Features:**
- Force-directed, grid, ring, custom layouts
- Entity selection → emits events to other panels
- VR mode: Immersive scene rendering
- Performance: 60fps on desktop, 72fps in VR

**Extraction from NetworkTopology:**
```typescript
// OLD: NetworkTopology.svelte (6000 LOC)
// Lines 200-1000: Three.js setup
// Lines 3000-4500: Layout algorithms

// NEW: view/panels/Graph3DPanel.svelte (~400 LOC)
<script lang="ts">
  import { EntityManager } from '$lib/network3d/EntityManager';
  import { AccountManager } from '$lib/network3d/AccountManager';
  import { panelBridge } from '../utils/panelBridge';

  export let env: XLNEnvironment;
  export let layoutMode: 'force' | 'grid' | 'ring' = 'force';

  let canvas: HTMLCanvasElement;
  let scene: THREE.Scene;
  let entityManager: EntityManager;

  function onEntityClick(entityId: string) {
    panelBridge.emit('entity:selected', { entityId });
  }

  // Pure rendering - no UI controls
</script>

<canvas bind:this={canvas} />
<div class="layout-controls">
  <button on:click={() => layoutMode = 'force'}>Force</button>
  <button on:click={() => layoutMode = 'grid'}>Grid</button>
  <button on:click={() => layoutMode = 'ring'}>Ring</button>
</div>
```

**State Sources:**
- REA layer (entity positions, connections)
- Panel bridge events (entity selection)

---

### 2. Entities Panel (🏢)

**Purpose:** List/grid of all entities with real-time state

**Features:**
- Card-based layout (grid view) or table (list view)
- Live reserves, account count, activity indicator
- Actions: Send, Settle, Configure, Delete
- Filter: All / Active / Hubs / Consumers

**Implementation:**
```svelte
<!-- view/panels/EntitiesPanel.svelte -->
<script lang="ts">
  import { panelBridge } from '../utils/panelBridge';
  import { xlnStore } from '$lib/stores/xlnStore';

  let selectedEntityId: string | null = null;
  let filterMode: 'all' | 'active' | 'hubs' = 'all';

  // Listen for entity selection from other panels
  panelBridge.on('entity:selected', ({ entityId }) => {
    selectedEntityId = entityId;
    scrollToEntity(entityId);
  });

  function handleEntityClick(entityId: string) {
    selectedEntityId = entityId;
    panelBridge.emit('entity:selected', { entityId });
  }

  $: filteredEntities = $xlnStore.entities.filter(e => {
    if (filterMode === 'active') return e.accounts.length > 0;
    if (filterMode === 'hubs') return e.type === 'hub';
    return true;
  });
</script>

<div class="entities-panel">
  <div class="toolbar">
    <button on:click={() => filterMode = 'all'}>All</button>
    <button on:click={() => filterMode = 'active'}>Active</button>
    <button on:click={() => filterMode = 'hubs'}>Hubs</button>
  </div>

  <div class="entity-grid">
    {#each filteredEntities as entity (entity.id)}
      <div
        class="entity-card"
        class:selected={entity.id === selectedEntityId}
        on:click={() => handleEntityClick(entity.id)}
      >
        <h3>{entity.name || `Entity ${entity.id.slice(0, 8)}`}</h3>
        <div class="reserves">
          {#each entity.reserves as reserve}
            <span>{reserve.amount} {reserve.token}</span>
          {/each}
        </div>
        <div class="actions">
          <button>Send</button>
          <button>Details</button>
        </div>
      </div>
    {/each}
  </div>
</div>
```

**State Sources:**
- REA layer ($xlnStore)
- Panel bridge events

---

### 3. Depository Panel (💰)

**Purpose:** Query on-chain J-state via BrowserVM (Depository.sol)

**Features:**
- Token balances per entity (absolute on-chain truth)
- Historical snapshots (block-by-block)
- **Divergence detector**: Compare REA vs J-state
- Export state as JSON

**BrowserVM Integration:**
```typescript
// view/utils/browserVMProvider.ts
import { createVM, runTx } from '@ethereumjs/vm';
import { createLegacyTx } from '@ethereumjs/tx';

export class BrowserVMProvider {
  private vm: VM;
  private depositoryAddress: Address;

  async init() {
    this.vm = await createVM();
    // Deploy Depository.sol
    this.depositoryAddress = await this.deployDepository();
  }

  async getReserves(entityId: string, tokenId: number): Promise<bigint> {
    // Call _reserves(bytes32,uint256) view function
    const callData = encodeFunctionCall('_reserves', [entityId, tokenId]);
    const result = await this.vm.evm.runCall({
      to: this.depositoryAddress,
      data: callData,
    });
    return decodeFunctionResult(result.execResult.returnValue);
  }

  async getTokensLength(): Promise<number> {
    // Call getTokensLength() view function
    const callData = encodeFunctionCall('getTokensLength', []);
    const result = await this.vm.evm.runCall({
      to: this.depositoryAddress,
      data: callData,
    });
    return Number(decodeFunctionResult(result.execResult.returnValue));
  }
}
```

**Panel Implementation:**
```svelte
<!-- view/panels/DepositoryPanel.svelte -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { browserVMProvider } from '../utils/browserVMProvider';
  import { panelBridge } from '../utils/panelBridge';

  let reserves: Map<string, Map<number, bigint>> = new Map();
  let selectedEntityId: string | null = null;
  let currentBlock = 0;

  onMount(async () => {
    await browserVMProvider.init();
    await refreshReserves();
  });

  async function refreshReserves() {
    // Query all entities from REA layer
    const entities = $xlnStore.entities;
    const tokensLength = await browserVMProvider.getTokensLength();

    for (const entity of entities) {
      const entityReserves = new Map();
      for (let tokenId = 1; tokenId < tokensLength; tokenId++) {
        const balance = await browserVMProvider.getReserves(entity.id, tokenId);
        if (balance > 0n) {
          entityReserves.set(tokenId, balance);
        }
      }
      reserves.set(entity.id, entityReserves);
    }
    reserves = reserves; // Trigger reactivity
  }

  // Listen for entity selection
  panelBridge.on('entity:selected', ({ entityId }) => {
    selectedEntityId = entityId;
  });

  // Auto-refresh on time machine changes
  panelBridge.on('time:changed', async ({ block }) => {
    currentBlock = block;
    // TODO: Query historical state at specific block
  });
</script>

<div class="depository-panel">
  <div class="header">
    <h3>💰 Depository (On-Chain J-State)</h3>
    <span>Block: {currentBlock} | Mode: Simnet</span>
    <button on:click={refreshReserves}>Refresh</button>
  </div>

  <table>
    <thead>
      <tr>
        <th>Entity</th>
        <th>Token</th>
        <th>Reserves</th>
        <th>REA vs J Diff</th>
      </tr>
    </thead>
    <tbody>
      {#each [...reserves.entries()] as [entityId, entityReserves]}
        {#each [...entityReserves.entries()] as [tokenId, amount]}
          <tr class:selected={entityId === selectedEntityId}>
            <td>{entityId.slice(0, 8)}...</td>
            <td>Token #{tokenId}</td>
            <td>{amount.toString()}</td>
            <td>
              {#if getDivergence(entityId, tokenId, amount)}
                <span class="divergence">⚠️ {getDivergence(entityId, tokenId, amount)}</span>
              {:else}
                <span class="synced">✅</span>
              {/if}
            </td>
          </tr>
        {/each}
      {/each}
    </tbody>
  </table>
</div>
```

**State Sources:**
- J layer (BrowserVM queries)
- REA layer (for comparison)

---

### 4. Architect Panel (🎬)

**Purpose:** God-mode controls for economy manipulation

**5 Modes:**

**🔍 Explore Mode** (Read-only)
- Entity/account inspector
- Timeline scrubber
- Mini-map with heat overlays

**🏗️ Build Mode** (Entity creation)
- Template palette: Hub, Subsidiary, Consumer, Supplier
- Click-to-place in 3D space
- Topology patterns: Grid, Ring, Star, Mesh

**💰 Economy Mode** (Reserve operations)
- Mint: `debugFundReserves(entity, token, amount)`
- Burn: Direct reserve deduction
- R2R: `reserveToReserve(from, to, token, amount)`
- Batch: Multi-operation atomic execution
- Scenario runner: Load .xln.js files

**⚖️ Governance Mode** (Future)
- Multi-sig proposals
- Voting interface
- Entity hierarchy editor

**⚔️ Resolve Mode** (Diagnostics)
- Traffic light view (healthy/warning/risk entities)
- Dispute wizard
- System health dashboard

**Implementation:**
```svelte
<!-- view/panels/ArchitectPanel.svelte -->
<script lang="ts">
  import { browserVMProvider } from '../utils/browserVMProvider';
  import { panelBridge } from '../utils/panelBridge';

  type Mode = 'explore' | 'build' | 'economy' | 'governance' | 'resolve';
  let currentMode: Mode = 'economy';

  // Economy mode actions
  async function mintReserves(entityId: string, tokenId: number, amount: bigint) {
    await browserVMProvider.debugFundReserves(entityId, tokenId, amount);
    panelBridge.emit('reserves:updated', { entityId, tokenId, amount });
  }

  async function executeR2R(from: string, to: string, tokenId: number, amount: bigint) {
    await browserVMProvider.reserveToReserve(from, to, tokenId, amount);
    panelBridge.emit('transfer:executed', { from, to, tokenId, amount });
  }

  // Scenario runner
  async function runScenario(scenarioFile: string) {
    const scenario = await import(`/scenarios/${scenarioFile}`);
    await scenario.execute(browserVMProvider);
  }
</script>

<div class="architect-panel">
  <div class="mode-selector">
    <button class:active={currentMode === 'explore'} on:click={() => currentMode = 'explore'}>
      🔍 Explore
    </button>
    <button class:active={currentMode === 'build'} on:click={() => currentMode = 'build'}>
      🏗️ Build
    </button>
    <button class:active={currentMode === 'economy'} on:click={() => currentMode = 'economy'}>
      💰 Economy
    </button>
    <button class:active={currentMode === 'governance'} on:click={() => currentMode = 'governance'}>
      ⚖️ Governance
    </button>
    <button class:active={currentMode === 'resolve'} on:click={() => currentMode = 'resolve'}>
      ⚔️ Resolve
    </button>
  </div>

  <div class="mode-content">
    {#if currentMode === 'economy'}
      <div class="economy-mode">
        <h3>Economy Operations</h3>
        <div class="action-group">
          <h4>Mint Reserves</h4>
          <input type="text" placeholder="Entity ID" bind:value={mintEntityId} />
          <input type="number" placeholder="Token ID" bind:value={mintTokenId} />
          <input type="number" placeholder="Amount" bind:value={mintAmount} />
          <button on:click={() => mintReserves(mintEntityId, mintTokenId, BigInt(mintAmount))}>
            Execute Mint
          </button>
        </div>

        <div class="action-group">
          <h4>Reserve Transfer (R2R)</h4>
          <input type="text" placeholder="From Entity" bind:value={r2rFrom} />
          <input type="text" placeholder="To Entity" bind:value={r2rTo} />
          <input type="number" placeholder="Token ID" bind:value={r2rTokenId} />
          <input type="number" placeholder="Amount" bind:value={r2rAmount} />
          <button on:click={() => executeR2R(r2rFrom, r2rTo, r2rTokenId, BigInt(r2rAmount))}>
            Execute Transfer
          </button>
        </div>

        <div class="scenario-runner">
          <h4>Scenarios</h4>
          <button on:click={() => runScenario('diamond-dybvig.xln.js')}>Diamond-Dybvig</button>
          <button on:click={() => runScenario('phantom-grid.xln.js')}>Phantom Grid</button>
          <button on:click={() => runScenario('corporate-treasury.xln.js')}>Corporate Treasury</button>
        </div>
      </div>
    {/if}

    <!-- Other modes... -->
  </div>
</div>
```

**State Sources:**
- BrowserVM (write operations)
- Scenario files (`.xln.js`)

---

## 🕰️ Dual Time Machine

**Challenge:** XLN has TWO time dimensions:
- **REA layer**: Off-chain consensus, 60fps smooth timeline (ServerFrames)
- **J layer**: On-chain blockchain, discrete blocks (12s intervals)

**Solution:** Dual synchronized timeline

```
┌─────────────────────────────────────────────────────────────┐
│ Time Machine (Draggable Component)                         │
├─────────────────────────────────────────────────────────────┤
│ ⏮ ◀◀ ▶ ▶▶ ⏭  [████████░░░░░░░░░░░] t=42s               │
│                                                             │
│ REA: ████████████████████ (1203 frames, 16.6ms/frame)      │
│ J:   ██████████████ (234 blocks, 12s/block)                │
│                                                             │
│ 📍 Frame 847/1203 | Block 156/234                          │
│ Entity Events: +4 created | Account Events: -2 closed      │
│                                                             │
│ Speed: [0.25x] [0.5x] [1x] [2x] [4x]                       │
│ [🔖 Bookmark] [📸 Snapshot] [💾 Export] [🎬 Record]        │
└─────────────────────────────────────────────────────────────┘
```

**Implementation:**
```svelte
<!-- view/core/TimeMachine.svelte -->
<script lang="ts">
  import { panelBridge } from '../utils/panelBridge';

  export let totalFrames: number;
  export let totalBlocks: number;
  export let draggable = true;

  let currentFrame = 0;
  let currentBlock = 0;
  let playing = false;
  let speed = 1.0;

  // Sync frame → block mapping
  $: currentBlock = Math.floor((currentFrame / totalFrames) * totalBlocks);

  function play() {
    playing = true;
    const interval = setInterval(() => {
      if (currentFrame < totalFrames) {
        currentFrame += 1 * speed;
        panelBridge.emit('time:changed', { frame: currentFrame, block: currentBlock });
      } else {
        playing = false;
        clearInterval(interval);
      }
    }, 16.6); // 60fps
  }

  function seekTo(frame: number) {
    currentFrame = frame;
    panelBridge.emit('time:changed', { frame: currentFrame, block: currentBlock });
  }
</script>

<div class="time-machine" class:draggable>
  <div class="controls">
    <button on:click={() => seekTo(0)}>⏮</button>
    <button on:click={() => currentFrame -= 10}>◀◀</button>
    <button on:click={playing ? pause : play}>{playing ? '⏸' : '▶'}</button>
    <button on:click={() => currentFrame += 10}>▶▶</button>
    <button on:click={() => seekTo(totalFrames)}>⏭</button>
  </div>

  <input
    type="range"
    min="0"
    max={totalFrames}
    bind:value={currentFrame}
    on:input={() => seekTo(currentFrame)}
  />

  <div class="timelines">
    <div class="rea-timeline">
      REA: {currentFrame}/{totalFrames} frames
    </div>
    <div class="j-timeline">
      J: {currentBlock}/{totalBlocks} blocks
    </div>
  </div>
</div>
```

---

## 📱 Layout System

### Default Layout (4 Panels)

```json
{
  "name": "default",
  "version": "4.0",
  "panels": [
    {
      "id": "graph3d",
      "type": "graph3d",
      "position": { "x": 0, "y": 0 },
      "size": { "width": 50, "height": 70 },
      "dock": "left"
    },
    {
      "id": "entities",
      "type": "entities",
      "position": { "x": 50, "y": 0 },
      "size": { "width": 50, "height": 35 },
      "dock": "top-right"
    },
    {
      "id": "depository",
      "type": "depository",
      "position": { "x": 50, "y": 35 },
      "size": { "width": 25, "height": 35 },
      "dock": "right"
    },
    {
      "id": "architect",
      "type": "architect",
      "position": { "x": 75, "y": 35 },
      "size": { "width": 25, "height": 35 },
      "dock": "bottom-right"
    }
  ],
  "timeMachine": {
    "position": "bottom",
    "docked": true
  }
}
```

### Preset Layouts

**Analyst Layout:**
```json
{
  "name": "analyst",
  "panels": [
    { "id": "graph3d", "size": { "width": 60, "height": 100 } },
    { "id": "depository", "size": { "width": 40, "height": 60 } },
    { "id": "console", "size": { "width": 40, "height": 40 } }
  ]
}
```

**Builder Layout:**
```json
{
  "name": "builder",
  "panels": [
    { "id": "architect", "size": { "width": 30, "height": 100 } },
    { "id": "graph3d", "size": { "width": 50, "height": 100 } },
    { "id": "entities", "size": { "width": 20, "height": 100 } }
  ]
}
```

**Embed Layout:**
```json
{
  "name": "embed",
  "panels": [
    { "id": "graph3d", "size": { "width": 100, "height": 100 } }
  ],
  "timeMachine": { "docked": false, "hidden": false }
}
```

### Layout Persistence

```typescript
// view/utils/layoutManager.ts
export class LayoutManager {
  private readonly STORAGE_KEY = 'xln-layout';

  saveLayout(layout: LayoutConfig) {
    localStorage.setItem(this.STORAGE_KEY, JSON.stringify(layout));
  }

  loadLayout(name: string = 'default'): LayoutConfig {
    // Try localStorage first
    const saved = localStorage.getItem(this.STORAGE_KEY);
    if (saved) return JSON.parse(saved);

    // Fall back to preset
    return this.loadPreset(name);
  }

  loadPreset(name: string): LayoutConfig {
    return import(`../layouts/${name}.json`);
  }

  exportLayout(): string {
    const layout = dockview.toJSON();
    return JSON.stringify(layout, null, 2);
  }

  shareLayout(): string {
    const layout = this.exportLayout();
    const encoded = btoa(layout);
    return `${window.location.origin}/view?layout=${encoded}`;
  }
}
```

### URL-Based Layout Sharing

```
https://xln.network/view?layout=eyJuYW1lIjoiY3VzdG9tIiwicGFuZWxzIjpbXX0=
                                  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
                                  Base64-encoded layout JSON
```

**Multi-User Remote Viewing** (Future):
```
https://xln.network/view?session=a1b2c3d4&mode=observe
                                  ^^^^^^^^  Remote session ID
                                                ^^^^^^^ Read-only mode
```

---

## 📱 Mobile & iPad Support

### Responsive Breakpoints

```css
/* Desktop: Full panel layout */
@media (min-width: 1024px) {
  .dockview-container {
    grid-template-columns: 1fr 1fr;
    grid-template-rows: 1fr 1fr;
  }
}

/* Tablet (iPad): Vertical stacking with tabs */
@media (min-width: 768px) and (max-width: 1023px) {
  .dockview-container {
    grid-template-columns: 1fr;
    grid-template-rows: auto;
  }

  .panel {
    min-height: 400px;
  }
}

/* Mobile: Single panel view with bottom tab bar */
@media (max-width: 767px) {
  .dockview-container {
    display: flex;
    flex-direction: column;
  }

  .panel-tabs {
    position: fixed;
    bottom: 0;
    width: 100%;
  }
}
```

### iPad-Specific Features

- **Split View**: Drag panel to edge → auto-dock (Chrome style)
- **Gesture Support**: Two-finger swipe to switch panels
- **Apple Pencil**: Annotate entities in Graph3D
- **Keyboard Shortcuts**: iPad Magic Keyboard support

---

## 🎮 Panel Communication (Event Bridge)

```typescript
// view/utils/panelBridge.ts
import { writable, get } from 'svelte/store';

type EventMap = {
  'entity:selected': { entityId: string };
  'entity:created': { entityId: string; type: string };
  'account:updated': { accountId: string; balance: bigint };
  'reserves:updated': { entityId: string; tokenId: number; amount: bigint };
  'time:changed': { frame: number; block: number };
  'layout:changed': { layout: LayoutConfig };
  'transfer:executed': { from: string; to: string; amount: bigint };
};

class PanelBridge {
  private listeners = new Map<keyof EventMap, Set<Function>>();

  on<K extends keyof EventMap>(event: K, handler: (data: EventMap[K]) => void) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(handler);
  }

  off<K extends keyof EventMap>(event: K, handler: Function) {
    this.listeners.get(event)?.delete(handler);
  }

  emit<K extends keyof EventMap>(event: K, data: EventMap[K]) {
    this.listeners.get(event)?.forEach(handler => handler(data));
  }
}

export const panelBridge = new PanelBridge();
```

**Usage Example:**
```svelte
<!-- Graph3DPanel.svelte -->
<script>
  import { panelBridge } from '../utils/panelBridge';

  function onEntityClick(entityId: string) {
    panelBridge.emit('entity:selected', { entityId });
  }
</script>

<!-- EntitiesPanel.svelte -->
<script>
  import { panelBridge } from '../utils/panelBridge';

  panelBridge.on('entity:selected', ({ entityId }) => {
    selectedEntityId = entityId;
    scrollToEntity(entityId);
  });
</script>
```

---

## 🚀 Implementation Roadmap

### Phase 0: Foundation (Week 1)
- ✅ Install Dockview
- ✅ Create /view folder structure
- ✅ Implement PanelContainer.svelte
- ✅ Create PanelRegistry.ts
- ✅ Build panelBridge event system

### Phase 1: Core Panels (Week 2-3)
- Extract Graph3DPanel from NetworkTopology
- Build EntitiesPanel (reuse existing Entity components)
- Implement DepositoryPanel with BrowserVM
- Create ArchitectPanel (5 modes)

### Phase 2: Time Machine (Week 4)
- Implement draggable TimeMachine component
- Dual timeline (REA + J sync)
- Bookmark/snapshot system

### Phase 3: Layouts (Week 5)
- Create 4 preset layouts (default, analyst, builder, embed)
- Implement layoutManager (save/load)
- URL-based layout sharing

### Phase 4: Polish (Week 6)
- iPad/mobile responsive design
- Keyboard shortcuts
- Accessibility (ARIA labels)
- Performance optimization (60fps)

### Phase 5: Migration (Week 7)
- Deprecate NetworkTopology.svelte
- Redirect old routes to XLNView
- Update all documentation

---

## 📊 Success Metrics

**Performance:**
- Load time: <2s (first paint)
- Panel resize: <16ms (60fps)
- Time machine scrub: <50ms per frame
- Memory per instance: <300MB

**Usability:**
- Layout switch: <100ms
- Panel drag/dock: <50ms latency
- Mobile: Works on iPad Air (2022+)

**Compatibility:**
- Chrome/Edge: 100%
- Firefox: 100%
- Safari: 100%
- Mobile Safari (iPad): 95%

---

## 🔮 Future Enhancements

### Multi-User Collaboration
```typescript
// Remote viewing session
const session = await panelBridge.createRemoteSession();
const shareUrl = `${origin}/view?session=${session.id}&mode=observe`;

// Observer can see layout changes in real-time
panelBridge.on('remote:layout:changed', (layout) => {
  dockview.fromJSON(layout);
});
```

### AI-Assisted Operations
```typescript
// Natural language commands in Architect panel
architect.onCommand('mint 1 million USDC to entity 5', async (cmd) => {
  const { entityId, tokenId, amount } = parseNLCommand(cmd);
  await browserVMProvider.debugFundReserves(entityId, tokenId, amount);
});
```

### VR Mode Enhancements
- Hand tracking for panel manipulation
- Voice commands ("Show entity 82", "Economy mode")
- Spatial audio for entity events
- Haptic feedback for confirmations

---

**End of Specification**

Ready for implementation. Start with Phase 0 (foundation).
