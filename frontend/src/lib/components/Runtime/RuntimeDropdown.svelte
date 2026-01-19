<script lang="ts">
  /**
   * RuntimeDropdown - Runtime selector (local + remote)
   * Uses unified Dropdown base component.
   */
  import { createEventDispatcher } from 'svelte';
  import Dropdown from '$lib/components/UI/Dropdown.svelte';
  import { activeRuntime, allRuntimes, vaultOperations } from '$lib/stores/vaultStore';

  export let allowAdd = false;
  export let allowDelete = false;
  export let addLabel = '+ Add Runtime';

  let isOpen = false;
  const dispatch = createEventDispatcher();

  $: runtimeEntries = $allRuntimes;
  $: currentRuntime = $activeRuntime;

  function selectRuntime(id: string) {
    vaultOperations.selectRuntime(id);
    isOpen = false;
  }

  function handleAddRuntime() {
    if (!allowAdd) return;
    dispatch('addRuntime');
    isOpen = false;
  }

  function handleDeleteRuntime(event: MouseEvent, runtimeId: string) {
    event.stopPropagation(); // Don't trigger select
    dispatch('deleteRuntime', { runtimeId });
    isOpen = false;
  }

  function runtimeLabel(runtime: any): string {
    if (!runtime) return allowAdd ? 'Add Runtime' : 'Select Runtime';
    const signerAddress = runtime.signers?.[0]?.address;
    if (!signerAddress) return runtime.label || 'Runtime';

    // Format: 0xABCD...1234 (Label)
    const truncated = signerAddress.slice(0, 6) + '...' + signerAddress.slice(-4);
    return `${truncated} (${runtime.label})`;
  }
</script>

<Dropdown bind:open={isOpen} minWidth={180} maxWidth={260}>
  <span slot="trigger" class="trigger-content">
    <span class="trigger-icon">🧭</span>
    <span class="trigger-text">{runtimeLabel(currentRuntime)}</span>
    <span class="trigger-arrow" class:open={isOpen}>▼</span>
  </span>

  <div slot="menu" class="menu-content">
    {#if runtimeEntries.length === 0}
      <div class="empty-state">No runtimes yet</div>
    {:else}
      {#each runtimeEntries as runtime (runtime.id)}
        {@const signerAddr = runtime.signers?.[0]?.address}
        {@const displayName = signerAddr
          ? `${signerAddr.slice(0, 6)}...${signerAddr.slice(-4)} (${runtime.label})`
          : runtime.label}
        <button
          class="menu-item"
          class:selected={runtime.id === currentRuntime?.id}
          on:click={() => selectRuntime(runtime.id)}
        >
          <span class="menu-label" title={signerAddr}>{displayName}</span>
          <span class="menu-meta">{runtime.signers.length} signers</span>
          {#if allowDelete && runtimeEntries.length > 1}
            <button
              class="delete-btn"
              on:click={(e) => handleDeleteRuntime(e, runtime.id)}
              title="Delete runtime"
            >
              ×
            </button>
          {/if}
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
    position: relative;
  }

  .menu-item:hover {
    background: rgba(255, 255, 255, 0.06);
  }

  .menu-item.selected {
    background: rgba(0, 122, 255, 0.18);
  }

  .menu-label {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .menu-meta {
    font-size: 11px;
    color: #7aa8ff;
    margin-right: 4px;
  }

  .delete-btn {
    width: 20px;
    height: 20px;
    padding: 0;
    background: rgba(255, 59, 48, 0.1);
    border: 1px solid rgba(255, 59, 48, 0.3);
    border-radius: 3px;
    color: rgba(255, 59, 48, 0.8);
    font-size: 16px;
    line-height: 1;
    cursor: pointer;
    opacity: 0;
    transition: all 0.15s;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }

  .menu-item:hover .delete-btn {
    opacity: 1;
  }

  .delete-btn:hover {
    background: rgba(255, 59, 48, 0.25);
    border-color: rgba(255, 59, 48, 0.6);
    color: rgba(255, 59, 48, 1);
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
