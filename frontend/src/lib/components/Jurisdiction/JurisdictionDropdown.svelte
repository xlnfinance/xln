<script lang="ts">
  /**
   * JurisdictionDropdown - J-machine selector (time-aware)
   * Uses unified Dropdown base component.
   */
  import { createEventDispatcher } from 'svelte';
  import { getEntityEnv, hasEntityEnvContext } from '$lib/view/components/entity/shared/EntityEnvContext';
  import Dropdown from '$lib/components/UI/Dropdown.svelte';
  import { writable } from 'svelte/store';

  export let selected: string | null = null;
  export let allowAll: boolean = true;
  export let allLabel: string = 'All Jurisdictions';
  export let allowAdd: boolean = false;

  let isOpen = false;
  const dispatch = createEventDispatcher();

  // Time-aware env from context (fallback to empty)
  const entityEnv = hasEntityEnvContext() ? getEntityEnv() : null;
  const contextEnv = entityEnv?.env;
  const fallbackEnv = writable<any>(null);
  $: activeEnv = contextEnv ? $contextEnv : $fallbackEnv;

  // Derive jurisdictions from current env
  $: jurisdictions = (() => {
    const env = activeEnv;
    if (!env?.jReplicas) return [];
    if (env.jReplicas instanceof Map) {
      return Array.from(env.jReplicas.values());
    }
    if (Array.isArray(env.jReplicas)) {
      return env.jReplicas;
    }
    return Object.values(env.jReplicas || {});
  })();

  function handleSelect(name: string | null) {
    selected = name;
    dispatch('select', { selected: name });
    isOpen = false;
  }

  function handleAdd() {
    if (!allowAdd) return;
    dispatch('addJurisdiction', { selected });
    isOpen = false;
  }

  $: displayText = selected
    ? selected
    : (allowAll ? allLabel : (jurisdictions[0]?.name || 'Select Jurisdiction'));

  $: canAdd = allowAdd && !!activeEnv;
</script>

<Dropdown bind:open={isOpen} minWidth={200} maxWidth={320}>
  <span slot="trigger" class="trigger-content">
    <span class="trigger-icon">⚖️</span>
    <span class="trigger-text">{displayText}</span>
    <span class="trigger-arrow" class:open={isOpen}>▼</span>
  </span>

  <div slot="menu" class="menu-content">
    {#if allowAll}
      <button
        class="menu-item"
        class:selected={!selected}
        on:click={() => handleSelect(null)}
      >
        {allLabel}
      </button>
      <div class="menu-divider"></div>
    {/if}

    {#if jurisdictions.length === 0}
      <div class="empty-state">No jurisdictions</div>
    {:else}
      {#each jurisdictions as j (j.name)}
        <button
          class="menu-item"
          class:selected={selected === j.name}
          on:click={() => handleSelect(j.name)}
        >
          <span class="menu-label">{j.name}</span>
          {#if j.blockNumber !== undefined}
            <span class="menu-meta">#{j.blockNumber.toString()}</span>
          {/if}
        </button>
      {/each}
    {/if}

    {#if canAdd}
      <div class="menu-divider"></div>
      <button class="menu-item add-item" on:click={handleAdd}>
        <span class="menu-label">+ Add Jurisdiction</span>
      </button>
    {/if}
  </div>
</Dropdown>

<style>
  .trigger-content {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
  }

  .trigger-icon {
    font-size: 14px;
    flex-shrink: 0;
  }

  .trigger-text {
    flex: 1;
    text-align: left;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .trigger-arrow {
    color: #888;
    font-size: 10px;
    transition: transform 0.2s;
    flex-shrink: 0;
  }

  .trigger-arrow.open {
    transform: rotate(180deg);
  }

  .menu-content {
    padding: 4px;
  }

  .menu-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 8px 12px;
    background: transparent;
    border: none;
    border-radius: 6px;
    color: #e1e1e1;
    font-size: 13px;
    cursor: pointer;
    transition: background 0.12s;
    text-align: left;
  }

  .menu-item:hover {
    background: rgba(255, 255, 255, 0.06);
  }

  .menu-item.selected {
    background: rgba(0, 122, 255, 0.18);
  }

  .menu-label {
    flex: 1;
  }

  .menu-meta {
    font-size: 11px;
    color: #7aa8ff;
  }

  .menu-divider {
    height: 1px;
    background: #333;
    margin: 4px 8px;
  }

  .add-item {
    color: #7aa8ff;
  }

  .empty-state {
    padding: 12px;
    text-align: center;
    color: #666;
    font-size: 12px;
  }
</style>
