<script lang="ts">
  /**
   * View - Main embeddable workspace
   * Single source for XLN dashboard (4 panels: Graph3D, Entities, Depository, Architect)
   *
   * @license AGPL-3.0
   * Copyright (C) 2025 XLN Finance
   */

  import { onMount, onDestroy, mount } from 'svelte';
  import { writable, get } from 'svelte/store';
  import { toasts } from '$lib/stores/toastStore';
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
  import GossipPanel from './panels/GossipPanel.svelte';
  import RuntimeCreation from '$lib/components/Views/RuntimeCreation.svelte';
  import UserModePanel from './UserModePanel.svelte';
  // REMOVED PANELS:
  // - EntitiesPanel: Graph3D entity cards provide better UX
  // - DepositoryPanel: JurisdictionPanel shows same data with better tables
  // - ConsolePanel: Now embedded in SettingsPanel as tab
  import EntityPanelWrapper from './panels/wrappers/EntityPanelWrapper.svelte';
  import TimeMachine from './core/TimeMachine.svelte';
  import Tutorial from './components/Tutorial.svelte';
  import { panelBridge } from './utils/panelBridge';
  import { runtimeOperations } from '$lib/stores/runtimeStore';
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
  let unsubOpenJurisdiction: (() => void) | null = null;
  let unsubFocusPanel: (() => void) | null = null;
  let activePanelDisposable: { dispose: () => void } | null = null;
  let saveLayoutTimer: ReturnType<typeof setTimeout> | null = null;

  // Track mode changes to update panel visibility
  let currentMode = userMode;

  // Reactive: Update panel visibility when userMode changes (preserve layout)
  $: if (dockview && currentMode !== userMode) {
    console.log(`[View] 🔄 Mode changed: ${currentMode ? 'user' : 'dev'} → ${userMode ? 'user' : 'dev'}`);
    currentMode = userMode;
    updatePanelsForMode(userMode);
  }

  // TimeMachine draggable state
  let timeMachinePosition: 'bottom' | 'top' | 'left' | 'right' = 'bottom';
  let collapsed = false;

  // Embed mode: hide sidebar by default, show on toggle
  let showSidebarInEmbed = false;

  // Isolated XLN environment for this View instance (passed to ALL panels + TimeMachine)
  const localEnvStore = writable<any>(null);
  const localHistoryStore = writable<any[]>([]);
  const localTimeIndex = writable<number>(0);  // real frame index, auto-advanced when isLive
  const localIsLive = writable<boolean>(true);
  const graphInitSignal = writable<boolean>(embedMode);

  // Sync localEnvStore → runtimeStore for panels that read from global
  const unsubLocalEnvSync = localEnvStore.subscribe((env) => {
    if (env) {
      runtimeOperations.updateLocalEnv(env);
    }
  });

  const LOG_TOAST_COOLDOWN_MS = 12000;
  const lastSeenFrameLogIdByRuntime = new Map<string, number>();
  const lastToastAtByKey = new Map<string, number>();

  const shouldSurfaceLogAsToast = (entry: any): boolean => {
    const level = String(entry?.level || '').toLowerCase();
    const message = String(entry?.message || '').toLowerCase();
    if (level === 'error') return true;
    const criticalTokens = [
      'ws_client_error',
      'ws_connect_failed',
      'ws_disconnected',
      'decrypt_fail',
      'frame_consensus_failed',
      'p2p_unencrypted',
      'jsonrpcprovider failed to detect network',
      'testnet j-machine not found',
      'route-defer',
    ];
    return criticalTokens.some((token) => message.includes(token));
  };

  const unsubRuntimeErrorToasts = localEnvStore.subscribe((env) => {
    if (!env?.frameLogs || !Array.isArray(env.frameLogs)) return;
    const runtimeKey = String(env.runtimeId || 'local');
    const lastSeen = lastSeenFrameLogIdByRuntime.get(runtimeKey) ?? -1;
    let newLastSeen = lastSeen;

    for (const entry of env.frameLogs as any[]) {
      const id = Number(entry?.id);
      if (!Number.isFinite(id) || id <= lastSeen) continue;
      if (id > newLastSeen) newLastSeen = id;
      if (!shouldSurfaceLogAsToast(entry)) continue;

      const level = String(entry?.level || 'warn').toLowerCase();
      const message = String(entry?.message || 'Runtime error');
      const dedupeKey = `${runtimeKey}:${message}`;
      const now = Date.now();
      const lastToastAt = lastToastAtByKey.get(dedupeKey) ?? 0;
      if (now - lastToastAt < LOG_TOAST_COOLDOWN_MS) continue;
      lastToastAtByKey.set(dedupeKey, now);
      if (lastToastAtByKey.size > 1000) {
        lastToastAtByKey.clear();
      }

      const prefix = level === 'error' ? 'Runtime error' : 'Runtime warning';
      const text = `${prefix}: ${message}`;
      if (level === 'error') {
        toasts.error(text, 9000);
      } else {
        toasts.warning(text, 7000);
      }
    }

    if (newLastSeen > lastSeen) {
      lastSeenFrameLogIdByRuntime.set(runtimeKey, newLastSeen);
      if (lastSeenFrameLogIdByRuntime.size > 200) {
        lastSeenFrameLogIdByRuntime.clear();
      }
    }
  });

  // CRITICAL: window.isolatedEnv is a GETTER — always reads from active runtime.
  // This prevents stale env references after runtime switch (race-free).
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'isolatedEnv', {
      get() {
        return get(localEnvStore);
      },
      configurable: true,
      enumerable: true,
    });
  }

  // CRITICAL: Subscribe to activeRuntimeId changes and update env reactively
  // This ensures View.svelte always shows the correct env after VaultStore creates/switches runtimes
  let unsubActiveRuntime: (() => void) | null = null;

  // Pending entity data - bypasses Dockview params timing
  const pendingEntityData = new Map<string, {entityId: string, entityName: string, signerId: string, action?: 'r2r' | 'r2c'}>();

  const resolveEntityPanelData = (panelId: string) => {
    if (!panelId.startsWith('entity-')) return null;
    const entityId = panelId.slice('entity-'.length);
    const env = get(localEnvStore);
    const entries = env?.eReplicas ? Array.from(env.eReplicas.entries()) : [];
    const entry = entries.find((e: any) => e[0].startsWith(`${entityId}:`));
    if (!entry) return null;
    const [replicaKey, replica] = entry as [string, any];
    const signerId = replicaKey.split(':')[1] || entityId;
    return {
      entityId,
      entityName: replica?.name || entityId,
      signerId
    };
  };

  // Build version tracking (injected by vite.config.ts)
  // @ts-ignore - __BUILD_HASH__ and __BUILD_TIME__ are injected by vite define
  const BUILD_HASH: string = typeof globalThis.__BUILD_HASH__ !== 'undefined' ? globalThis.__BUILD_HASH__ : (typeof __BUILD_HASH__ !== 'undefined' ? __BUILD_HASH__ : 'dev');
  // @ts-ignore
  const BUILD_TIME: string = typeof globalThis.__BUILD_TIME__ !== 'undefined' ? globalThis.__BUILD_TIME__ : (typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : 'unknown');

  console.log('[View.svelte] 🎬 MODULE LOADED - scenarioId prop:', scenarioId);

  let envChangeRegisteredFor: string | null = null;
  let unregisterEnvChange: (() => void) | null = null;

  onMount(async () => {
    console.log('[View] ============ onMount ENTRY ============');
    console.log('[View] scenarioId:', scenarioId);
    console.log('[View] embedMode:', embedMode);

    // Version check - ALWAYS log build hash for stale detection
    console.log(`%c[XLN View] Build: ${BUILD_HASH} @ ${BUILD_TIME}`, 'color: #00ff88; font-weight: bold; font-size: 14px;');
    console.log('[View] onMount started - initializing isolated XLN');
    console.log('[View] 🎬 scenarioId prop:', scenarioId || '(empty)');

    // Initialize isolated XLN runtime
    try {
      // Load XLN runtime module (single instance shared via xlnStore)
      const { getXLN } = await import('$lib/stores/xlnStore');
      const XLN = await getXLN();

      console.log('[View] Runtime module loaded, creating env...');

      // CRITICAL: Initialize global xlnInstance for utility functions (deriveDelta, etc)
      // Graph3DPanel needs xlnFunctions even when using isolated stores
      const { xlnInstance } = await import('$lib/stores/xlnStore');
      xlnInstance.set(XLN);

      // Check for URL hash import (shareable state)
      const { parseURLHash } = await import('./utils/stateCodec');
      const urlImport = parseURLHash();

      let env;

      if (urlImport) {
        console.log('[View] 🔗 Importing state from URL hash...');
        env = XLN.createEmptyEnv();
        env.quietRuntimeLogs = true;

        // Restore jurisdictions + entities
        env.jReplicas = urlImport.state.x;
        env.activeJurisdiction = urlImport.state.a;
        env.eReplicas = urlImport.state.e;

        console.log('[View] ✅ Imported:', {
          jReplicas: env.jReplicas.size,
          entities: env.eReplicas.size,
        });
      } else {
        // Get env from VaultStore's active runtime (testnet already imported)
        const { runtimes, activeRuntimeId } = await import('$lib/stores/runtimeStore');
        const { get } = await import('svelte/store');
        const runtimeId = get(activeRuntimeId);

        if (runtimeId) {
          const runtime = get(runtimes).get(runtimeId);
          if (runtime?.env) {
            env = runtime.env;
            console.log('[View] ✅ Using env from VaultStore runtime:', {
              jReplicas: env.jReplicas?.size || 0,
              entities: env.eReplicas?.size || 0
            });
          } else {
            console.warn('[View] Runtime exists but env not ready yet - waiting for VaultStore to finish init');
          }
        } else {
          console.warn('[View] No active runtime yet - waiting for VaultStore');
        }
      }

      const registerEnvChanges = (envToRegister: any) => {
        if (!envToRegister || !XLN.registerEnvChangeCallback) return;
        const runtimeKey = envToRegister.runtimeId || null;
        if (envChangeRegisteredFor === runtimeKey) return;
        if (unregisterEnvChange) {
          unregisterEnvChange();
          unregisterEnvChange = null;
        }
        unregisterEnvChange = XLN.registerEnvChangeCallback(envToRegister, (nextEnv: any) => {
          if (get(localEnvStore) !== nextEnv) return;
          localEnvStore.set(nextEnv);
          localHistoryStore.set(nextEnv.history || []);
        });
        envChangeRegisteredFor = runtimeKey;
      };

      if (env) {
        // Set to isolated stores
        localEnvStore.set(env);
        localHistoryStore.set(env.history || []);
        // LIVE mode: start at latest frame, auto-advance on new frames
        const histLen = (env.history || []).length;
        localTimeIndex.set(urlImport?.state.ui?.ti ?? Math.max(0, histLen - 1));
        localIsLive.set(urlImport?.state.ui?.ti === undefined);
        registerEnvChanges(env);
      }

      // CRITICAL: Subscribe to activeRuntimeId changes to reactively update env
      // This ensures View always shows correct env after VaultStore creates/switches runtimes
      const { runtimes, activeRuntimeId } = await import('$lib/stores/runtimeStore');
      unsubActiveRuntime = activeRuntimeId.subscribe((runtimeId) => {
        if (!runtimeId) return;
        const allRuntimes = get(runtimes);
        const runtime = allRuntimes.get(runtimeId);

        // ASSERT: runtime must exist in runtimes Map
        if (!runtime) {
          console.error(`[View] RUNTIME NOT FOUND: activeRuntimeId="${runtimeId}" not in runtimes Map (keys: ${[...allRuntimes.keys()].join(', ')})`);
          return;
        }
        if (!runtime.env) {
          console.error(`[View] RUNTIME ENV NULL: activeRuntimeId="${runtimeId}" has no env`);
          return;
        }

        const prevEnv = get(localEnvStore);
        console.log('[View] Runtime switch:', {
          from: prevEnv?.runtimeId?.slice(0, 12) || 'none',
          to: runtime.env.runtimeId?.slice(0, 12) || '?',
          runtimeId: runtimeId.slice(0, 12),
          entities: runtime.env.eReplicas?.size || 0
        });

        localEnvStore.set(runtime.env);
        localHistoryStore.set(runtime.env.history || []);
        // Stay in live mode when runtime changes — start at latest frame
        localIsLive.set(true);
        const h = runtime.env.history || [];
        localTimeIndex.set(Math.max(0, h.length - 1));
        registerEnvChanges(runtime.env);

        // ASSERT: verify the switch took effect
        const currentEnv = get(localEnvStore);
        if (currentEnv !== runtime.env) {
          console.error(`[View] ENV SWITCH FAILED: localEnvStore has ${currentEnv?.runtimeId} but expected ${runtime.env.runtimeId}`);
        }
      });

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

        if (scenarioId === 'ahb' && env) {
          try {
            // CRITICAL: Clear old state BEFORE running (Architect panel pattern)
            console.log('[View] BEFORE clear: eReplicas =', env.eReplicas?.size || 0);
            if (env.eReplicas) env.eReplicas.clear();
            env.history = [];
            console.log('[View] AFTER clear: eReplicas =', env.eReplicas?.size || 0);

            console.log(`[View] 📦 Running XLN.scenarios.ahb...`);
            await XLN.scenarios.ahb(env);
            console.log(`[View] 📦 scenarios.ahb completed, history: ${env.history?.length || 0} frames`);

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
      // Don't block - ArchitectPanel can still work
    }

    // ALWAYS create Dockview (hide in user mode, show in dev mode)
    // This allows mode switching without recreating dockview
    console.log('[View] Creating Dockview (mode will toggle visibility)...');

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
              isolatedTimeIndex: localTimeIndex,
              graphInitSignal,
            }
          });
        } else if (options.name === 'brainvault') {
          component = mount(RuntimeCreation, {
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
        } else if (options.name === 'gossip') {
          component = mount(GossipPanel, {
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
              let data = pendingEntityData.get(panelId);

              if (!data) {
                data = resolveEntityPanelData(panelId) || undefined;
                if (data) {
                  pendingEntityData.set(panelId, data);
                }
              }

              if (!data) {
                queueMicrotask(() => parameters.api?.close?.());
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
                  isolatedIsLive: localIsLive,
                  ...(data.action && { initialAction: data.action })
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

    // Dev mode: Full layout (user mode already returned early)
    const ensurePanel = (config: any) => {
      const existing = dockview.getPanel(config.id);
      if (existing) return existing;
      return dockview.addPanel(config);
    };

    ensurePanel({
      id: 'graph3d',
      component: 'graph3d',
      title: '🌐 Graph3D',
      params: {
        closeable: false,
      },
    });

    ensurePanel({
      id: 'architect',
      component: 'architect',
      title: '🎬 Architect',
      position: { direction: 'right', referencePanel: 'graph3d' },
      params: {
        closeable: false,
      },
    });

    // ALL panels after Architect get inactive:true to prevent stealing focus

    ensurePanel({
      id: 'jurisdiction',
      component: 'jurisdiction',
      title: '🏛️ Jurisdiction',
      position: { direction: 'within', referencePanel: 'architect' },
      inactive: true,
      params: {
        closeable: false, // Core panel - cannot close
      },
    });

    ensurePanel({
      id: 'runtime-io',
      component: 'runtime-io',
      title: '🔄 Runtime I/O',
      position: { direction: 'within', referencePanel: 'architect' },
      inactive: true,
      params: {
        closeable: false, // Core panel - cannot close
      },
    });

    ensurePanel({
      id: 'settings',
      component: 'settings',
      title: '⚙️ Settings',
      position: { direction: 'within', referencePanel: 'architect' },
      inactive: true,
      params: {
        closeable: false, // Core panel - cannot close
      },
    });

    ensurePanel({
      id: 'gossip',
      component: 'gossip',
      title: '📡 Gossip',
      position: { direction: 'within', referencePanel: 'architect' },
      inactive: true,
      params: {
        closeable: false, // Core panel - debugging
      },
    });

    // REMOVED PANELS (merged elsewhere):
    // - Insurance: now in EntityPanel after Reserves
    // - Solvency: now in RuntimeIOPanel as first section

    // Restore saved layout if available (clear on any error)
    if (shouldRestoreLayout && savedLayout) {
      setTimeout(() => {
        try {
          const config = JSON.parse(savedLayout);
          if (config.dockview) {
            dockview.fromJSON(config.dockview);
            console.log('[View] ✅ Layout restored');
          }
        } catch (err) {
          console.warn('[View] Layout restore failed, clearing:', err);
          localStorage.removeItem('xln-dockview-layout');
          localStorage.removeItem('dockview-layout');
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

    activePanelDisposable = dockview.onDidActivePanelChange((event: any) => {
      const panel = event?.panel ?? event;
      const panelId = panel?.id || panel?.api?.id;
      if (panelId === 'graph3d') {
        graphInitSignal.set(true);
      }
    });

    // DISABLED: Dockview layout persistence (Svelte 5 incompatibility)
    // Issue: fromJSON() tries to destroy existing panels using $destroy()
    // which doesn't exist in Svelte 5. Need to implement custom serialization.
    // For now: Use default layout on every reload.

    // TODO: Custom layout serialization that doesn't use fromJSON/toJSON
    // Save panel IDs, positions, sizes manually and recreate on mount

    // Auto-save layout on ANY change (debounced)
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
    unsubOpenEntity = panelBridge.on('openEntityOperations', ({ entityId, entityName, signerId, action }) => {
      // Use full entityId to avoid collisions
      const panelId = `entity-${entityId}`;

      // Check ALL panels to find existing one
      const allPanels = dockview.panels;
      const existingPanel = allPanels.find(p => p.id === panelId);

      if (existingPanel) {
        console.log('[View] Focusing existing entity panel:', entityId);
        existingPanel.api.setActive();
        // TODO: If action passed, switch tab in existing panel
        return;
      }

      // STORE entity data BEFORE creating panel (bypasses Dockview params race)
      pendingEntityData.set(panelId, {
        entityId,
        entityName: entityName || entityId,
        signerId: signerId || entityId,
        ...(action && { action }) // 'r2r' or 'r2c' if quick action requested
      });

      // Create new panel using EntityPanelWrapper (reuses full EntityPanel)
      try {
        console.log('[View] 📋 Stored entity data + creating panel:', panelId);

        dockview.addPanel({
          id: panelId,
          component: 'entity-panel',
          title: `🏢 ${entityName || entityId}`,
          position: { direction: 'within', referencePanel: 'architect' },
          params: {
            closeable: true, // Entity panels ARE closeable (dynamic)
          },
        });
        console.log('[View] ✅ Entity panel created:', entityId);
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
    unsubOpenJurisdiction = panelBridge.on('openJurisdiction', ({ jurisdictionName }) => {
      const jurisdictionPanel = dockview.getPanel('jurisdiction');
      if (jurisdictionPanel) {
        jurisdictionPanel.api.setActive();
        console.log('[View] Focused Jurisdiction panel for:', jurisdictionName);
      }
    });

    // Listen for focus panel requests (from TimeMachine settings button)
    unsubFocusPanel = panelBridge.on('focusPanel', ({ panelId }) => {
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

  // Function to update panel visibility when mode toggles (preserves layout)
  function updatePanelsForMode(isUserMode: boolean) {
    if (!dockview) return;

    console.log(`[View] 🔄 Updating panels for ${isUserMode ? 'user' : 'dev'} mode...`);

    // Keep dockview panels alive across mode switches to avoid duplicate IDs/races.
    // User mode hides the dockview container; dev mode shows it again.
    if (!isUserMode) {
      requestAnimationFrame(() => {
        const width = container?.clientWidth || window.innerWidth;
        const height = container?.clientHeight || window.innerHeight;
        dockview.layout(width, height);
        const graph3dApi = dockview.getPanel('graph3d');
        if (graph3dApi) {
          const widthPercent = embedMode ? 1.0 : 0.70;
          graph3dApi.api.setSize({ width: window.innerWidth * widthPercent });
        }
      });
    }
  }

  onDestroy(() => {
    if (unregisterEnvChange) {
      unregisterEnvChange();
      unregisterEnvChange = null;
    }
    if (unsubLocalEnvSync) {
      unsubLocalEnvSync();
    }
    if (unsubRuntimeErrorToasts) {
      unsubRuntimeErrorToasts();
    }
    if (unsubOpenEntity) {
      unsubOpenEntity();
    }
    if (unsubOpenJurisdiction) {
      unsubOpenJurisdiction();
    }
    if (unsubFocusPanel) {
      unsubFocusPanel();
    }
    if (unsubActiveRuntime) {
      unsubActiveRuntime();
    }
    if (saveLayoutTimer) {
      clearTimeout(saveLayoutTimer);
      saveLayoutTimer = null;
    }
    if (activePanelDisposable) {
      activePanelDisposable.dispose();
      activePanelDisposable = null;
    }
    lastSeenFrameLogIdByRuntime.clear();
    lastToastAtByKey.clear();
    if (dockview) {
      dockview.dispose();
    }
  });
</script>

<div class="view-wrapper" class:embed-mode={embedMode}>
  <!-- Always render both, toggle visibility via CSS -->
  <div class="user-mode-container" class:hidden={!userMode}>
    <UserModePanel
      isolatedEnv={localEnvStore}
      isolatedHistory={localHistoryStore}
      isolatedTimeIndex={localTimeIndex}
      isolatedIsLive={localIsLive}
    />
  </div>

  <div class="view-container" class:hidden={userMode} class:with-timemachine={!collapsed} bind:this={container}></div>

  <!-- TimeMachine - Visible in both modes for time-travel debugging -->
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
    background: #0a0a0a;
    display: flex;
    flex-direction: column;
  }

  .user-mode-container {
    flex: 1;
    width: 100%;
    height: 100%;
    overflow: visible; /* Dropdowns must overlay - scroll is in panel-content */
    padding-bottom: 52px; /* Space for TimeMachine bar */
    background: #0a0a0a;
  }

  .user-mode-container.hidden {
    display: none;
  }

  .view-container {
    flex: 1;
    width: 100%;
    min-height: 0; /* Allow flex shrink */
  }

  .view-container.hidden {
    display: none;
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
