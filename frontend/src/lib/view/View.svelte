<script lang="ts">
  /**
   * View - Main embeddable workspace
   * Single source for XLN dashboard (4 panels: Graph3D, Entities, Depository, Architect)
   *
   * @license AGPL-3.0
   * Copyright (C) 2025 XLN Finance
   */

  import { onMount, mount } from 'svelte';
  import { writable } from 'svelte/store';
  import { DockviewComponent } from 'dockview';
  import './utils/frontendLogger'; // Initialize global log control
  import Graph3DPanel from './panels/Graph3DPanel.svelte';
  import EntitiesPanel from './panels/EntitiesPanel.svelte';
  import DepositoryPanel from './panels/DepositoryPanel.svelte';
  import ArchitectPanel from './panels/ArchitectPanel.svelte';
  import ConsolePanel from './panels/ConsolePanel.svelte';
  import RuntimeIOPanel from './panels/RuntimeIOPanel.svelte';
  import SettingsPanel from './panels/SettingsPanel.svelte';
  import TimeMachine from './core/TimeMachine.svelte';
  import Tutorial from './components/Tutorial.svelte';
  import 'dockview/dist/styles/dockview.css';

  export let layout: string = 'default';
  export let networkMode: 'simnet' | 'testnet' | 'mainnet' = 'simnet';

  let container: HTMLDivElement;
  let dockview: DockviewComponent;

  // TimeMachine draggable state
  let timeMachinePosition: 'bottom' | 'top' | 'left' | 'right' = 'bottom';
  let collapsed = false;

  // Isolated XLN environment for this View instance (passed to ALL panels + TimeMachine)
  const localEnvStore = writable<any>(null);
  const localHistoryStore = writable<any[]>([]);
  const localTimeIndex = writable<number>(-1);  // -1 = live mode
  const localIsLive = writable<boolean>(true);

  onMount(async () => {
    console.log('[View] onMount started - initializing isolated XLN');

    // Initialize isolated XLN runtime (simnet - BrowserVM mode)
    try {
      // Step 1: Initialize BrowserVM (deploy Depository in-browser)
      const { browserVMProvider } = await import('./utils/browserVMProvider');
      await browserVMProvider.init();
      const depositoryAddress = browserVMProvider.getDepositoryAddress();

      console.log('[View] BrowserVM ready:', { depositoryAddress });

      // Step 2: Load XLN runtime
      const runtimeUrl = new URL('/runtime.js', window.location.origin).href;
      const XLN = await import(/* @vite-ignore */ runtimeUrl);

      // Step 3: Register BrowserVM jurisdiction (overrides DEFAULT_JURISDICTIONS)
      XLN.setBrowserVMJurisdiction(depositoryAddress, browserVMProvider);
      console.log('[View] ✅ BrowserVM jurisdiction registered with browserVM instance');

      // CRITICAL: Initialize global xlnInstance for utility functions (deriveDelta, etc)
      // Graph3DPanel needs xlnFunctions even when using isolated stores
      const { xlnInstance } = await import('$lib/stores/xlnStore');
      xlnInstance.set(XLN);

      // Step 4: Check for URL hash import (shareable state)
      const { parseURLHash } = await import('./utils/stateCodec');
      const urlImport = parseURLHash();

      let env;

      if (urlImport) {
        console.log('[View] 🔗 Importing state from URL hash...');
        env = XLN.createEmptyEnv();

        // Restore xlnomies
        env.xlnomies = urlImport.state.x;
        env.activeXlnomy = urlImport.state.a;

        // Restore entities (replicas)
        env.replicas = urlImport.state.e;

        // Restore UI settings if included
        if (urlImport.includeUI && urlImport.state.ui) {
          // Settings will be loaded by SettingsPanel from its own localStorage
          // Just log that UI was included
          console.log('[View] 📋 URL included UI settings');
        }

        console.log('[View] ✅ Imported:', {
          xlnomies: env.xlnomies.size,
          entities: env.replicas.size,
          active: env.activeXlnomy
        });
      } else {
        // No URL import: Create empty environment
        env = XLN.createEmptyEnv();

        // Initialize with empty frame 0
        env.history = [{
          height: 0,
          timestamp: Date.now(),
          replicas: new Map(),
          runtimeInput: { runtimeTxs: [], entityInputs: [] },
          runtimeOutputs: [],
          description: 'Frame 0: Empty slate',
          title: 'Initial State'
        }];

        console.log('[View] ✅ Empty environment ready (frame 0)');
        console.log('[View] 💡 Use Architect panel to create Xlnomies + entities');
      }

      // Set to isolated stores
      localEnvStore.set(env);
      localHistoryStore.set(env.history || []);
      localTimeIndex.set(urlImport?.state.ui?.ti || 0);
      localIsLive.set(true);

    } catch (err) {
      console.error('[View] ❌ Failed to initialize XLN:', err);
    }

    // Create Dockview
    dockview = new DockviewComponent(container, {
      className: 'dockview-theme-dark',
      createComponent: (options) => {
        const div = document.createElement('div');
        div.style.width = '100%';
        div.style.height = '100%';

        let component: any;

        // Mount Svelte 5 components - pass SAME shared stores to ALL panels
        if (options.name === 'graph3d') {
          component = mount(Graph3DPanel, {
            target: div,
            props: {
              isolatedEnv: localEnvStore,
              isolatedHistory: localHistoryStore,
              isolatedTimeIndex: localTimeIndex
            }
          });
        } else if (options.name === 'entities') {
          component = mount(EntitiesPanel, {
            target: div,
            props: {
              isolatedEnv: localEnvStore,
              isolatedHistory: localHistoryStore,
              isolatedTimeIndex: localTimeIndex
            }
          });
        } else if (options.name === 'depository') {
          component = mount(DepositoryPanel, { target: div });
        } else if (options.name === 'architect') {
          component = mount(ArchitectPanel, {
            target: div,
            props: {
              isolatedEnv: localEnvStore,
              isolatedHistory: localHistoryStore,
              isolatedTimeIndex: localTimeIndex
            }
          });
        } else if (options.name === 'console') {
          component = mount(ConsolePanel, {
            target: div,
            props: {
              isolatedEnv: localEnvStore
            }
          });
        } else if (options.name === 'runtime-io') {
          component = mount(RuntimeIOPanel, {
            target: div,
            props: {
              isolatedEnv: localEnvStore,
              isolatedHistory: localHistoryStore,
              isolatedTimeIndex: localTimeIndex
            }
          });
        } else if (options.name === 'settings') {
          component = mount(SettingsPanel, {
            target: div,
            props: {
              isolatedEnv: localEnvStore,
              isolatedHistory: localHistoryStore,
              isolatedTimeIndex: localTimeIndex
            }
          });
        }

        // Return Dockview-compatible API
        return {
          element: div,
          init: () => {}, // Svelte components self-initialize
          dispose: () => {
            // Svelte 5: unmount() happens automatically when DOM removed
            // No need to call $destroy() - it doesn't exist in Svelte 5
            // Component cleanup via onDestroy() hook handles everything
          }
        };
      },
    });

    // Default layout: Graph3D (75%) + Right sidebar (25%)
    const graph3d = dockview.addPanel({
      id: 'graph3d',
      component: 'graph3d',
      title: '🌐 Graph3D',
    });

    const entities = dockview.addPanel({
      id: 'entities',
      component: 'entities',
      title: '🏢 Entities',
      position: { direction: 'right', referencePanel: 'graph3d' },
    });

    // Set initial sizes: Graph3D gets 80%, sidebar gets 20% (more focus on 3D)
    const graph3dApi = dockview.getPanel('graph3d');
    const entitiesApi = dockview.getPanel('entities');
    if (graph3dApi && entitiesApi) {
      setTimeout(() => {
        graph3dApi.api.setSize({ width: window.innerWidth * 0.80 });
      }, 100);
    }

    const depository = dockview.addPanel({
      id: 'depository',
      component: 'depository',
      title: '💰 Depository',
      position: { direction: 'below', referencePanel: 'entities' },
    });

    dockview.addPanel({
      id: 'console',
      component: 'console',
      title: '📋 Console',
      position: { direction: 'within', referencePanel: 'depository' },
    });

    dockview.addPanel({
      id: 'runtime-io',
      component: 'runtime-io',
      title: '🔄 Runtime I/O',
      position: { direction: 'within', referencePanel: 'depository' },
    });

    dockview.addPanel({
      id: 'settings',
      component: 'settings',
      title: '⚙️ Settings',
      position: { direction: 'within', referencePanel: 'depository' },
    });

    // Add Architect LAST so it becomes active by default (Dockview behavior)
    dockview.addPanel({
      id: 'architect',
      component: 'architect',
      title: '🎬 Architect',
      position: { direction: 'within', referencePanel: 'depository' },
    });

    // DISABLED: Dockview layout persistence (Svelte 5 incompatibility)
    // Issue: fromJSON() tries to destroy existing panels using $destroy()
    // which doesn't exist in Svelte 5. Need to implement custom serialization.
    // For now: Use default layout on every reload.

    // TODO: Custom layout serialization that doesn't use fromJSON/toJSON
    // Save panel IDs, positions, sizes manually and recreate on mount

    // Save layout on change (for future custom implementation)
    dockview.onDidLayoutChange(() => {
      try {
        const layout = dockview.toJSON();
        localStorage.setItem('xln-dockview-layout', JSON.stringify(layout));
        console.log('[View] Layout saved (custom restore pending)');
      } catch (err) {
        console.warn('[View] Failed to save layout:', err);
      }
    });
  });
</script>

<div class="view-wrapper">
  <div class="view-container" class:with-timemachine={!collapsed} bind:this={container}></div>

  <!-- TimeMachine - Fixed bottom bar, draggable -->
  <div class="time-machine-bar" class:collapsed data-position={timeMachinePosition}>
    <div class="drag-handle" title="Drag to reposition">⋮⋮</div>
    <TimeMachine
      history={localHistoryStore}
      timeIndex={localTimeIndex}
      isLive={localIsLive}
      env={localEnvStore}
    />
    <button class="collapse-btn" on:click={() => collapsed = !collapsed}>
      {collapsed ? '▲' : '▼'}
    </button>
  </div>

  <!-- Interactive Tutorial (first-time users) -->
  <Tutorial />
</div>

<style>
  .view-wrapper {
    width: 100%;
    height: 100vh;
    background: #1e1e1e;
    display: flex;
    flex-direction: column;
  }

  .view-container {
    flex: 1;
    width: 100%;
    min-height: 0; /* Allow flex shrink */
  }

  .view-container.with-timemachine {
    height: calc(100vh - 80px); /* Leave room for TimeMachine */
  }

  :global(.dockview-theme-dark .dockview-tab) {
    background: #2d2d30;
    color: #ccc;
  }

  :global(.dockview-theme-dark .dockview-tab.active) {
    background: #1e1e1e;
    color: #fff;
  }

  :global(.dockview-theme-dark .dockview-separator) {
    background: #007acc;
  }

  /* TimeMachine Bar */
  .time-machine-bar {
    position: relative;
    height: 80px;
    background: #252526;
    border-top: 2px solid #007acc;
    display: flex;
    align-items: center;
    padding: 0 16px;
    transition: height 0.2s ease;
    z-index: 1000;
  }

  .time-machine-bar.collapsed {
    height: 32px;
  }

  .time-machine-bar[data-position="top"] {
    order: -1;
    border-top: none;
    border-bottom: 2px solid #007acc;
  }

  .drag-handle {
    position: absolute;
    left: 8px;
    top: 50%;
    transform: translateY(-50%);
    cursor: move;
    color: #6e7681;
    font-size: 18px;
    user-select: none;
    padding: 4px 8px;
  }

  .drag-handle:hover {
    color: #007acc;
  }

  .collapse-btn {
    position: absolute;
    right: 8px;
    top: 50%;
    transform: translateY(-50%);
    background: #2d2d30;
    border: 1px solid #3e3e3e;
    color: #ccc;
    padding: 4px 12px;
    cursor: pointer;
    border-radius: 4px;
    font-size: 12px;
  }

  .collapse-btn:hover {
    background: #37373d;
    border-color: #007acc;
  }
</style>
