<script lang="ts">
  /**
   * View - Main embeddable workspace
   * Single source for XLN dashboard (4 panels: Graph3D, Entities, Depository, Architect)
   *
   * @license AGPL-3.0
   * Copyright (C) 2025 XLN Finance
   */

  import { onMount, onDestroy, mount } from 'svelte';
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
  import InsurancePanel from './panels/InsurancePanel.svelte';
  import JurisdictionPanel from './panels/JurisdictionPanel.svelte';
  import SolvencyPanel from './panels/SolvencyPanel.svelte';
  import EntityPanelWrapper from './panels/wrappers/EntityPanelWrapper.svelte';
  import TimeMachine from './core/TimeMachine.svelte';
  import Tutorial from './components/Tutorial.svelte';
  import { panelBridge } from './utils/panelBridge';
  import 'dockview/dist/styles/dockview.css';

  // Props for future layout/mode switching (passed from parent, reserved for future use)
  export let layout: string = 'default'; void layout;
  export let networkMode: 'simnet' | 'testnet' | 'mainnet' = 'simnet'; void networkMode;
  export let embedMode: boolean = false; // When true: hide panels, show only 3D + minimal controls
  export let scenarioId: string = ''; // Auto-run scenario on load (e.g. 'ahb', 'fed-chair')

  let container: HTMLDivElement;
  let dockview: DockviewComponent;
  let unsubOpenEntity: (() => void) | null = null;

  // TimeMachine draggable state
  let timeMachinePosition: 'bottom' | 'top' | 'left' | 'right' = 'bottom';
  let collapsed = false;

  // Embed mode: hide sidebar by default, show on toggle
  let showSidebarInEmbed = false;

  // Isolated XLN environment for this View instance (passed to ALL panels + TimeMachine)
  const localEnvStore = writable<any>(null);
  const localHistoryStore = writable<any[]>([]);
  const localTimeIndex = writable<number>(-1);  // -1 = live mode
  const localIsLive = writable<boolean>(true);

  // Build version tracking (injected by vite.config.ts)
  // @ts-ignore - __BUILD_HASH__ and __BUILD_TIME__ are injected by vite define
  const BUILD_HASH: string = typeof globalThis.__BUILD_HASH__ !== 'undefined' ? globalThis.__BUILD_HASH__ : (typeof __BUILD_HASH__ !== 'undefined' ? __BUILD_HASH__ : 'dev');
  // @ts-ignore
  const BUILD_TIME: string = typeof globalThis.__BUILD_TIME__ !== 'undefined' ? globalThis.__BUILD_TIME__ : (typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : 'unknown');

  onMount(async () => {
    // Version check - ALWAYS log build hash for stale detection
    console.log(`%c[XLN View] Build: ${BUILD_HASH} @ ${BUILD_TIME}`, 'color: #00ff88; font-weight: bold; font-size: 14px;');
    console.log('[View] onMount started - initializing isolated XLN');
    console.log('[View] 🎬 scenarioId prop:', scenarioId || '(empty)');

    // Initialize isolated XLN runtime (simnet - BrowserVM mode)
    try {
      // Step 1: Initialize BrowserVM (deploy Depository in-browser)
      const { browserVMProvider } = await import('./utils/browserVMProvider');

      // Reset BrowserVM to ensure fresh state (prevents stale reserves from previous runs)
      // This is critical for scenario re-runs and HMR during development
      await browserVMProvider.reset();
      console.log('[View] BrowserVM reset to fresh state');

      const depositoryAddress = browserVMProvider.getDepositoryAddress();

      console.log('[View] BrowserVM ready:', { depositoryAddress });

      // Step 2: Load XLN runtime
      const runtimeUrl = new URL('/runtime.js', window.location.origin).href;
      const XLN = await import(/* @vite-ignore */ runtimeUrl);

      // Step 3: Register BrowserVM jurisdiction (overrides DEFAULT_JURISDICTIONS)
      XLN.setBrowserVMJurisdiction(depositoryAddress, browserVMProvider);
      console.log('[View] ✅ BrowserVM jurisdiction registered with browserVM instance');

      // Expose browserVM on window for JurisdictionPanel to access
      (window as any).__xlnBrowserVM = browserVMProvider;

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

        // Restore jurisdictions
        env.jReplicas = urlImport.state.x;
        env.activeJurisdiction = urlImport.state.a;

        // Restore entities (replicas)
        env.eReplicas = urlImport.state.e;

        // Restore UI settings if included
        if (urlImport.includeUI && urlImport.state.ui) {
          // Settings will be loaded by SettingsPanel from its own localStorage
          // Just log that UI was included
          console.log('[View] 📋 URL included UI settings');
        }

        console.log('[View] ✅ Imported:', {
          jReplicas: env.jReplicas.size,
          entities: env.eReplicas.size,
          active: env.activeJurisdiction
        });
      } else {
        // No URL import: Create empty environment
        env = XLN.createEmptyEnv();

        // Initialize with empty frame 0
        env.history = [{
          height: 0,
          timestamp: Date.now(),
          eReplicas: new Map(),
          runtimeInput: { runtimeTxs: [], entityInputs: [] },
          runtimeOutputs: [],
          description: 'Frame 0: Empty slate',
          title: 'Initial State'
        }];

        console.log('[View] ✅ Empty environment ready (frame 0)');
        console.log('[View] 💡 Use Architect panel to create jurisdictions + entities');
      }

      // Set to isolated stores
      localEnvStore.set(env);
      localHistoryStore.set(env.history || []);
      // CRITICAL: Default to -1 (LIVE mode), not 0 (historical frame 0)
      // Only use saved timeIndex when explicitly importing from URL
      localTimeIndex.set(urlImport?.state.ui?.ti ?? -1);
      localIsLive.set(true);

      // Auto-run scenario if scenarioId is provided (or default to AHB for testing)
      const effectiveScenarioId = scenarioId || 'ahb'; // Default to AHB for /view route
      if (effectiveScenarioId) {
        console.log(`[View] 🎬 Autoplay: Running scenario "${effectiveScenarioId}"${scenarioId ? '' : ' (default)'}...`);

        // Supported scenarios (others show error)
        const supportedScenarios = ['ahb'];

        if (!supportedScenarios.includes(effectiveScenarioId)) {
          console.error(`[View] ❌ SCENARIO NOT IMPLEMENTED: "${effectiveScenarioId}"`);
          console.error(`[View] 📋 Available scenarios: ${supportedScenarios.join(', ')}`);
          console.error(`[View] 💡 To add "${effectiveScenarioId}", implement it in View.svelte autoplay section`);
        }

        if (effectiveScenarioId === 'ahb') {
          try {
            // CRITICAL: Clear old state BEFORE running (Architect panel pattern)
            console.log('[View] BEFORE clear: eReplicas =', env.eReplicas?.size || 0);
            if (env.eReplicas) env.eReplicas.clear();
            env.history = [];
            console.log('[View] AFTER clear: eReplicas =', env.eReplicas?.size || 0);

            console.log(`[View] 📦 Calling XLN.prepopulateAHB...`);
            await XLN.prepopulateAHB(env);
            console.log(`[View] 📦 prepopulateAHB completed, history: ${env.history?.length || 0} frames`);

            // Update stores AFTER prepopulate completes (EXACT Architect panel pattern)
            const frames = env.history || [];
            console.log('[View] Setting stores with frames:', frames.length);

            // CRITICAL: Wait for Graph3DPanel to mount before updating stores
            // Fix race condition: on first load, Graph3D subscriptions not yet set up
            await new Promise(resolve => setTimeout(resolve, 100)); // Give panels time to mount
            console.log('[View] Graph3D mount delay complete');

            // CRITICAL: Set in EXACT order from ArchitectPanel lines 348-353
            // 1. Exit live mode FIRST
            localIsLive.set(false);
            // 2. Set timeIndex to LAST frame
            localTimeIndex.set(Math.max(0, frames.length - 1));
            // 3. Set history (triggers Graph3D subscription)
            localHistoryStore.set(frames);
            // 4. Set env (triggers final update)
            localEnvStore.set(env);

            console.log('[View] ✅ Stores updated, Graph3D should re-render');

            console.log(`[View] ✅ AHB scenario loaded successfully!`);
            console.log(`[View]    Frames: ${frames.length}`);
            console.log(`[View]    Entities: ${env.eReplicas?.size || 0}`);
          } catch (autoplayErr) {
            console.error('[View] ❌ AHB AUTOPLAY FAILED:', autoplayErr);
            console.error('[View] Stack:', (autoplayErr as Error).stack);
            // Error logged to console F12
          }
        }
      }

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
              isolatedTimeIndex: localTimeIndex,
              isolatedIsLive: localIsLive
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
        } else if (options.name === 'insurance') {
          component = mount(InsurancePanel, {
            target: div,
            props: {
              isolatedEnv: localEnvStore,
              isolatedHistory: localHistoryStore,
              isolatedTimeIndex: localTimeIndex
            }
          });
        } else if (options.name === 'solvency') {
          component = mount(SolvencyPanel, {
            target: div,
            props: {}
          });
        } else if (options.name === 'jurisdiction') {
          component = mount(JurisdictionPanel, {
            target: div,
            props: {
              isolatedEnv: localEnvStore,
              isolatedHistory: localHistoryStore,
              isolatedTimeIndex: localTimeIndex
            }
          });
        } else if (options.name === 'entity-panel') {
          // Dynamic panel for entity operations (opened via panelBridge)
          // Uses EntityPanelWrapper - thin Dockview adapter for legacy EntityPanel
          // @ts-ignore - Dockview params passed via addPanel
          console.log('[View] 🔍 FULL options object:', JSON.stringify(options, null, 2));
          const params = (options as any).params || {};
          console.log('[View] 🔍 Extracted params:', params);
          console.log('[View] 🔍 entityId:', params.entityId, 'signerId:', params.signerId);
          component = mount(EntityPanelWrapper, {
            target: div,
            props: {
              entityId: String(params.entityId || ''),
              entityName: String(params.entityName || ''),
              signerId: String(params.signerId || params.entityId || ''),
              isolatedEnv: localEnvStore,
              isolatedHistory: localHistoryStore,
              isolatedTimeIndex: localTimeIndex,
              isolatedIsLive: localIsLive
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

    // Clear any saved layout to ensure fresh default layout
    localStorage.removeItem('xln-dockview-layout');

    // Default layout: Graph3D (2/3) + Right sidebar (1/3) with ALL panels stacked
    // Dockview: 'within' adds tabs to the END of the group - so add in desired order
    // Final desired tab order: Architect | Entities | Console | Depository | Runtime I/O | Settings | Insurance
    const graph3d = dockview.addPanel({
      id: 'graph3d',
      component: 'graph3d',
      title: '🌐 Graph3D',
    });

    // Architect FIRST (leftmost tab) - create the right panel group
    const architect = dockview.addPanel({
      id: 'architect',
      component: 'architect',
      title: '🎬 Architect',
      position: { direction: 'right', referencePanel: 'graph3d' },
    });

    // Add remaining panels in order (they append to the tab group)
    // ALL panels after Architect get inactive:true to prevent stealing focus
    dockview.addPanel({
      id: 'entities',
      component: 'entities',
      title: '🏢 Entities',
      position: { direction: 'within', referencePanel: 'architect' },
      inactive: true,
    });

    dockview.addPanel({
      id: 'console',
      component: 'console',
      title: '📋 Console',
      position: { direction: 'within', referencePanel: 'architect' },
      inactive: true,
    });

    dockview.addPanel({
      id: 'depository',
      component: 'depository',
      title: '💰 Depository',
      position: { direction: 'within', referencePanel: 'architect' },
      inactive: true,
    });

    dockview.addPanel({
      id: 'jurisdiction',
      component: 'jurisdiction',
      title: '🏛️ Jurisdiction',
      position: { direction: 'within', referencePanel: 'architect' },
      inactive: true,
    });

    dockview.addPanel({
      id: 'runtime-io',
      component: 'runtime-io',
      title: '🔄 Runtime I/O',
      position: { direction: 'within', referencePanel: 'architect' },
      inactive: true,
    });

    dockview.addPanel({
      id: 'settings',
      component: 'settings',
      title: '⚙️ Settings',
      position: { direction: 'within', referencePanel: 'architect' },
      inactive: true,
    });

    dockview.addPanel({
      id: 'insurance',
      component: 'insurance',
      title: '🛡️ Insurance',
      position: { direction: 'within', referencePanel: 'architect' },
      inactive: true,
    });

    // Architect should already be active (it was created first in the group)
    // But ensure it with a setTimeout as final guarantee
    setTimeout(() => {
      const architectPanel = dockview.getPanel('architect');
      if (architectPanel) {
        architectPanel.api.setActive();
        console.log('[View] ✅ Architect panel set as active tab');
      }
    }, 0);

    // Set initial sizes based on mode
    const graph3dApi = dockview.getPanel('graph3d');
    if (graph3dApi) {
      // Delay size adjustment for AVP compatibility
      setTimeout(() => {
        // In embed mode: start fullscreen (100%), user can toggle sidebar
        // In normal mode: 70:30 split
        const widthPercent = embedMode ? 1.0 : 0.70;
        graph3dApi.api.setSize({ width: window.innerWidth * widthPercent });
        console.log(`[View] ✅ Graph3D resized to ${widthPercent * 100}%${embedMode ? ' (embed mode)' : ''}`);
      }, 100);
    }

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

    // Listen for entity panel requests from Graph3D (click on entity node)
    unsubOpenEntity = panelBridge.on('openEntityOperations', ({ entityId, entityName, signerId }) => {
      // Use full entityId to avoid collisions
      const panelId = `entity-${entityId}`;

      // Check ALL panels to find existing one
      const allPanels = dockview.panels;
      const existingPanel = allPanels.find(p => p.id === panelId);

      if (existingPanel) {
        console.log('[View] Focusing existing entity panel:', entityId.slice(0, 10));
        existingPanel.api.setActive();
        return;
      }

      // Create new panel using EntityPanelWrapper (reuses full EntityPanel)
      try {
        console.log('[View] 📋 Creating entity panel:', { id: panelId, entityId: entityId.slice(0, 10), entityName, signerId });

        dockview.addPanel({
          id: panelId,
          component: 'entity-panel',
          title: `🏢 ${entityName || entityId.slice(0, 10) + '...'}`,
          position: { direction: 'within', referencePanel: 'architect' },
          params: { entityId, entityName, signerId }
        });
        console.log('[View] ✅ Entity panel created:', entityId.slice(0, 10));
      } catch (err) {
        // Panel might already exist from race condition - force focus
        console.error('[View] ❌ Panel creation failed:', err);
        const retryPanel = dockview.panels.find(p => p.id === panelId);
        if (retryPanel) {
          console.log('[View] Retry: focusing existing panel');
          retryPanel.api.setActive();
        } else {
          console.error('[View] Panel not found even after error - this should not happen');
        }
      }
    });

    // Listen for J-Machine click to open Jurisdiction panel
    panelBridge.on('openJurisdiction', ({ jurisdictionName }) => {
      const jurisdictionPanel = dockview.getPanel('jurisdiction');
      if (jurisdictionPanel) {
        jurisdictionPanel.api.setActive();
        console.log('[View] Focused Jurisdiction panel for:', jurisdictionName);
      }
    });

    // Listen for focus panel requests (from TimeMachine settings button)
    panelBridge.on('focusPanel', ({ panelId }) => {
      const panel = dockview.getPanel(panelId);
      if (panel) {
        panel.api.setActive();
        console.log('[View] Focused panel:', panelId);
      }
    });
  });

  // Cleanup on component destroy
  // Toggle sidebar visibility in embed mode
  function toggleEmbedSidebar() {
    showSidebarInEmbed = !showSidebarInEmbed;
    const graph3dApi = dockview?.getPanel('graph3d');
    if (graph3dApi) {
      const widthPercent = showSidebarInEmbed ? 0.70 : 1.0;
      graph3dApi.api.setSize({ width: window.innerWidth * widthPercent });
      console.log(`[View] Embed sidebar ${showSidebarInEmbed ? 'shown' : 'hidden'}`);
    }
  }

  onDestroy(() => {
    if (unsubOpenEntity) {
      unsubOpenEntity();
    }
    if (dockview) {
      dockview.dispose();
    }
  });
</script>

<div class="view-wrapper" class:embed-mode={embedMode}>
  <div class="view-container" class:with-timemachine={!collapsed} bind:this={container}></div>

  <!-- TimeMachine - Always visible (like YouTube progress bar) -->
  <div class="time-machine-bar" class:collapsed class:embed={embedMode} data-position={timeMachinePosition}>
    {#if !embedMode}
      <div class="drag-handle" title="Drag to reposition">⋮⋮</div>
    {/if}
    <TimeMachine
      history={localHistoryStore}
      timeIndex={localTimeIndex}
      isLive={localIsLive}
      env={localEnvStore}
    />
    {#if !embedMode}
      <button class="collapse-btn" on:click={() => collapsed = !collapsed}>
        {collapsed ? '▲' : '▼'}
      </button>
      <button
        class="position-toggle-btn"
        on:click={() => timeMachinePosition = timeMachinePosition === 'bottom' ? 'top' : 'bottom'}
        title="Move to {timeMachinePosition === 'bottom' ? 'top' : 'bottom'}"
      >
        {timeMachinePosition === 'bottom' ? '⬆️' : '⬇️'}
      </button>
    {/if}
  </div>

  {#if !embedMode}
    <!-- Interactive Tutorial (first-time users) -->
    <Tutorial />
  {/if}

  {#if embedMode}
    <!-- Embed mode: Toggle button for sidebar -->
    <button
      class="embed-sidebar-toggle"
      class:sidebar-visible={showSidebarInEmbed}
      on:click={toggleEmbedSidebar}
      title={showSidebarInEmbed ? 'Hide panels' : 'Show panels'}
    >
      {showSidebarInEmbed ? '»' : '«'}
    </button>
  {/if}
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
    height: calc(100vh - 48px); /* Leave room for compact TimeMachine */
  }

  /* Embed mode - full screen with TimeMachine, hide dockview tabs */
  .view-wrapper.embed-mode .view-container {
    height: calc(100vh - 48px);
  }

  .view-wrapper.embed-mode :global(.dockview-tabs-container),
  .view-wrapper.embed-mode :global(.dockview-groupcontrol) {
    display: none !important;
  }

  .time-machine-bar.embed {
    height: 48px;
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

  /* TimeMachine Bar - minimal wrapper */
  .time-machine-bar {
    position: relative;
    height: 48px;
    z-index: 1000;
  }

  .time-machine-bar.collapsed {
    height: 24px;
  }

  .time-machine-bar[data-position="top"] {
    order: -1;
  }

  .drag-handle {
    display: none; /* Hidden in compact mode */
  }

  .collapse-btn,
  .position-toggle-btn {
    display: none; /* Hidden in compact mode */
  }

  /* Embed mode sidebar toggle button */
  .embed-sidebar-toggle {
    position: fixed;
    top: 50%;
    right: 8px;
    transform: translateY(-50%);
    z-index: 200;
    width: 28px;
    height: 48px;
    background: rgba(0, 0, 0, 0.7);
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 4px;
    color: rgba(255, 255, 255, 0.7);
    cursor: pointer;
    font-size: 14px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s ease;
    backdrop-filter: blur(8px);
  }

  .embed-sidebar-toggle:hover {
    background: rgba(0, 122, 255, 0.3);
    border-color: rgba(0, 122, 255, 0.5);
    color: white;
  }

  .embed-sidebar-toggle.sidebar-visible {
    right: calc(30% + 8px);
  }
</style>
