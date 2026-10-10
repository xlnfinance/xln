<script lang="ts">
  import type { ComponentType } from 'svelte';
  import { createEventDispatcher } from 'svelte';
  import { walletHelp } from '#lib/utils/ui/walletHelp.ts';

  type RailTab = {
    id: string;
    icon: ComponentType;
    label: string;
  };

  export let tabs: RailTab[] = [];
  export let activeTab = '';
  export let ariaLabel = 'Account workspace';

  const dispatch = createEventDispatcher<{ select: string }>();

  function select(id: string): void {
    dispatch('select', id);
  }

</script>

<div class="workspace-rail">
  <nav class="account-workspace-tabs" aria-label={ariaLabel}>
    {#each tabs as tab}
      <button
        type="button"
        class="account-workspace-tab"
        data-testid={`account-workspace-tab-${tab.id}`}
        class:active={activeTab === tab.id}
        title={walletHelp[tab.id]}
        on:click={() => select(tab.id)}
      >
        <svelte:component this={tab.icon} size={14} />
        <span>{tab.label}</span>
      </button>
    {/each}
  </nav>

  {#if walletHelp[activeTab]}
    <details class="feature-help">
      <summary>How this works</summary>
      <p>{walletHelp[activeTab]}</p>
    </details>
  {/if}
</div>

<style>
  .feature-help { margin: 8px 0; font-size: 12px; color: var(--theme-text-secondary); }
  .feature-help summary { cursor: pointer; }
  .feature-help p { line-height: 1.5; max-width: 70ch; }
  .workspace-rail {
    min-width: 0;
  }

  .account-workspace-tabs {
    display: flex;
    gap: 4px;
    margin-top: var(--space-3, 12px);
    padding: 0 0 2px;
    border: none;
    border-bottom: 1px solid color-mix(in srgb, var(--theme-card-border, var(--theme-border, #27272a)) 56%, transparent);
    border-radius: 0;
    background: transparent;
    overflow-x: auto;
  }

  .account-workspace-tabs::-webkit-scrollbar {
    display: none;
  }

  .account-workspace-tab {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    min-height: 40px;
    padding: 8px 12px;
    border: 1px solid transparent;
    border-radius: 10px 10px 0 0;
    background: transparent;
    color: var(--theme-text-secondary, #a1a1aa);
    font-size: 12px;
    font-weight: 650;
    letter-spacing: 0.01em;
    text-transform: none;
    white-space: nowrap;
    cursor: pointer;
    transition: all 0.15s ease;
    touch-action: manipulation;
  }

  .account-workspace-tab:hover {
    color: var(--theme-text-primary, #e4e4e7);
    border-color: transparent;
    background: color-mix(in srgb, var(--theme-surface-hover, var(--theme-card-bg, #1c1c20)) 58%, transparent);
  }

  .account-workspace-tab.active {
    color: var(--theme-text-primary, #e4e4e7);
    border-color: color-mix(in srgb, var(--theme-card-border, var(--theme-border, #27272a)) 50%, transparent);
    border-bottom-color: transparent;
    background:
      linear-gradient(180deg, color-mix(in srgb, var(--theme-accent, #fbbf24) 8%, transparent), transparent),
      color-mix(in srgb, var(--theme-card-bg, var(--theme-surface, #18181b)) 94%, transparent);
    box-shadow: inset 0 2px 0 color-mix(in srgb, var(--theme-accent, #fbbf24) 78%, transparent);
  }

  @media (max-width: 760px) {
    .account-workspace-tabs {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 6px;
      overflow: visible;
    }
    .account-workspace-tab {
      min-width: 0;
      min-height: 44px;
      padding: 8px 4px;
      border-radius: 10px;
      font-size: 11px;
      white-space: normal;
      gap: 4px;
    }
  }
</style>
