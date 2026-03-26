<script lang="ts">
  import type { ComponentType } from 'svelte';
  import { createEventDispatcher } from 'svelte';
  import { ChevronDown, ChevronUp } from 'lucide-svelte';

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
  $: if (activeSecondaryTab) {
    mobileFoldOpen = true;
  }

  function select(id: string): void {
    dispatch('select', id);
  }
</script>

<div class="workspace-rail">
  <nav class="account-workspace-tabs desktop-rail" aria-label={ariaLabel}>
    {#each tabs as tab}
      <button
        type="button"
        class="account-workspace-tab"
        class:active={activeTab === tab.id}
        on:click={() => select(tab.id)}
      >
        <svelte:component this={tab.icon} size={14} />
        <span>{tab.label}</span>
      </button>
    {/each}
  </nav>

  <div class="mobile-rail" aria-label={ariaLabel}>
    {#if openTab}
      <button
        type="button"
        class="account-workspace-tab mobile-tab mobile-open-tab"
        class:active={activeTab === openTab.id}
        on:click={() => select(openTab.id)}
      >
        <svelte:component this={openTab.icon} size={14} />
        <span>{openTab.label}</span>
      </button>
    {/if}

    {#if primaryGridTabs.length > 0}
      <div class="mobile-tab-grid">
        {#each primaryGridTabs as tab}
          <button
            type="button"
            class="account-workspace-tab mobile-tab"
            class:active={activeTab === tab.id}
            on:click={() => select(tab.id)}
          >
            <svelte:component this={tab.icon} size={14} />
            <span>{tab.label}</span>
          </button>
        {/each}
      </div>
    {/if}

    {#if secondaryTabs.length > 0}
      <details class="mobile-fold" bind:open={mobileFoldOpen}>
        <summary class="mobile-fold-summary">
          <span class="mobile-fold-copy">
            <span class="mobile-fold-label">More</span>
            <span class="mobile-fold-meta">
              {#if activeSecondaryTab}
                Active: {activeSecondaryTab.label}
              {:else}
                {secondaryTabs.length} tools
              {/if}
            </span>
          </span>
          <span class="mobile-fold-icon">
            {#if mobileFoldOpen}
              <ChevronUp size={15} />
            {:else}
              <ChevronDown size={15} />
            {/if}
          </span>
        </summary>

        <div class="mobile-tab-grid secondary-grid">
          {#each secondaryTabs as tab}
            <button
              type="button"
              class="account-workspace-tab mobile-tab secondary-tab"
              class:active={activeTab === tab.id}
              on:click={() => select(tab.id)}
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

  .mobile-rail {
    display: none;
  }

  @media (max-width: 760px) {
    .desktop-rail {
      display: none;
    }

    .mobile-rail {
      display: grid;
      gap: 8px;
      margin-top: var(--space-3, 12px);
    }

    .mobile-open-tab {
      width: 100%;
      justify-content: center;
      min-height: 42px;
      padding: 0 14px;
      border-radius: 14px;
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

    .mobile-fold-summary::-webkit-details-marker {
      display: none;
    }

    .mobile-fold-copy {
      display: grid;
      gap: 2px;
      min-width: 0;
    }

    .mobile-fold-label {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.05em;
      text-transform: uppercase;
    }

    .mobile-fold-meta {
      font-size: 10px;
      color: var(--theme-text-muted, #71717a);
    }

    .mobile-fold-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: var(--theme-text-secondary, #a1a1aa);
      flex-shrink: 0;
    }

    .secondary-grid {
      padding: 0 8px 8px;
    }

    .secondary-tab {
      background: color-mix(in srgb, var(--theme-input-bg, #09090b) 58%, transparent);
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
