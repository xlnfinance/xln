<script lang="ts">
  /**
   * XLNInspector - Unified RJEA State Inspector
   *
   * Superset panel combining Runtime/Jurisdiction/Entity views in one place.
   * Designed for user-facing mode with BrainVault header integration.
   *
   * @license AGPL-3.0
   * Copyright (C) 2025 XLN Finance
   */

  import type { Writable } from 'svelte/store';
  import { derived, writable } from 'svelte/store';
  import InspectorHeader from './InspectorHeader.svelte';
  import RuntimeTab from './RuntimeTab.svelte';
  import { setEntityEnvContext } from '$lib/view/components/entity/shared/EntityEnvContext';
  import type { Tab } from '$lib/types/ui';

  // Lazy load panels to avoid circular deps
  import JurisdictionPanel from '$lib/view/panels/JurisdictionPanel.svelte';
  import EntityPanel from '$lib/components/Entity/EntityPanel.svelte';

  // Props (Svelte 5 runes)
  interface Props {
    isolatedEnv: Writable<any>;
    isolatedHistory?: Writable<any[]>;
    isolatedTimeIndex?: Writable<number>;
    isolatedIsLive?: Writable<boolean>;
  }

  let {
    isolatedEnv,
    isolatedHistory,
    isolatedTimeIndex,
    isolatedIsLive
  }: Props = $props();

  // Set context for EntityPanel
  setEntityEnvContext({
    isolatedEnv,
    isolatedHistory: isolatedHistory || writable([]),
    isolatedTimeIndex: isolatedTimeIndex || writable(-1),
    isolatedIsLive: isolatedIsLive || writable(true),
  });

  // Active tab state
  let activeTab = $state<'runtime' | 'jurisdiction' | 'entity'>('entity');

  // Entity selection (for entity tab)
  let selectedEntityId = $state<string | null>(null);
  let selectedSignerId = $state<string | null>(null);

  // Derive available entities from env
  const entities = $derived.by(() => {
    const env = $isolatedEnv;
    if (!env?.eReplicas) return [];

    const list: Array<{ entityId: string; signerId: string; name: string }> = [];
    if (env.eReplicas instanceof Map) {
      for (const [key, replica] of env.eReplicas) {
        const [entityId, signerId] = key.split(':');
        const name = replica?.state?.name || entityId.slice(0, 8);
        list.push({ entityId, signerId, name });
      }
    }
    return list;
  });

  // Auto-select first entity when available
  $effect(() => {
    if (entities.length > 0 && !selectedEntityId) {
      const first = entities[0];
      if (first) {
        selectedEntityId = first.entityId;
        selectedSignerId = first.signerId;
      }
    }
  });

  // Create tab object for EntityPanel
  const entityTab: Tab = $derived({
    id: 'inspector-entity',
    title: selectedEntityId ? `Entity ${selectedEntityId.slice(0, 8)}` : 'Entity',
    entityId: selectedEntityId || '',
    signerId: selectedSignerId || '',
    jurisdiction: 'browservm',
    isActive: activeTab === 'entity',
  });

  // Handle entity selection change
  function selectEntity(entityId: string, signerId: string) {
    selectedEntityId = entityId;
    selectedSignerId = signerId;
  }
</script>

<div class="inspector">
  <!-- BrainVault Header -->
  <InspectorHeader {isolatedEnv} />

  <!-- Tab Bar -->
  <div class="tab-bar">
    <button
      class="tab"
      class:active={activeTab === 'runtime'}
      onclick={() => activeTab = 'runtime'}
    >
      Runtime
    </button>
    <button
      class="tab"
      class:active={activeTab === 'jurisdiction'}
      onclick={() => activeTab = 'jurisdiction'}
    >
      Jurisdiction
    </button>
    <button
      class="tab"
      class:active={activeTab === 'entity'}
      onclick={() => activeTab = 'entity'}
    >
      Entity
    </button>
  </div>

  <!-- Tab Content -->
  <div class="tab-content">
    {#if activeTab === 'runtime'}
      <RuntimeTab
        {isolatedEnv}
        {isolatedHistory}
        {isolatedTimeIndex}
      />

    {:else if activeTab === 'jurisdiction'}
      <JurisdictionPanel
        {isolatedEnv}
        {isolatedHistory}
        {isolatedTimeIndex}
      />

    {:else if activeTab === 'entity'}
      <!-- Entity Selector -->
      {#if entities.length > 1}
        <div class="entity-selector">
          <select
            value={selectedEntityId}
            onchange={(e) => {
              const selected = entities.find(ent => ent.entityId === e.currentTarget.value);
              if (selected) {
                selectEntity(selected.entityId, selected.signerId);
              }
            }}
          >
            {#each entities as entity}
              <option value={entity.entityId}>
                {entity.name} ({entity.entityId.slice(0, 8)}...)
              </option>
            {/each}
          </select>
        </div>
      {/if}

      <!-- Entity Panel -->
      {#if selectedEntityId && selectedSignerId}
        <EntityPanel tab={entityTab} isLast={true} />
      {:else}
        <div class="empty-state">
          <p>No entities available</p>
          <p class="hint">Run a scenario or create an entity to view state</p>
        </div>
      {/if}
    {/if}
  </div>
</div>

<style>
  .inspector {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--bg-primary, #0d1117);
    color: var(--text-primary, #e6edf3);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
  }

  .tab-bar {
    display: flex;
    gap: 2px;
    padding: 8px;
    background: var(--bg-secondary, #161b22);
    border-bottom: 1px solid var(--border-primary, #30363d);
  }

  .tab {
    padding: 8px 16px;
    background: transparent;
    border: none;
    border-radius: 6px;
    color: var(--text-secondary, #8b949e);
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .tab:hover {
    background: var(--bg-tertiary, #21262d);
    color: var(--text-primary, #e6edf3);
  }

  .tab.active {
    background: var(--accent-blue, #1f6feb);
    color: white;
  }

  .tab-content {
    flex: 1;
    overflow: auto;
    padding: 0;
  }

  .entity-selector {
    padding: 8px 12px;
    background: var(--bg-secondary, #161b22);
    border-bottom: 1px solid var(--border-primary, #30363d);
  }

  .entity-selector select {
    width: 100%;
    padding: 8px 12px;
    background: var(--bg-tertiary, #21262d);
    border: 1px solid var(--border-primary, #30363d);
    border-radius: 6px;
    color: var(--text-primary, #e6edf3);
    font-size: 13px;
  }

  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 200px;
    color: var(--text-secondary, #8b949e);
    text-align: center;
  }

  .empty-state p {
    margin: 4px 0;
  }

  .empty-state .hint {
    font-size: 12px;
    opacity: 0.7;
  }
</style>
