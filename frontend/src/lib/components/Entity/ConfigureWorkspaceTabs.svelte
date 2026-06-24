<script lang="ts">
  import type { ConfigureWorkspaceTab } from './entity-panel-routing';

  type ConfigureTabConfig = {
    id: ConfigureWorkspaceTab;
    label: string;
    testId: string;
    danger?: boolean;
  };

  export let activeTab: ConfigureWorkspaceTab;
  export let selectTab: (tab: ConfigureWorkspaceTab) => void;

  const tabs: ConfigureTabConfig[] = [
    { id: 'extend-credit', label: 'Extend Credit', testId: 'configure-tab-extend-credit' },
    { id: 'request-credit', label: 'Request Credit', testId: 'configure-tab-request-credit' },
    { id: 'collateral', label: 'Request Collateral', testId: 'configure-tab-collateral' },
    { id: 'token', label: 'Add Token', testId: 'configure-tab-token' },
    { id: 'dispute', label: 'Dispute', testId: 'configure-tab-dispute', danger: true },
  ];
</script>

<nav class="configure-tabs" aria-label="Account manage workspace">
  {#each tabs as tab}
    <button
      class="configure-tab"
      class:active={activeTab === tab.id}
      class:danger={tab.danger}
      data-testid={tab.testId}
      on:click={() => selectTab(tab.id)}
    >
      {tab.label}
    </button>
  {/each}
</nav>

<style>
  .configure-tabs {
    display: flex;
    gap: 8px;
    margin-bottom: 10px;
    flex-wrap: wrap;
  }

  .configure-tab {
    padding: 8px 12px;
    border: 1px solid color-mix(in srgb, var(--theme-border, #27272a) 75%, transparent);
    border-radius: 8px;
    background: color-mix(in srgb, var(--theme-input-bg, #09090b) 88%, transparent);
    color: var(--theme-text-secondary, #a1a1aa);
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .configure-tab:hover {
    color: var(--theme-text-primary, #e4e4e7);
    border-color: color-mix(in srgb, var(--theme-border, #27272a) 85%, white 15%);
  }

  .configure-tab.active {
    color: var(--theme-accent, #fbbf24);
    border-color: color-mix(in srgb, var(--theme-accent, #fbbf24) 65%, transparent);
    background: color-mix(in srgb, var(--theme-accent, #fbbf24) 10%, transparent);
  }

  .configure-tab.danger {
    color: #fca5a5;
    border-color: rgba(239, 68, 68, 0.4);
  }

  .configure-tab.danger:hover,
  .configure-tab.danger.active {
    color: #fecaca;
    border-color: rgba(239, 68, 68, 0.8);
    background: rgba(127, 29, 29, 0.25);
  }
</style>
