<script lang="ts">
  import RuntimeStateCard from '../shared/RuntimeStateCard.svelte';

  export let userModeHeader = false;
  export let resettingEverything = false;
  export let handleResetEverything: () => void | Promise<void> = () => {};
</script>

<div class="empty-state">
  <RuntimeStateCard
    compact={true}
    title="Select Entity"
    description={userModeHeader ? 'Choose an entity from the active context.' : 'Choose an entity from the header dropdown.'}
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
    justify-content: center;
    height: 300px;
    align-items: center;
  }
</style>
