<script lang="ts">
  import RuntimeStateCard from '../shared/RuntimeStateCard.svelte';
  import type { Tab } from '$lib/types/ui';
  import ContextSwitcher from './ContextSwitcher.svelte';

  export let tab: Tab | null = null;
  export let userModeHeader = false;
  export let resettingEverything = false;
  export let allowHeaderAddRuntime = false;
  export let allowHeaderDeleteRuntime = false;
  export let headerRuntimeAddLabel = '+ Add Runtime';
  export let handleResetEverything: () => void | Promise<void> = () => {};
  export let handleHeaderAddRuntime: () => void = () => {};
  export let handleHeaderDeleteRuntime: (event: CustomEvent<{ runtimeId: string }>) => void = () => {};
  export let handleHeaderAddJurisdiction: () => void = () => {};
  export let handleHeaderAddEntity: () => void = () => {};
  export let handleEntitySelect: (event: CustomEvent) => void = () => {};
</script>

<div class="empty-state">
  {#if userModeHeader && tab}
    <div class="empty-context-switcher">
      <ContextSwitcher
        {tab}
        allowAddRuntime={allowHeaderAddRuntime}
        allowDeleteRuntime={allowHeaderDeleteRuntime}
        allowAddJurisdiction={true}
        allowAddEntity={true}
        addRuntimeLabel={headerRuntimeAddLabel}
        on:addRuntime={handleHeaderAddRuntime}
        on:deleteRuntime={handleHeaderDeleteRuntime}
        on:addJurisdiction={handleHeaderAddJurisdiction}
        on:addEntity={handleHeaderAddEntity}
        on:entitySelect={handleEntitySelect}
      />
    </div>
  {/if}
  <RuntimeStateCard
    compact={true}
    title="Select Entity"
    description={userModeHeader ? 'Choose an entity from the context menu.' : 'Choose an entity from the header dropdown.'}
    status={null}
    actionLabel={resettingEverything ? 'Resetting...' : 'Reset local data'}
    actionDisabled={resettingEverything}
    onAction={handleResetEverything}
    testId="entity-empty-card"
  />
</div>

<style>
  .empty-state {
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 14px;
    height: 300px;
    align-items: center;
  }

  .empty-context-switcher {
    width: min(360px, 100%);
  }
</style>
