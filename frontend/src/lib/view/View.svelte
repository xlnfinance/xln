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
  import ArchitectPanel from './panels/ArchitectPanel.svelte';
  import ConsolePanel from './panels/ConsolePanel.svelte';
  import RuntimeIOPanel from './panels/RuntimeIOPanel.svelte';
  import SettingsPanel from './panels/SettingsPanel.svelte';
  import InsurancePanel from './panels/InsurancePanel.svelte';
  import JurisdictionPanel from './panels/JurisdictionPanel.svelte';
  import SolvencyPanel from './panels/SolvencyPanel.svelte';
  import BrainVaultView from '$lib/components/Views/BrainVaultView.svelte';
  // REMOVED PANELS:
  // - EntitiesPanel: Graph3D entity cards provide better UX
  // - DepositoryPanel: JurisdictionPanel shows same data with better tables
  // - ConsolePanel: Now embedded in SettingsPanel as tab
  import EntityPanelWrapper from './panels/wrappers/EntityPanelWrapper.svelte';
  import TimeMachine from './core/TimeMachine.svelte';
  import Tutorial from './components/Tutorial.svelte';
  import { panelBridge } from './utils/panelBridge';
  import 'dockview/dist/styles/dockview.css';

  // Props for layout/mode switching
  export let layout: string = 'default'; void layout;
  export let networkMode: 'simnet' | 'testnet' | 'mainnet' = 'simnet'; void networkMode;
  export let embedMode: boolean = false; // When true: hide panels, show only 3D + minimal controls
  export let scenarioId: string = ''; // Auto-run scenario on load (e.g. 'ahb', 'fed-chair')
  export let userMode: boolean = false; // When true: simple BrainVault UX (no graph, no time machine)

  let container: HTMLDivElement;
  let dockview: DockviewComponent;
  let unsubOpenEntity: (() => void) | null = null;

  // Track mode changes to rebuild layout
  let currentMode = userMode;

  // Reactive: Rebuild panels when userMode changes
  $: if (dockview && currentMode !== userMode) {
    console.log(`[View] 🔄 Mode changed: ${currentMode ? 'user' : 'dev'} → ${userMode ? 'user' : 'dev'}`);
    currentMode = userMode;
    rebuildPanels();
  }

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

  // Expose env to window for E2E testing (Playwright tests need access to history)
  localEnvStore.subscribe((env) => {
    if (typeof window !== 'undefined' && env) {
      (window as any).isolatedEnv = env;
    }
  });

  // Pending entity data - bypasses Dockview params timing
  const pendingEntityData = new Map<string, {entityId: string, entityName: string, signerId: string}>();

  // Build version tracking (injected by vite.config.ts)
  // @ts-ignore - __BUILD_HASH__ and __BUILD_TIME__ are injected by vite define
  const BUILD_HASH: string = typeof globalThis.__BUILD_HASH__ !== 'undefined' ? globalThis.__BUILD_HASH__ : (typeof __BUILD_HASH__ !== 'undefined' ? __BUILD_HASH__ : 'dev');
  // @ts-ignore
  const BUILD_TIME: string = typeof globalThis.__BUILD_TIME__ !== 'undefined' ? globalThis.__BUILD_TIME__ : (typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : 'unknown');

  console.log('[View.svelte] 🎬 MODULE LOADED - scenarioId prop:', scenarioId);

  onMount(async () => {
    console.log('[View] ============ onMount ENTRY ============');
    console.log('[View] scenarioId:', scenarioId);
    console.log('[View] embedMode:', embedMode);

    // Version check - ALWAYS log build hash for stale detection
    console.log(`%c[XLN View] Build: ${BUILD_HASH} @ ${BUILD_TIME}`, 'color: #00ff88; font-weight: bold; font-size: 14px;');
    console.log('[View] onMount started - initializing isolated XLN');
    console.log('[View] 🎬 scenarioId prop:', scenarioId || '(empty)');

    // Initialize isolated XLN runtime (runtime handles BrowserVM internally)
    try {
      // Load XLN runtime - it includes BrowserEVM
      const runtimeUrl = new URL('/runtime.js', window.location.origin).href;
      const XLN = await import(/* @vite-ignore */ runtimeUrl);

      // Create BrowserVM from runtime (not frontend)
      const { BrowserEVM } = XLN;
      const browserVM = new BrowserEVM();
      await browserVM.init();
      console.log('[View] BrowserVM initialized from runtime');

      const depositoryAddress = browserVM.getDepositoryAddress();

      // Register with runtime
      XLN.setBrowserVMJurisdiction(depositoryAddress, browserVM);

      // Expose for panels that need direct access (time-travel, insurance queries)
      (window as any).__xlnBrowserVM = browserVM;

      console.log('[View] ✅ BrowserVM ready:', depositoryAddress);

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

      // Auto-run scenario if scenarioId is explicitly provided (no default for /app route)
      if (scenarioId) {
        console.log(`[View] 🎬 Autoplay: Running scenario "${scenarioId}"...`);

        // Supported scenarios (others show error)
        const supportedScenarios = ['ahb'];

        if (!supportedScenarios.includes(scenarioId)) {
          console.error(`[View] ❌ SCENARIO NOT IMPLEMENTED: "${scenarioId}"`);
          console.error(`[View] 📋 Available scenarios: ${supportedScenarios.join(', ')}`);
          console.error(`[View] 💡 To add "${scenarioId}", implement it in View.svelte autoplay section`);
        }

        if (scenarioId === 'ahb') {
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
            await new Promise(resolve => setTimeout(resolve, 500)); // Give panels time to mount (increased from 100ms)
            console.log('[View] Graph3D mount delay complete (500ms)');

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

            // CRITICAL: Manually trigger Graph3D render after scenario loads
            // Store subscriptions may not fire if Graph3D already mounted
            panelBridge.emit('scenario:loaded', { name: 'ahb', frames: frames.length });

            console.log(`[View] ✅ AHB scenario loaded successfully!`);
            console.log(`[View]    Frames: ${frames.length}`);
            console.log(`[View]    Entities: ${env.eReplicas?.size || 0}`);

            // Autoplay: Wait 200ms then press Play with loop
            setTimeout(() => {
              console.log('[View] 🎬 Starting autoplay...');
              panelBridge.emit('timeMachine:play', { loop: true });
            }, 200);
          } catch (autoplayErr) {
            console.error('[View] ❌ AHB AUTOPLAY FAILED:', autoplayErr);
            console.error('[View] Stack:', (autoplayErr as Error).stack);
            // CRITICAL: Still show frames created before error
            const frames = env.history || [];
            if (frames.length > 0) {
              console.log('[View] Error but have', frames.length, 'frames - showing them');
              localIsLive.set(false);
              localTimeIndex.set(Math.max(0, frames.length - 1));
              localHistoryStore.set(frames);
              localEnvStore.set(env);
            }
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
        } else if (options.name === 'brainvault') {
          component = mount(BrainVaultView, {
            target: div,
            props: {}  // BrainVault manages its own state
          });
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
              isolatedEnv: localEnvStore,
              isolatedHistory: localHistoryStore,
              isolatedTimeIndex: localTimeIndex
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
          // ENTITY PANEL: Don't mount here - wait for init() to get panel ID
          // Component will be mounted in init() callback with data from Map
        }

        // Return Dockview-compatible API
        return {
          element: div,
          init: (parameters: any) => {
            // ENTITY PANEL: Mount in init() with data from Map
            if (options.name === 'entity-panel') {
              const panelId = parameters.api.id;
              const data = pendingEntityData.get(panelId);

              if (!data) {
                console.error('[View] ❌ No pending data for:', panelId);
                return;
              }

              pendingEntityData.delete(panelId);
              console.log('[View] ✅ Mounting with data:', data);

              component = mount(EntityPanelWrapper, {
                target: div,
                props: {
                  entityId: data.entityId,
                  entityName: data.entityName,
                  signerId: data.signerId,
                  isolatedEnv: localEnvStore,
                  isolatedHistory: localHistoryStore,
                  isolatedTimeIndex: localTimeIndex,
                  isolatedIsLive: localIsLive
                }
              });
            }
          },
          dispose: () => {
            // Svelte 5: unmount() happens automatically when DOM removed
            // No need to call $destroy() - it doesn't exist in Svelte 5
            // Component cleanup via onDestroy() hook handles everything
          }
        };
      },
    });

    // Expose dockview to window for Settings panel access
    if (typeof window !== 'undefined') {
      (window as any).__dockview_instance = dockview;
    }

    // Try to restore saved layout from localStorage
    const savedLayout = localStorage.getItem('xln-workspace-layout');
    let shouldRestoreLayout = false;
    if (savedLayout) {
      try {
        const config = JSON.parse(savedLayout);
        if (config.dockview) {
          console.log('[View] Found saved layout, will restore after creating panels');
          shouldRestoreLayout = true;
        }
      } catch (err) {
        console.warn('[View] Invalid saved layout, using defaults');
        localStorage.removeItem('xln-workspace-layout');
      }
    }

    // User mode: Simple BrainVault UX (no graph, no dev panels)
    // Dev mode: Full IDE with graph + all panels

    if (userMode) {
      // User mode: Only BrainVault panel
      dockview.addPanel({
        id: 'brainvault',
        component: 'brainvault',
        title: '🔐 Wallet',
        params: {
          closeable: false,
        },
      });
    } else {
      // Dev mode: Full layout
      const graph3d = dockview.addPanel({
        id: 'graph3d',
        component: 'graph3d',
        title: '🌐 Graph3D',
        params: {
          closeable: false,
        },
      });

      const architect = dockview.addPanel({
        id: 'architect',
        component: 'architect',
        title: '🎬 Architect',
        position: { direction: 'right', referencePanel: 'graph3d' },
        params: {
          closeable: false,
        },
      });

      // ALL panels after Architect get inactive:true to prevent stealing focus

      dockview.addPanel({
        id: 'jurisdiction',
        component: 'jurisdiction',
        title: '🏛️ Jurisdiction',
        position: { direction: 'within', referencePanel: 'architect' },
        inactive: true,
        params: {
          closeable: false, // Core panel - cannot close
        },
      });

      dockview.addPanel({
        id: 'runtime-io',
        component: 'runtime-io',
        title: '🔄 Runtime I/O',
        position: { direction: 'within', referencePanel: 'architect' },
        inactive: true,
        params: {
          closeable: false, // Core panel - cannot close
        },
      });

      dockview.addPanel({
        id: 'settings',
        component: 'settings',
        title: '⚙️ Settings',
        position: { direction: 'within', referencePanel: 'architect' },
        inactive: true,
        params: {
          closeable: false, // Core panel - cannot close
        },
      });
    }

    // REMOVED PANELS (merged elsewhere):
    // - Insurance: now in EntityPanel after Reserves
    // - Solvency: now in RuntimeIOPanel as first section

    // Restore saved layout if available
    if (shouldRestoreLayout && savedLayout) {
      setTimeout(() => {
        try {
          const config = JSON.parse(savedLayout);
          if (config.dockview) {
            dockview.fromJSON(config.dockview);
            console.log('[View] ✅ Layout restored from localStorage');
          }
        } catch (err) {
          console.warn('[View] Failed to restore layout:', err);
        }
      }, 100);
    } else {
      // Architect should already be active (it was created first in the group)
      setTimeout(() => {
        const architectPanel = dockview.getPanel('architect');
        if (architectPanel) {
          architectPanel.api.setActive();
          console.log('[View] ✅ Architect panel set as active tab');
        }
      }, 0);
    }

    // Set initial sizes (Graph3D panel)
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

    // Auto-save layout on ANY change (debounced)
    let saveLayoutTimer: ReturnType<typeof setTimeout> | null = null;
    dockview.onDidLayoutChange(() => {
      if (saveLayoutTimer) clearTimeout(saveLayoutTimer);
      saveLayoutTimer = setTimeout(() => {
        try {
          const config = {
            version: '1.0.0',
            timestamp: new Date().toISOString(),
            dockview: dockview.toJSON(),
          };
          localStorage.setItem('xln-workspace-layout', JSON.stringify(config));
          console.log('[View] ✅ Layout auto-saved');
        } catch (err) {
          console.warn('[View] Failed to auto-save layout:', err);
        }
      }, 500); // Debounce 500ms
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

      // STORE entity data BEFORE creating panel (bypasses Dockview params race)
      pendingEntityData.set(panelId, {
        entityId,
        entityName: entityName || entityId.slice(0, 10),
        signerId: signerId || entityId
      });

      // Create new panel using EntityPanelWrapper (reuses full EntityPanel)
      try {
        console.log('[View] 📋 Stored entity data + creating panel:', panelId.slice(0, 20));

        dockview.addPanel({
          id: panelId,
          component: 'entity-panel',
          title: `🏢 ${entityName || entityId.slice(0, 10) + '...'}`,
          position: { direction: 'within', referencePanel: 'architect' },
          params: {
            closeable: true, // Entity panels ARE closeable (dynamic)
          },
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

  // Function to rebuild panels when mode toggles
  function rebuildPanels() {
    if (!dockview) return;

    console.log(`[View] 🔄 Rebuilding for ${userMode ? 'user' : 'dev'} mode...`);

    // Clear all panels
    const panels = [...dockview.panels];
    for (const panel of panels) {
      dockview.removePanel(panel);
    }

    // Recreate panels based on mode
    if (userMode) {
      // User mode: Only BrainVault
      dockview.addPanel({
        id: 'brainvault',
        component: 'brainvault',
        title: '🔐 Wallet',
        params: { closeable: false },
      });
      console.log('[View] ✅ User mode layout');
    } else {
      // Dev mode: Full IDE
      const graph3d = dockview.addPanel({
        id: 'graph3d',
        component: 'graph3d',
        title: '🌐 Graph3D',
        params: { closeable: false },
      });

      const architect = dockview.addPanel({
        id: 'architect',
        component: 'architect',
        title: '🎬 Architect',
        position: { direction: 'right', referencePanel: 'graph3d' },
        params: { closeable: false },
      });

      dockview.addPanel({
        id: 'jurisdiction',
        component: 'jurisdiction',
        title: '🏛️ Jurisdiction',
        position: { direction: 'within', referencePanel: 'architect' },
        inactive: true,
        params: { closeable: false },
      });

      dockview.addPanel({
        id: 'runtime-io',
        component: 'runtime-io',
        title: '🔄 Runtime I/O',
        position: { direction: 'within', referencePanel: 'architect' },
        inactive: true,
        params: { closeable: false },
      });

      dockview.addPanel({
        id: 'settings',
        component: 'settings',
        title: '⚙️ Settings',
        position: { direction: 'within', referencePanel: 'architect' },
        inactive: true,
        params: { closeable: false },
      });

      setTimeout(() => graph3d.api.setSize({ width: window.innerWidth * 0.70 }), 100);
      console.log('[View] ✅ Dev mode layout');
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

  <!-- TimeMachine - Visible in dev mode only (user mode = simple, no time travel) -->
  {#if !userMode}
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
  {/if}

  {#if !embedMode && !userMode}
    <!-- Interactive Tutorial (first-time users, dev mode only) -->
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
    height: calc(100vh - 56px); /* Account for topbar (56px) */
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
    height: calc(100vh - 56px - 48px); /* Topbar (56px) + TimeMachine (48px) */
  }

  /* Embed mode - no topbar, just TimeMachine */
  .view-wrapper.embed-mode {
    height: 100vh;
  }

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

  /* TimeMachine Bar - always visible at bottom like YouTube progress bar */
  .time-machine-bar {
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    height: 48px;
    z-index: 1000;
    background: rgba(30, 30, 30, 0.95);
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
