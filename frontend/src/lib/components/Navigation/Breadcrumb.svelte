<script lang="ts">
  export let label: string;
  export let items: Array<{id: string, label: string, count?: number}>;
  export let selected: string | null;
  export let onSelect: (id: string) => void;
  export let onNew: (() => void) | null = null;
  export let disabled: boolean = false;

  let showMenu = false;

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
  <button
    class="breadcrumb-trigger"
    disabled={disabled}
    on:click={() => !disabled && (showMenu = !showMenu)}
  >
    {label}: {items.find(i => i.id === selected)?.label || 'None'} ▼
  </button>

  {#if showMenu && !disabled}
    <div class="breadcrumb-menu">
      {#each items as item}
        <div
          class="breadcrumb-item"
          class:selected={item.id === selected}
          on:click={() => handleSelect(item.id)}
          on:keydown={(e) => e.key === 'Enter' && handleSelect(item.id)}
          role="button"
          tabindex="0"
        >
          {item.label}
          {#if item.count !== undefined}
            <span class="count">({item.count})</span>
          {/if}
        </div>
      {/each}

      {#if onNew}
        <div class="breadcrumb-divider"></div>
        <div
          class="breadcrumb-item new"
          on:click={handleNew}
          on:keydown={(e) => e.key === 'Enter' && handleNew()}
          role="button"
          tabindex="0"
        >
          + New {label}
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .breadcrumb-dropdown {
    position: relative;
    height: 32px;
    display: flex;
    align-items: center;
  }

  .breadcrumb-dropdown.disabled {
    opacity: 0.5;
  }

  .breadcrumb-trigger {
    height: 32px;
    padding: 0 12px;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 4px;
    color: rgba(255, 255, 255, 0.9);
    font-size: 13px;
    font-family: 'SF Mono', monospace;
    cursor: pointer;
    transition: all 0.15s ease;
    white-space: nowrap;
  }

  .breadcrumb-trigger:not(:disabled):hover {
    background: rgba(255, 255, 255, 0.08);
    border-color: rgba(168, 85, 247, 0.3);
  }

  .breadcrumb-trigger:disabled {
    cursor: not-allowed;
  }

  .breadcrumb-menu {
    position: absolute;
    top: 100%;
    left: 0;
    margin-top: 4px;
    min-width: 160px;
    background: rgba(20, 20, 20, 0.95);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 6px;
    padding: 4px;
    z-index: 1000;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  }

  .breadcrumb-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    color: rgba(255, 255, 255, 0.8);
    font-size: 13px;
    font-family: 'SF Mono', monospace;
    border-radius: 4px;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .breadcrumb-item:hover {
    background: rgba(255, 255, 255, 0.08);
    color: rgba(255, 255, 255, 1);
  }

  .breadcrumb-item.selected {
    background: rgba(168, 85, 247, 0.15);
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
    .breadcrumb-trigger {
      font-size: 11px;
      padding: 0 8px;
      height: 28px;
    }

    .breadcrumb-dropdown {
      height: 28px;
    }

    .breadcrumb-item {
      font-size: 12px;
      padding: 5px 8px;
    }
  }
</style>
