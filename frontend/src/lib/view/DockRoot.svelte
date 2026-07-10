<script lang="ts">
  import { onMount, onDestroy, mount, unmount } from 'svelte';
  import { writable, type Writable } from 'svelte/store';
  import { DockviewComponent } from 'dockview';
  import type { Env, RuntimeAdapterViewFrame } from '@xln/runtime/xln-api';
  import type { EnvSnapshot } from '$types';
  import Graph3DPanel from './panels/Graph3DPanel.svelte';
  import ConsolePanel from './panels/ConsolePanel.svelte';
  import RuntimeIOPanel from './panels/RuntimeIOPanel.svelte';
  import SettingsPanel from './panels/SettingsPanel.svelte';
  import JurisdictionPanel from './panels/JurisdictionPanel.svelte';
  import SolvencyPanel from './panels/SolvencyPanel.svelte';
  import GossipPanel from './panels/GossipPanel.svelte';
  import DockEntityAuditPanel from './panels/DockEntityAuditPanel.svelte';
  import JMachineInspectorPanel from './panels/JMachineInspectorPanel.svelte';
  import RuntimeDiagnosticsPanel from './panels/RuntimeDiagnosticsPanel.svelte';
  import RuntimeCreation from '$lib/components/Views/RuntimeCreation.svelte';
  import RemoteRuntimeManager from '$lib/components/Runtime/RemoteRuntimeManager.svelte';
  import IndexedDbInspector from '$lib/components/Settings/IndexedDbInspector.svelte';
  import UserModePanel from './UserModePanel.svelte';
  import EntityPanelWrapper from './panels/wrappers/EntityPanelWrapper.svelte';
  import TimeMachine from './core/TimeMachine.svelte';
  import { panelBridge, type EntityOpenAction } from './utils/panelBridge';
  import { errorLog } from '$lib/stores/errorLogStore';
  import { settings } from '$lib/stores/settingsStore';
  import { refreshRuntimeView } from '$lib/stores/runtimeViewStore';
  import { runtimeControllerHandle } from '$lib/stores/runtimeControllerStore';
  import { appStateOperations } from '$lib/stores/appStateStore';
  import 'dockview/dist/styles/dockview.css';

  export let embedMode = false;
  export let runtimeFrameEnv: Writable<Env | null>;
  export let runtimeFrameHistory: Writable<EnvSnapshot[]>;
  export let runtimeFrameTimeIndex: Writable<number>;
  export let runtimeFrameIsLive: Writable<boolean>;

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
  $: showDockTimeMachine = !embedMode || $settings.showTimeMachine;

  type EntityPanelSeed = { entityId: string; entityName: string; signerId: string; action?: EntityOpenAction };
  type DockviewInitParams = { api: { id: string; close?: () => void } };
  type DockviewWindow = Window & { __dockview_instance?: DockviewComponent };
  type ActivePanelRef = { id?: string; api?: { id?: string } } | undefined;
  type MountedComponent = ReturnType<typeof mount> | null;

  const graphInitSignal = writable<boolean>(embedMode);
  const pendingEntityData = new Map<string, EntityPanelSeed>();
  const ENV_ONLY_PANEL_NAMES = new Set([
    'architect',
    'console',
    'runtime-io',
    'jurisdiction',
    'jmachine-inspector',
  ]);

  function panelRequiresRuntimeEnv(panelName: string): boolean {
    return ENV_ONLY_PANEL_NAMES.has(panelName);
  }

  function panelDisplayName(panelName: string): string {
    if (panelName === 'graph3d') return 'Network graph';
    if (panelName === 'runtime-io') return 'Runtime IO';
    return panelName.charAt(0).toUpperCase() + panelName.slice(1);
  }

  function shouldBlockRemoteEnvOnlyPanel(panelName: string): boolean {
    return $runtimeControllerHandle.mode === 'remote' && panelRequiresRuntimeEnv(panelName);
  }

  function showRemoteProjectionBoundary(div: HTMLDivElement, panelName: string): void {
    showEntityPanelStatus(
      div,
      `${panelDisplayName(panelName)} is embedded-only until its projection endpoint is available. Remote runtime state is readable in Entity, Gossip, Activity, and Time Machine.`,
      false,
    );
  }

  function primaryDockReferencePanel(): string {
    return 'wallet-main';
  }

  function entityIdFromPanelId(panelId: string): string | null {
    if (!panelId.startsWith('entity-')) return null;
    return panelId.slice('entity-'.length).trim().toLowerCase();
  }

  function showEntityPanelStatus(target: HTMLElement, message: string, isError = false): void {
    target.innerHTML = '';
    const box = document.createElement('div');
    box.className = `entity-panel-status${isError ? ' error' : ''}`;
    box.textContent = message;
    target.appendChild(box);
  }

  function logDockRootDiagnostic(message: string, details?: unknown): void {
    errorLog.log(message, 'DockRoot', details);
  }

  function entityOpenMode(): 'replace' | 'new-tab' {
    return typeof localStorage !== 'undefined' && localStorage.getItem('xln-dock-entity-open-mode') === 'new-tab'
      ? 'new-tab'
      : 'replace';
  }

  function seedFromViewFrame(
    entityId: string,
    frame: RuntimeAdapterViewFrame,
    existing?: EntityPanelSeed,
  ): EntityPanelSeed | null {
    const activeEntityId = String(frame.activeEntityId || frame.activeEntity?.summary?.entityId || '').trim().toLowerCase();
    if (activeEntityId !== entityId || !frame.activeEntity) return null;
    const core = frame.activeEntity.core;
    const summary = frame.activeEntity.summary;
    const signerId = String(core.signerId || existing?.signerId || '').trim().toLowerCase();
    if (!signerId) return null;
    return {
      entityId,
      entityName: String(core.profile?.name || summary.label || existing?.entityName || entityId).trim() || entityId,
      signerId,
      ...(existing?.action ? { action: existing.action } : {}),
    };
  }

  async function resolveEntityPanelDataFromProjection(
    panelId: string,
    existing?: EntityPanelSeed,
  ): Promise<EntityPanelSeed | null> {
    const entityId = entityIdFromPanelId(panelId);
    if (!entityId) return null;
    const view = await refreshRuntimeView({
      entityId,
      accountsLimit: 1,
      booksLimit: 1,
    });
    return view.frame ? seedFromViewFrame(entityId, view.frame, existing) : null;
  }

  function toggleEmbedSidebar() {
    showSidebarInEmbed = !showSidebarInEmbed;
    const graph3dApi = dockview?.getPanel('graph3d');
    if (graph3dApi) {
      const widthPercent = showSidebarInEmbed ? 0.70 : 1.0;
      graph3dApi.api.setSize({ width: window.innerWidth * widthPercent });
    }
  }

  onMount(() => {
    graphInitSignal.set(true);

    dockview = new DockviewComponent(container, {
      className: 'dockview-theme-dark',
      createTabComponent: (options) => {
        if (options.name !== 'pinned-tab') return undefined;
        const element = document.createElement('div');
        element.className = 'xln-pinned-dock-tab';
        return {
          element,
          init: (parameters: { title: string }) => {
            element.textContent = `📌 ${parameters.title}`;
            element.title = 'Pinned reference panel';
          },
        };
      },
      createComponent: (options) => {
        const div = document.createElement('div');
        div.style.width = '100%';
        div.style.height = '100%';

        let component: MountedComponent = null;

        if (shouldBlockRemoteEnvOnlyPanel(options.name)) {
          showRemoteProjectionBoundary(div, options.name);
          return {
            element: div,
            init: () => {},
            dispose: () => {},
          };
        }

        if (options.name === 'graph3d') {
          component = mount(Graph3DPanel, {
            target: div,
            props: {
              runtimeFrameEnv,
              runtimeFrameHistory,
              runtimeFrameTimeIndex,
              runtimeFrameIsLive,
              graphInitSignal,
            },
          });
        } else if (options.name === 'wallet') {
          component = mount(UserModePanel, {
            target: div,
            props: {
              runtimeFrameEnv,
              runtimeFrameHistory,
              runtimeFrameTimeIndex,
              runtimeFrameIsLive,
              dockMode: true,
            },
          });
        } else if (options.name === 'brainvault') {
          component = mount(RuntimeCreation, { target: div, props: {} });
        } else if (options.name === 'architect') {
          showEntityPanelStatus(div, 'Loading Dev Lab...');
          let disposed = false;
          void import('./panels/ArchitectPanel.svelte')
            .then((module) => {
              if (disposed) return;
              div.innerHTML = '';
              component = mount(module.default, {
                target: div,
                props: {
                  runtimeFrameEnv,
                  runtimeFrameHistory,
                  runtimeFrameTimeIndex,
                  runtimeFrameIsLive,
                },
              });
            })
            .catch((error) => {
              logDockRootDiagnostic('Failed to load Dev Lab', error);
              const message = error instanceof Error ? error.message : String(error || 'Dev Lab load failed');
              showEntityPanelStatus(div, `Dev Lab failed: ${message}`, true);
            });
          return {
            element: div,
            init: () => {},
            dispose: () => {
              disposed = true;
              if (!component) return;
              void unmount(component);
              component = null;
            },
          };
        } else if (options.name === 'console') {
          component = mount(ConsolePanel, {
            target: div,
            props: { runtimeFrameEnv, runtimeFrameHistory, runtimeFrameTimeIndex },
          });
        } else if (options.name === 'runtime-io') {
          component = mount(RuntimeIOPanel, {
            target: div,
            props: { runtimeFrameEnv, runtimeFrameHistory, runtimeFrameTimeIndex },
          });
        } else if (options.name === 'settings') {
          component = mount(SettingsPanel, {
            target: div,
            props: { runtimeFrameEnv, runtimeFrameHistory, runtimeFrameTimeIndex },
          });
        } else if (options.name === 'solvency') {
          component = mount(SolvencyPanel, { target: div, props: { runtimeFrameEnv } });
        } else if (options.name === 'jurisdiction') {
          component = mount(JurisdictionPanel, {
            target: div,
            props: { runtimeFrameEnv, runtimeFrameHistory, runtimeFrameTimeIndex },
          });
        } else if (options.name === 'gossip') {
          component = mount(GossipPanel, {
            target: div,
            props: {},
          });
        } else if (options.name === 'entity-audit') {
          component = mount(DockEntityAuditPanel, { target: div, props: {} });
        } else if (options.name === 'jmachine-inspector') {
          component = mount(JMachineInspectorPanel, {
            target: div,
            props: { runtimeFrameEnv, runtimeFrameHistory, runtimeFrameTimeIndex },
          });
        } else if (options.name === 'runtime-manager') {
          component = mount(RemoteRuntimeManager, { target: div, props: {} });
        } else if (options.name === 'leveldb-inspector') {
          component = mount(IndexedDbInspector, { target: div, props: {} });
        } else if (options.name === 'runtime-diagnostics') {
          component = mount(RuntimeDiagnosticsPanel, { target: div, props: {} });
        }

        return {
          element: div,
          init: (parameters: DockviewInitParams) => {
            if (options.name === 'entity-panel') {
              const panelId = parameters.api.id;
              const mountEntityPanel = (data: EntityPanelSeed): void => {
                pendingEntityData.delete(panelId);
                if (component) void unmount(component);
                component = mount(EntityPanelWrapper, {
                  target: div,
                  props: {
                    entityId: data.entityId,
                    entityName: data.entityName,
                    signerId: data.signerId,
                    runtimeFrameEnv,
                    runtimeFrameHistory,
                    runtimeFrameTimeIndex,
                    runtimeFrameIsLive,
                    ...(data.action && { initialAction: data.action }),
                  },
                });
              };
              const data = pendingEntityData.get(panelId);

              if (data?.signerId && data.entityName) {
                mountEntityPanel(data);
                return;
              }

              showEntityPanelStatus(div, 'Loading entity projection...');
              void resolveEntityPanelDataFromProjection(panelId, data)
                .then((resolved) => {
                  if (!resolved) {
                    showEntityPanelStatus(div, `Entity projection not found for ${panelId}`, true);
                    return;
                  }
                  mountEntityPanel(resolved);
                })
                .catch((error) => {
                  logDockRootDiagnostic('Failed to resolve entity panel projection', { panelId, error });
                  const message = error instanceof Error ? error.message : String(error || 'projection failed');
                  showEntityPanelStatus(div, `Entity projection failed: ${message}`, true);
                });
              return;
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

    const ensureWorkspacePanels = () => {
      ensurePanel({
        id: 'graph3d',
        component: 'graph3d',
        title: 'Graph3D',
      });

      ensurePanel({
        id: 'wallet-main',
        component: 'wallet',
        tabComponent: 'pinned-tab',
        title: 'Main Wallet',
        position: { direction: 'right', referencePanel: 'graph3d' },
      });

      ensurePanel({
        id: 'architect',
        component: 'architect',
        title: '🎬 Architect',
        position: { direction: 'below', referencePanel: 'wallet-main' },
        initialHeight: Math.max(240, Math.floor(window.innerHeight * 0.32)),
      });

      ensurePanel({
        id: 'jurisdiction',
        component: 'jurisdiction',
        title: '🏛️ J-Machine',
        position: { direction: 'right', referencePanel: 'architect' },
        inactive: true,
      });

      for (const panel of [
        { id: 'runtime-io', component: 'runtime-io', title: '🔄 Runtime I/O' },
        { id: 'settings', component: 'settings', title: '⚙️ Settings' },
        { id: 'console', component: 'console', title: '⌨️ Console' },
        { id: 'gossip', component: 'gossip', title: '📡 Gossip' },
        { id: 'solvency', component: 'solvency', title: '⚖️ Solvency' },
        { id: 'entity-audit', component: 'entity-audit', title: '🔎 Entity Audit' },
        { id: 'jmachine-inspector', component: 'jmachine-inspector', title: '🧬 J-State' },
        { id: 'runtime-manager', component: 'runtime-manager', title: '🌐 Runtimes' },
        { id: 'leveldb-inspector', component: 'leveldb-inspector', title: '🗄️ LevelDB' },
        { id: 'runtime-diagnostics', component: 'runtime-diagnostics', title: '🩺 Diagnostics' },
      ]) {
        ensurePanel({
          ...panel,
          position: { direction: 'within', referencePanel: 'jurisdiction' },
          inactive: true,
        });
      }
    };

    ensureWorkspacePanels();

    if (shouldRestoreLayout && savedLayout) {
      setTimeout(() => {
        try {
          const config = JSON.parse(savedLayout);
          if (config.dockview) dockview.fromJSON(config.dockview);
          ensureWorkspacePanels();
        } catch (err) {
          logDockRootDiagnostic('Layout restore failed; clearing saved workspace layout', err);
          localStorage.removeItem('xln-workspace-layout');
          localStorage.removeItem('xln-dockview-layout');
          localStorage.removeItem('dockview-layout');
        }
      }, 100);
    } else {
      setTimeout(() => {
        const primaryPanel = dockview.getPanel('wallet-main');
        primaryPanel?.api.setActive();
      }, 0);
    }

    const graph3dApi = dockview.getPanel('graph3d');
    if (graph3dApi) {
      setTimeout(() => {
        const widthPercent = embedMode ? 1.0 : 0.50;
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
          logDockRootDiagnostic('Failed to auto-save workspace layout', err);
        }
      }, 500);
    });

    unsubOpenEntity = panelBridge.on('openEntityOperations', ({ entityId, entityName, signerId, action }) => {
      if (entityOpenMode() === 'replace') {
        panelBridge.emit('dock:selectEntity', {
          entityId,
          entityName,
          ...(signerId ? { signerId } : {}),
          ...(action ? { action } : {}),
        });
        dockview.getPanel('wallet-main')?.api.setActive();
        return;
      }
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
          position: { direction: 'within', referencePanel: primaryDockReferencePanel() },
          params: { closeable: true },
        });
      } catch (err) {
        logDockRootDiagnostic('Failed to create entity panel', { entityId, err });
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
  {#if !embedMode}
    <button
      type="button"
      class="dock-exit-btn"
      data-testid="dock-exit-user-mode"
      on:click={() => appStateOperations.setMode('user')}
      title="Return to the basic wallet"
    >
      User
    </button>
  {/if}
  <div
    class="view-container"
    class:with-timemachine={showDockTimeMachine && !collapsed}
    bind:this={container}
  ></div>

  {#if showDockTimeMachine}
    <div class="time-machine-bar" class:collapsed class:embed={embedMode} data-position={timeMachinePosition}>
      {#if !embedMode}
        <div class="drag-handle" title="Drag to reposition">⋮⋮</div>
      {/if}
      <TimeMachine
        history={runtimeFrameHistory}
        timeIndex={runtimeFrameTimeIndex}
        isLive={runtimeFrameIsLive}
        env={runtimeFrameEnv}
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

  .dock-exit-btn {
    position: fixed;
    top: 7px;
    right: 10px;
    z-index: 80;
    height: 26px;
    padding: 0 10px;
    border: 1px solid rgba(73, 208, 255, 0.35);
    border-radius: 6px;
    background: rgba(6, 15, 22, 0.92);
    color: #a7e8ff;
    font: 600 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
    cursor: pointer;
  }

  :global(.xln-pinned-dock-tab) {
    display: flex;
    align-items: center;
    min-width: 0;
    height: 100%;
    padding: 0 10px;
    color: #d7eef7;
    font-size: 12px;
    white-space: nowrap;
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

  :global(.entity-panel-status) {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100%;
    padding: 24px;
    color: var(--theme-text-secondary, #a1a1aa);
    text-align: center;
    font-size: 14px;
  }

  :global(.entity-panel-status.error) {
    color: #fecaca;
    background: rgba(127, 29, 29, 0.18);
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
