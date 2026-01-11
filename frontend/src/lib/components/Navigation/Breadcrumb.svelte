<script lang="ts">
  import Dropdown from '$lib/components/UI/Dropdown.svelte';

  export let label: string;
  export let items: Array<{id: string, label: string, count?: number}>;
  export let selected: string | null;
  export let onSelect: (id: string) => void;
  export let onNew: (() => void) | null = null;
  export let disabled: boolean = false;

  let showMenu = false;
  $: if (disabled && showMenu) showMenu = false;

  function handleSelect(id: string) {
    onSelect(id);
    showMenu = false;
  }

  function handleNew() {
    if (onNew) {
      onNew();
      showMenu = false;
    }
  }

</script>

<div class="breadcrumb-dropdown" class:disabled>
  <Dropdown bind:open={showMenu} disabled={disabled} minWidth={160} maxWidth={260}>
    <span slot="trigger" class="breadcrumb-trigger">
      {label}: {items.find(i => i.id === selected)?.label || 'None'}
      <span class="breadcrumb-chevron" class:open={showMenu}>▼</span>
    </span>
    <div slot="menu" class="breadcrumb-menu">
      {#each items as item}
        <button
          class="breadcrumb-item"
          class:selected={item.id === selected}
          on:click={() => handleSelect(item.id)}
        >
          {item.label}
          {#if item.count !== undefined}
            <span class="count">({item.count})</span>
          {/if}
        </button>
      {/each}

      {#if onNew}
        <div class="breadcrumb-divider"></div>
        <button
          class="breadcrumb-item new"
          on:click={handleNew}
        >
          + New {label}
        </button>
      {/if}
    </div>
  </Dropdown>
</div>

<style>
  .breadcrumb-dropdown {
    position: relative;
    height: 32px;
    display: flex;
    align-items: center;
  }

  .breadcrumb-dropdown :global(.dropdown-wrapper) {
    width: auto;
  }

  .breadcrumb-dropdown.disabled {
    opacity: 0.5;
  }

  .breadcrumb-dropdown :global(.dropdown-trigger) {
    padding: 6px 10px;
    border-radius: 6px;
  }

  .breadcrumb-trigger {
    display: flex;
    align-items: center;
    gap: 6px;
    color: rgba(255, 255, 255, 0.9);
    font-size: 13px;
    font-family: 'SF Mono', monospace;
    white-space: nowrap;
  }

  .breadcrumb-chevron {
    font-size: 0.55rem;
    opacity: 0.6;
    transition: transform 0.2s;
  }

  .breadcrumb-chevron.open {
    transform: rotate(180deg);
  }

  .breadcrumb-menu {
    padding: 4px;
  }

  .breadcrumb-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 6px 10px;
    background: transparent;
    border: none;
    color: rgba(255, 255, 255, 0.8);
    font-size: 13px;
    font-family: 'SF Mono', monospace;
    border-radius: 4px;
    cursor: pointer;
    transition: all 0.15s ease;
    text-align: left;
  }

  .breadcrumb-item:hover {
    background: var(--dropdown-item-hover, rgba(255, 255, 255, 0.08));
    color: rgba(255, 255, 255, 1);
  }

  .breadcrumb-item.selected {
    background: var(--dropdown-selected, rgba(168, 85, 247, 0.15));
    color: rgba(168, 85, 247, 1);
  }

  .breadcrumb-item.new {
    color: rgba(0, 255, 136, 0.8);
    border-top: 1px solid rgba(255, 255, 255, 0.05);
    margin-top: 4px;
    padding-top: 8px;
  }

  .breadcrumb-item.new:hover {
    color: rgba(0, 255, 136, 1);
    background: rgba(0, 255, 136, 0.05);
  }

  .count {
    margin-left: auto;
    opacity: 0.6;
    font-size: 0.85em;
  }

  .breadcrumb-divider {
    height: 1px;
    background: rgba(255, 255, 255, 0.05);
    margin: 4px 0;
  }

  /* Mobile responsive */
  @media (max-width: 768px) {
    .breadcrumb-dropdown {
      height: 28px;
    }

    .breadcrumb-item {
      font-size: 12px;
      padding: 5px 8px;
    }
  }
</style>
