<script lang="ts">
  import { AlertTriangle } from 'lucide-svelte';
  import type { EntityReplica, Tab } from '$lib/types/ui';
  import type { EntityPanelJurisdictionView } from './entity-panel-model';
  import JurisdictionDropdown from '$lib/components/Jurisdiction/JurisdictionDropdown.svelte';
  import EntityDropdown from './EntityDropdown.svelte';

  export let tab: Tab;
  export let hideHeader = false;
  export let showJurisdiction = true;
  export let userModeHeader = false;
  export let selectedJurisdictionName: string | null = null;
  export let activeReplicas: Map<string, EntityReplica> | null = null;
  export let entityNames: Map<string, string> = new Map();
  export let jurisdictions: EntityPanelJurisdictionView[] = [];
  export let activeIsLive = true;
  export let handleJurisdictionSelect: (event: CustomEvent<{ selected: string | null }>) => void = () => {};
  export let handleEntitySelect: (event: CustomEvent) => void = () => {};
  export let goToLive: () => void = () => {};
</script>

{#if !hideHeader && !userModeHeader}
  <header class="header" class:user-mode-header={userModeHeader}>
    {#if showJurisdiction}
      <JurisdictionDropdown
        bind:selected={selectedJurisdictionName}
        {jurisdictions}
        on:select={handleJurisdictionSelect}
      />
    {/if}
    <EntityDropdown
      {tab}
      replicasOverride={activeReplicas}
      {entityNames}
      {jurisdictions}
      on:entitySelect={handleEntitySelect}
    />
  </header>
{/if}

{#if !activeIsLive}
  <button type="button" class="history-warning" on:click={goToLive}>
    <AlertTriangle size={14} />
    <span>Viewing historical state. Click to go LIVE.</span>
  </button>
{/if}

<style>
  .header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    background: color-mix(in srgb, var(--theme-card-bg, var(--theme-header-bg, #151316)) 96%, var(--theme-background, #09090b));
    border-bottom: 1px solid color-mix(in srgb, var(--theme-card-border, var(--theme-border, #27272a)) 88%, transparent);
    box-shadow: 0 8px 20px color-mix(in srgb, var(--theme-background, #09090b) 5%, transparent);
    flex-shrink: 0;
  }

  .header.user-mode-header {
    gap: 10px;
    padding: 10px var(--panel-gutter-x);
    background: linear-gradient(
      180deg,
      color-mix(in srgb, var(--theme-card-bg, var(--theme-header-bg, #151316)) 98%, var(--theme-background, #09090b)) 0%,
      color-mix(in srgb, var(--theme-background, #09090b) 100%, transparent) 100%
    );
  }

  .header :global(select),
  .header :global(button),
  .header :global(.dropdown-trigger) {
    background: color-mix(in srgb, var(--theme-input-bg, var(--theme-card-bg, #18181b)) 96%, transparent);
    border: 1px solid color-mix(in srgb, var(--theme-input-border, var(--theme-card-border, #27272a)) 86%, transparent);
    border-radius: 6px;
    color: var(--theme-text-secondary, #a1a1aa);
    font-size: 12px;
    padding: 6px 10px;
    cursor: pointer;
  }

  .history-warning {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 8px;
    background: color-mix(in srgb, var(--theme-accent, #fbbf24) 14%, transparent);
    border-bottom: 1px solid color-mix(in srgb, var(--theme-accent, #fbbf24) 34%, transparent);
    color: var(--theme-accent, #fbbf24);
    font-size: 12px;
    flex-shrink: 0;
    border: 0;
    width: 100%;
    cursor: pointer;
  }

  .history-warning:hover {
    background: color-mix(in srgb, var(--theme-accent, #fbbf24) 18%, transparent);
  }
</style>
