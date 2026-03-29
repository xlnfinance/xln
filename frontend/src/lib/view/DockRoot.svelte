<script lang="ts">
  import { onMount, onDestroy, mount, unmount } from 'svelte';
  import { writable, get, type Writable } from 'svelte/store';
  import { DockviewComponent } from 'dockview';
  import type { Env } from '@xln/runtime/xln-api';
  import type { EnvSnapshot } from '$types';
  import Graph3DPanel from './panels/Graph3DPanel.svelte';
  import ArchitectPanel from './panels/ArchitectPanel.svelte';
  import ConsolePanel from './panels/ConsolePanel.svelte';
  import RuntimeIOPanel from './panels/RuntimeIOPanel.svelte';
  import SettingsPanel from './panels/SettingsPanel.svelte';
  import JurisdictionPanel from './panels/JurisdictionPanel.svelte';
  import SolvencyPanel from './panels/SolvencyPanel.svelte';
  import GossipPanel from './panels/GossipPanel.svelte';
  import RuntimeCreation from '$lib/components/Views/RuntimeCreation.svelte';
  import EntityPanelWrapper from './panels/wrappers/EntityPanelWrapper.svelte';
  import TimeMachine from './core/TimeMachine.svelte';
  import { panelBridge } from './utils/panelBridge';
  import { settings } from '$lib/stores/settingsStore';
  import 'dockview/dist/styles/dockview.css';

  export let embedMode = false;
  export let isolatedEnv: Writable<Env | null>;
  export let isolatedHistory: Writable<EnvSnapshot[]>;
  export let isolatedTimeIndex: Writable<number>;
  export let isolatedIsLive: Writable<boolean>;

  let container: HTMLDivElement;
  let dockview: DockviewComponent;
  let unsubOpenEntity: (() => void) | null = null;
  let unsubOpenJurisdiction: (() => void) | null = null;
  let unsubFocusPanel: (() => void) | null = null;
  let activePanelDisposable: { dispose: () => void } | null = null;
  let saveLayoutTimer: ReturnType<typeof setTimeout> | null = null;
  let timeMachinePosition: 'bottom' | 'top' | 'left' | 'right' = 'bottom';
  let collapsed = false;
  let showSidebarInEmbed = false;

  type EntityPanelSeed = { entityId: string; entityName: string; signerId: string; action?: 'r2r' | 'r2c' };
  type DockviewInitParams = { api: { id: string; close?: () => void } };
  type DockviewWindow = Window & { __dockview_instance?: DockviewComponent };
  type ActivePanelRef = { id?: string; api?: { id?: string } } | undefined;
  type MountedComponent = ReturnType<typeof mount> | null;

  const graphInitSignal = writable<boolean>(embedMode);
  const pendingEntityData = new Map<string, EntityPanelSeed>();

  function resolveEntityPanelData(panelId: string) {
    if (!panelId.startsWith('entity-')) return null;
    const entityId = panelId.slice('entity-'.length);
    const env = get(isolatedEnv);
    const entries = env?.eReplicas
      ? Array.from(env.eReplicas.entries()) as Array<[string, { name?: string }]>
      : [];
    const entry = entries.find(([replicaKey]) => replicaKey.startsWith(`${entityId}:`));
    if (!entry) return null;
    const [replicaKey, replica] = entry;
    const signerId = replicaKey.split(':')[1] || entityId;
    return {
      entityId,
      entityName: replica?.name || entityId,
      signerId,
    };
  }

  function toggleEmbedSidebar() {
    showSidebarInEmbed = !showSidebarInEmbed;
    const graph3dApi = dockview?.getPanel('graph3d');
    if (graph3dApi) {
      const widthPercent = showSidebarInEmbed ? 0.70 : 1.0;
      graph3dApi.api.setSize({ width: window.innerWidth * widthPercent });
      console.log(`[DockRoot] Embed sidebar ${showSidebarInEmbed ? 'shown' : 'hidden'}`);
    }
  }

  onMount(() => {
    graphInitSignal.set(embedMode);

    dockview = new DockviewComponent(container, {
      className: 'dockview-theme-dark',
      createComponent: (options) => {
        const div = document.createElement('div');
        div.style.width = '100%';
        div.style.height = '100%';

        let component: MountedComponent = null;

        if (options.name === 'graph3d') {
          component = mount(Graph3DPanel, {
            target: div,
            props: {
              isolatedEnv,
              isolatedHistory,
              isolatedTimeIndex,
              graphInitSignal,
            },
          });
        } else if (options.name === 'brainvault') {
          component = mount(RuntimeCreation, { target: div, props: {} });
        } else if (options.name === 'architect') {
          component = mount(ArchitectPanel, {
            target: div,
            props: {
              isolatedEnv,
              isolatedHistory,
              isolatedTimeIndex,
              isolatedIsLive,
            },
          });
        } else if (options.name === 'console') {
          component = mount(ConsolePanel, {
            target: div,
            props: { isolatedEnv, isolatedHistory, isolatedTimeIndex },
          });
        } else if (options.name === 'runtime-io') {
          component = mount(RuntimeIOPanel, {
            target: div,
            props: { isolatedEnv, isolatedHistory, isolatedTimeIndex },
          });
        } else if (options.name === 'settings') {
          component = mount(SettingsPanel, {
            target: div,
            props: { isolatedEnv, isolatedHistory, isolatedTimeIndex },
          });
        } else if (options.name === 'solvency') {
          component = mount(SolvencyPanel, { target: div, props: {} });
        } else if (options.name === 'jurisdiction') {
          component = mount(JurisdictionPanel, {
            target: div,
            props: { isolatedEnv, isolatedHistory, isolatedTimeIndex },
          });
        } else if (options.name === 'gossip') {
          component = mount(GossipPanel, {
            target: div,
            props: { isolatedEnv, isolatedHistory, isolatedTimeIndex },
          });
        }

        return {
          element: div,
          init: (parameters: DockviewInitParams) => {
            if (options.name === 'entity-panel') {
              const panelId = parameters.api.id;
              let data = pendingEntityData.get(panelId);

              if (!data) {
                data = resolveEntityPanelData(panelId) || undefined;
                if (data) pendingEntityData.set(panelId, data);
              }

              if (!data) {
                queueMicrotask(() => parameters.api?.close?.());
                return;
              }

              pendingEntityData.delete(panelId);
              component = mount(EntityPanelWrapper, {
                target: div,
                props: {
                  entityId: data.entityId,
                  entityName: data.entityName,
                  signerId: data.signerId,
                  isolatedEnv,
                  isolatedHistory,
                  isolatedTimeIndex,
                  isolatedIsLive,
                  ...(data.action && { initialAction: data.action }),
                },
              });
            }
          },
          dispose: () => {
            if (!component) return;
            void unmount(component);
            component = null;
          },
        };
      },
    });

    if (typeof window !== 'undefined') {
      (window as DockviewWindow).__dockview_instance = dockview;
    }

    const savedLayout = localStorage.getItem('xln-workspace-layout');
    let shouldRestoreLayout = false;
    if (savedLayout) {
      try {
        const config = JSON.parse(savedLayout);
        if (config.dockview) shouldRestoreLayout = true;
      } catch {
        localStorage.removeItem('xln-workspace-layout');
      }
    }

    const ensurePanel = (config: Parameters<DockviewComponent['addPanel']>[0]) => {
      const existing = dockview.getPanel(config.id);
      if (existing) return existing;
      return dockview.addPanel(config);
    };

    ensurePanel({
      id: 'graph3d',
      component: 'graph3d',
      title: '🌐 Graph3D',
      params: { closeable: false },
    });

    ensurePanel({
      id: 'architect',
      component: 'architect',
      title: '🎬 Architect',
      position: { direction: 'right', referencePanel: 'graph3d' },
      params: { closeable: false },
    });

    ensurePanel({
      id: 'jurisdiction',
      component: 'jurisdiction',
      title: '🏛️ Jurisdiction',
      position: { direction: 'within', referencePanel: 'architect' },
      inactive: true,
      params: { closeable: false },
    });

    ensurePanel({
      id: 'runtime-io',
      component: 'runtime-io',
      title: '🔄 Runtime I/O',
      position: { direction: 'within', referencePanel: 'architect' },
      inactive: true,
      params: { closeable: false },
    });

    ensurePanel({
      id: 'settings',
      component: 'settings',
      title: '⚙️ Settings',
      position: { direction: 'within', referencePanel: 'architect' },
      inactive: true,
      params: { closeable: false },
    });

    ensurePanel({
      id: 'gossip',
      component: 'gossip',
      title: '📡 Gossip',
      position: { direction: 'within', referencePanel: 'architect' },
      inactive: true,
      params: { closeable: false },
    });

    if (shouldRestoreLayout && savedLayout) {
      setTimeout(() => {
        try {
          const config = JSON.parse(savedLayout);
          if (config.dockview) dockview.fromJSON(config.dockview);
        } catch (err) {
          console.warn('[DockRoot] Layout restore failed, clearing:', err);
          localStorage.removeItem('xln-workspace-layout');
          localStorage.removeItem('xln-dockview-layout');
          localStorage.removeItem('dockview-layout');
        }
      }, 100);
    } else {
      setTimeout(() => {
        const architectPanel = dockview.getPanel('architect');
        architectPanel?.api.setActive();
      }, 0);
    }

    const graph3dApi = dockview.getPanel('graph3d');
    if (graph3dApi) {
      setTimeout(() => {
        const widthPercent = embedMode ? 1.0 : 0.70;
        graph3dApi.api.setSize({ width: window.innerWidth * widthPercent });
      }, 100);
    }

    activePanelDisposable = dockview.onDidActivePanelChange((panel: ActivePanelRef) => {
      const panelId = panel?.id || panel?.api?.id;
      if (panelId === 'graph3d') graphInitSignal.set(true);
    });

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
        } catch (err) {
          console.warn('[DockRoot] Failed to auto-save layout:', err);
        }
      }, 500);
    });

    unsubOpenEntity = panelBridge.on('openEntityOperations', ({ entityId, entityName, signerId, action }) => {
      const panelId = `entity-${entityId}`;
      const existingPanel = dockview.panels.find((p) => p.id === panelId);

      if (existingPanel) {
        existingPanel.api.setActive();
        return;
      }

      pendingEntityData.set(panelId, {
        entityId,
        entityName: entityName || entityId,
        signerId: signerId || entityId,
        ...(action && { action }),
      });

      try {
        dockview.addPanel({
          id: panelId,
          component: 'entity-panel',
          title: `🏢 ${entityName || entityId}`,
          position: { direction: 'within', referencePanel: 'architect' },
          params: { closeable: true },
        });
      } catch (err) {
        console.error('[DockRoot] Failed to create entity panel:', err);
        const retryPanel = dockview.panels.find((p) => p.id === panelId);
        retryPanel?.api.setActive();
      }
    });

    unsubOpenJurisdiction = panelBridge.on('openJurisdiction', () => {
      const jurisdictionPanel = dockview.getPanel('jurisdiction');
      jurisdictionPanel?.api.setActive();
    });

    unsubFocusPanel = panelBridge.on('focusPanel', ({ panelId }) => {
      const panel = dockview.getPanel(panelId);
      panel?.api.setActive();
    });
  });

  onDestroy(() => {
    if (saveLayoutTimer) {
      clearTimeout(saveLayoutTimer);
      saveLayoutTimer = null;
    }
    if (activePanelDisposable) {
      activePanelDisposable.dispose();
      activePanelDisposable = null;
    }
    unsubOpenEntity?.();
    unsubOpenJurisdiction?.();
    unsubFocusPanel?.();
    if (dockview) dockview.dispose();
  });
</script>

<div class="view-wrapper" class:embed-mode={embedMode}>
  <div
    class="view-container"
    class:with-timemachine={$settings.showTimeMachine && !collapsed}
    bind:this={container}
  ></div>

  {#if $settings.showTimeMachine}
    <div class="time-machine-bar" class:collapsed class:embed={embedMode} data-position={timeMachinePosition}>
      {#if !embedMode}
        <div class="drag-handle" title="Drag to reposition">⋮⋮</div>
      {/if}
      <TimeMachine
        history={isolatedHistory}
        timeIndex={isolatedTimeIndex}
        isLive={isolatedIsLive}
        env={isolatedEnv}
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

  {#if embedMode}
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
    height: 100dvh;
    min-height: 100dvh;
    background: var(--theme-bg-gradient, #0a0a0a);
    color: var(--theme-text-primary, #e4e4e7);
    display: flex;
    flex-direction: column;
  }

  .view-container {
    flex: 1;
    width: 100%;
    min-height: 0;
  }

  .view-container.with-timemachine {
    height: calc(100dvh - 48px);
  }

  .view-wrapper.embed-mode {
    height: 100dvh;
    min-height: 100dvh;
  }

  .view-wrapper.embed-mode .view-container {
    height: 100dvh;
  }

  .view-wrapper.embed-mode .view-container.with-timemachine {
    height: calc(100dvh - 48px);
  }

  .view-wrapper.embed-mode :global(.dockview-tabs-container),
  .view-wrapper.embed-mode :global(.dockview-groupcontrol) {
    display: none !important;
  }

  .time-machine-bar.embed {
    height: 48px;
  }

  :global(.dockview-theme-dark .dockview-tab) {
    background: var(--theme-surface, #2d2d30);
    color: var(--theme-text-secondary, #ccc);
  }

  :global(.dockview-theme-dark .dockview-tab.active) {
    background: var(--theme-header-bg, #1e1e1e);
    color: var(--theme-text-primary, #fff);
  }

  :global(.dockview-theme-dark .dockview-separator) {
    background: var(--theme-accent, #007acc);
  }

  :global(.dockview-theme-dark .dockview-groupview),
  :global(.dockview-theme-dark .dockview-groupcontrol),
  :global(.dockview-theme-dark .dv-groupview) {
    background: var(--theme-background, #09090b);
    color: var(--theme-text-primary, #e4e4e7);
  }

  .time-machine-bar {
    position: relative;
    width: 100%;
    background: rgba(9, 9, 11, 0.92);
    border-top: 1px solid rgba(255, 255, 255, 0.06);
    backdrop-filter: blur(12px);
    z-index: 20;
  }

  .time-machine-bar.collapsed {
    height: 20px;
    overflow: hidden;
  }

  .drag-handle {
    position: absolute;
    left: 8px;
    top: 50%;
    transform: translateY(-50%);
    color: rgba(255, 255, 255, 0.38);
    font-size: 12px;
    user-select: none;
  }

  .collapse-btn,
  .position-toggle-btn,
  .embed-sidebar-toggle {
    position: absolute;
    right: 8px;
    top: 50%;
    transform: translateY(-50%);
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(24, 24, 27, 0.9);
    color: #e4e4e7;
    border-radius: 8px;
    min-width: 28px;
    height: 28px;
    cursor: pointer;
  }

  .position-toggle-btn {
    right: 42px;
  }

  .embed-sidebar-toggle {
    top: 16px;
    right: 16px;
    transform: none;
    z-index: 30;
  }

  .embed-sidebar-toggle.sidebar-visible {
    background: rgba(251, 191, 36, 0.12);
    border-color: rgba(251, 191, 36, 0.4);
    color: #fbbf24;
  }
</style>
