<script lang="ts">
  /**
   * EntityPanelWrapper - Dockview adapter for legacy EntityPanel
   *
   * Wraps the existing EntityPanel component for use in /view Dockview workspace.
   * Sets up EntityEnvContext so all child components (AccountPanel, PaymentPanel, etc.)
   * can access either isolated or global stores transparently.
   *
   * @license AGPL-3.0
   * Copyright (C) 2025 XLN Finance
   */

  import type { Writable } from 'svelte/store';
  import { writable } from 'svelte/store';
  import { setEntityEnvContext, type HistoryFrame } from '../../components/entity/shared/EntityEnvContext';
  import EntityPanel from '$lib/components/Entity/EntityPanel.svelte';
  import type { Tab } from '$lib/types/ui';

  // Props from Dockview panel params
  export let entityId: string = '';
  export let entityName: string = '';
  export let signerId: string = '';

  // Isolated stores (passed from View.svelte)
  export let isolatedEnv: Writable<HistoryFrame | null> | undefined = undefined;
  export let isolatedHistory: Writable<HistoryFrame[]> | undefined = undefined;
  export let isolatedTimeIndex: Writable<number> | undefined = undefined;
  export let isolatedIsLive: Writable<boolean> | undefined = undefined;

  // CRITICAL: Set context during initialization (not in onMount)
  // Svelte context must be set synchronously during component init
  setEntityEnvContext({
    isolatedEnv,
    isolatedHistory,
    isolatedTimeIndex,
    isolatedIsLive,
  });

  // Create a synthetic tab for EntityPanel
  $: tabId = `entity-${entityId.slice(0, 8)}`;

  // Tab store for this panel instance
  const tab = writable<Tab>({
    id: tabId,
    title: entityName || entityId.slice(0, 12) + '...',
    entityId,
    signerId: signerId || entityId, // Use entityId as signerId if not provided
    jurisdiction: 'browservm',
    isActive: true,
  });

  // Update tab when props change
  $: {
    tab.set({
      id: tabId,
      title: entityName || entityId.slice(0, 12) + '...',
      entityId,
      signerId: signerId || entityId,
      jurisdiction: 'browservm',
      isActive: true,
    });
  }
</script>

<div class="entity-panel-wrapper">
  <EntityPanel tab={$tab} isLast={false} />
</div>

<style>
  .entity-panel-wrapper {
    width: 100%;
    height: 100%;
    overflow: auto;
    background: #1e1e1e;
  }

  /* Override EntityPanel styles for Dockview context */
  .entity-panel-wrapper :global(.entity-panel) {
    border-right: none;
    min-width: unset;
    height: 100%;
  }
</style>
