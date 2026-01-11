<script lang="ts">
  /**
   * RuntimeDropdown - Runtime selector (local + remote)
   * Uses unified Dropdown base component.
   */
  import { createEventDispatcher } from 'svelte';
  import Dropdown from '$lib/components/UI/Dropdown.svelte';
  import { activeVault, allVaults, vaultOperations } from '$lib/stores/vaultStore';

  export let allowAdd = false;
  export let addLabel = '+ Add Runtime';

  let isOpen = false;
  const dispatch = createEventDispatcher();

  $: vaultEntries = $allVaults;
  $: currentVault = $activeVault;

  function selectRuntime(id: string) {
    vaultOperations.selectVault(id);
    isOpen = false;
  }

  function handleAddRuntime() {
    if (!allowAdd) return;
    dispatch('addRuntime');
    isOpen = false;
  }

  function runtimeLabel(vault: any): string {
    if (!vault) return allowAdd ? 'Add Runtime' : 'Select Runtime';
    return vault.id || 'Runtime';
  }
</script>

<Dropdown bind:open={isOpen} minWidth={180} maxWidth={260}>
  <span slot="trigger" class="trigger-content">
    <span class="trigger-icon">🧭</span>
    <span class="trigger-text">{runtimeLabel(currentVault)}</span>
    <span class="trigger-arrow" class:open={isOpen}>▼</span>
  </span>

  <div slot="menu" class="menu-content">
    {#if vaultEntries.length === 0}
      <div class="empty-state">No runtimes yet</div>
    {:else}
      {#each vaultEntries as vault (vault.id)}
        <button
          class="menu-item"
          class:selected={vault.id === currentVault?.id}
          on:click={() => selectRuntime(vault.id)}
        >
          <span class="menu-label">{vault.id}</span>
          <span class="menu-meta">{vault.signers.length} signers</span>
        </button>
      {/each}
    {/if}

    {#if allowAdd}
      <div class="menu-divider"></div>
      <button class="menu-item add-item" on:click={handleAddRuntime}>
        <span class="menu-label">{addLabel}</span>
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

  .trigger-meta {
    font-size: 10px;
    color: #6fdc8b;
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
