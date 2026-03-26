<script lang="ts">
  /**
   * EntityPanelWrapper - Dockview adapter for legacy EntityPanel
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
  import EntityPanelTabs from '$lib/components/Entity/EntityPanelTabs.svelte';
  import type { Tab } from '$lib/types/ui';

  // Props from Dockview panel params (Svelte 5 runes syntax)
  let {
    entityId = '',
    entityName = '',
    signerId = '',
    isolatedEnv = undefined,
    isolatedHistory = undefined,
    isolatedTimeIndex = undefined,
    isolatedIsLive = undefined,
    initialAction = undefined,
  }: {
    entityId?: string;
    entityName?: string;
    signerId?: string;
    isolatedEnv?: Writable<unknown | null>;
    isolatedHistory?: Writable<unknown[]>;
    isolatedTimeIndex?: Writable<number>;
    isolatedIsLive?: Writable<boolean>;
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

  // DISABLED $effect - was causing infinite loops
  // localTab is already initialized above with correct values from props
</script>

<div class="entity-panel-wrapper">
  <!-- Entity panel content only - time machine is in global TimeMachine bar -->
  <EntityPanelTabs tab={localTab} {initialAction} />
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

  /* Override EntityPanelTabs styles for Dockview context */
  .entity-panel-wrapper :global(.entity-panel-tabs) {
    flex: 1;
    border: none;
    border-radius: 0;
    min-width: unset;
    max-width: unset;
    height: 100%;
    overflow: auto;
  }
</style>
