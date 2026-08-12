<script lang="ts">
  import type { ComponentType } from 'svelte';
  import { createEventDispatcher } from 'svelte';
  import { ChevronDown, Menu } from 'lucide-svelte';

  type RailTab = {
    id: string;
    icon: ComponentType;
    label: string;
  };

  export let tabs: RailTab[] = [];
  export let activeTab = '';
  export let ariaLabel = 'Account workspace';
  export let primaryTabIds: string[] = [];

  const dispatch = createEventDispatcher<{ select: string }>();

  let mobileFoldOpen = false;

  $: primaryTabs = tabs.filter((tab) => primaryTabIds.includes(tab.id));
  $: secondaryTabs = tabs.filter((tab) => !primaryTabIds.includes(tab.id));
  $: openTab = primaryTabs.find((tab) => tab.id === 'open') ?? null;
  $: primaryGridTabs = primaryTabs.filter((tab) => tab.id !== 'open');
  $: activeSecondaryTab = secondaryTabs.find((tab) => tab.id === activeTab) ?? null;
  $: activeMobileTab = tabs.find((tab) => tab.id === activeTab)
    ?? activeSecondaryTab
    ?? openTab
    ?? primaryGridTabs[0]
    ?? tabs[0]
    ?? null;

  function select(id: string): void {
    dispatch('select', id);
  }

  function selectMobile(id: string): void {
    mobileFoldOpen = false;
    select(id);
  }
</script>

<div class="workspace-rail">
  <nav class="account-workspace-tabs desktop-rail" aria-label={ariaLabel}>
    {#each tabs as tab}
      <button
        type="button"
        class="account-workspace-tab"
        data-testid={`account-workspace-tab-${tab.id}`}
        class:active={activeTab === tab.id}
        on:click={() => select(tab.id)}
      >
        <svelte:component this={tab.icon} size={14} />
        <span>{tab.label}</span>
      </button>
    {/each}
  </nav>

  <div class="mobile-rail" aria-label={ariaLabel}>
    {#if activeMobileTab}
      <details class="mobile-fold mobile-select" bind:open={mobileFoldOpen}>
        <summary class="mobile-fold-summary mobile-select-summary" data-testid="account-workspace-mobile-toggle">
          <span class="mobile-select-current">
            <svelte:component this={activeMobileTab.icon} size={15} />
            <span>{activeMobileTab.label}</span>
          </span>
          <span class="mobile-select-actions">
            <span class="mobile-select-menu-icon">
              <Menu size={15} />
            </span>
            <span class="mobile-fold-icon">
              <ChevronDown size={15} />
            </span>
          </span>
        </summary>

        <div class="mobile-tab-grid secondary-grid mobile-select-grid">
          {#each tabs as tab}
            <button
              type="button"
              class="account-workspace-tab mobile-tab secondary-tab"
              data-testid={`account-workspace-tab-${tab.id}`}
              class:active={activeTab === tab.id}
              on:click={() => selectMobile(tab.id)}
            >
              <svelte:component this={tab.icon} size={14} />
              <span>{tab.label}</span>
            </button>
          {/each}
        </div>
      </details>
    {/if}
  </div>
</div>

<style>
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

  .mobile-rail {
    display: none;
  }

  @media (max-width: 760px) {
    .desktop-rail {
      display: none;
    }

    .mobile-rail {
      display: block;
      margin-top: var(--space-3, 12px);
      min-width: 0;
    }

    .mobile-tab-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
    }

    .mobile-tab {
      justify-content: center;
      min-width: 0;
      min-height: 40px;
      padding: 0 12px;
      border-radius: 12px;
      font-size: 10px;
      letter-spacing: 0.04em;
    }

    .mobile-fold {
      border: 1px solid color-mix(in srgb, var(--theme-border, #27272a) 46%, transparent);
      border-radius: 14px;
      background: color-mix(in srgb, var(--theme-surface, var(--theme-card-bg, #18181b)) 70%, transparent);
      overflow: hidden;
    }

    .mobile-fold-summary {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      min-height: 42px;
      padding: 0 14px;
      cursor: pointer;
      list-style: none;
      color: var(--theme-text-primary, #e4e4e7);
      box-sizing: border-box;
    }

    .mobile-select-summary {
      min-width: 0;
    }

    .mobile-fold-summary::-webkit-details-marker {
      display: none;
    }

    .mobile-select-current {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.01em;
      text-transform: none;
      color: var(--theme-text-primary, #e4e4e7);
    }

    .mobile-select-current span:last-child {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .mobile-select-actions {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      flex-shrink: 0;
    }

    .mobile-select-menu-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: var(--theme-text-secondary, #a1a1aa);
    }

    .mobile-fold-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: var(--theme-text-secondary, #a1a1aa);
      flex-shrink: 0;
      transition: transform 0.15s ease;
    }

    .mobile-select[open] .mobile-fold-icon {
      transform: rotate(180deg);
    }

    .secondary-grid {
      padding: 0 8px 8px;
    }

    .mobile-select-grid {
      padding-top: 8px;
    }

    .secondary-tab {
      background: color-mix(in srgb, var(--theme-input-bg, #09090b) 58%, transparent);
      border-radius: 12px;
    }
  }

  @media (max-width: 460px) {
    .mobile-tab-grid {
      grid-template-columns: 1fr 1fr;
      gap: 6px;
    }

    .mobile-tab {
      min-height: 38px;
      padding: 0 10px;
      font-size: 9.5px;
    }
  }
</style>
