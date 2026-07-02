<script lang="ts">
  /**
   * EntityPanelWrapper - Dockview adapter for EntityWorkspace
   *
   * Wraps the existing EntityPanel component for use in /view Dockview workspace.
   * Child components read canonical state from xlnStore.
   *
   * Now includes TimeSlider for per-panel time-travel controls.
   *
   * @license AGPL-3.0
   * Copyright (C) 2025 XLN Finance
   */

  import type { Writable } from 'svelte/store';
  import EntityWorkspace from '$lib/components/Entity/EntityWorkspace.svelte';
  import type { EntityWorkspaceRuntimeFrameContext } from '$lib/components/Entity/runtime-frame-context';
  import type { Tab } from '$lib/types/ui';
  import type { Env, EnvSnapshot } from '@xln/runtime/xln-api';
  import { runtimeControllerHandle } from '$lib/stores/runtimeControllerStore';

  // Props from Dockview panel params (Svelte 5 runes syntax)
  let {
    entityId = '',
    entityName = '',
    signerId = '',
    runtimeFrameEnv = undefined,
    runtimeFrameHistory = undefined,
    runtimeFrameTimeIndex = undefined,
    runtimeFrameIsLive = undefined,
    initialAction = undefined,
  }: {
    entityId?: string;
    entityName?: string;
    signerId?: string;
    runtimeFrameEnv?: Writable<Env | null>;
    runtimeFrameHistory?: Writable<EnvSnapshot[]>;
    runtimeFrameTimeIndex?: Writable<number>;
    runtimeFrameIsLive?: Writable<boolean>;
    initialAction?: 'r2r' | 'r2c';
  } = $props();

  const localTab: Tab = $derived({
    id: `entity-${entityId.slice(0, 8)}`,
    title: entityName || entityId,
    entityId,
    signerId: signerId || entityId,
    jurisdiction: 'browservm',
    isActive: true,
  });

  const isRemoteRuntime = $derived.by<boolean>(() => $runtimeControllerHandle.mode === 'remote');
  const activeEnv = $derived.by<Env | null>(() => {
    if (isRemoteRuntime) return null;
    return runtimeFrameEnv ? ($runtimeFrameEnv ?? null) : null;
  });
  const activeHistory = $derived.by<EnvSnapshot[]>(() => runtimeFrameHistory ? ($runtimeFrameHistory ?? []) : []);
  const activeTimeIndex = $derived.by<number>(() => runtimeFrameTimeIndex ? ($runtimeFrameTimeIndex ?? -1) : -1);
  const activeIsLive = $derived.by<boolean>(() => runtimeFrameIsLive ? ($runtimeFrameIsLive ?? true) : true);
  const canMountWorkspace = $derived.by<boolean>(() =>
    Boolean(activeEnv || (isRemoteRuntime && $runtimeControllerHandle.status === 'connected')),
  );

  function goToLive(): void {
    runtimeFrameTimeIndex?.set(-1);
    runtimeFrameIsLive?.set(true);
  }

  function resolveLiveEnv(): Env | null {
    return isRemoteRuntime ? null : activeEnv;
  }

  const runtimeFrameContext = $derived.by<EntityWorkspaceRuntimeFrameContext>(() => ({
    env: activeEnv,
    liveEnv: activeEnv,
    liveEnvResolver: resolveLiveEnv,
    envRevision: '',
    history: activeHistory,
    timeIndex: activeTimeIndex,
    isLive: activeIsLive,
    onGoToLive: goToLive,
  }));

</script>

<div class="entity-panel-wrapper">
  <!-- Entity workspace content only - time machine is in global TimeMachine bar -->
  {#if canMountWorkspace}
    <EntityWorkspace
      tab={localTab}
      {initialAction}
      {runtimeFrameContext}
    />
  {/if}
</div>

<style>
  .entity-panel-wrapper {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    overflow: hidden;
    background: #1e1e1e;
  }

  /* Override EntityWorkspace styles for Dockview context */
  .entity-panel-wrapper :global(.entity-workspace) {
    flex: 1;
    border: none;
    border-radius: 0;
    min-width: unset;
    max-width: unset;
    height: 100%;
    overflow: auto;
  }
</style>
