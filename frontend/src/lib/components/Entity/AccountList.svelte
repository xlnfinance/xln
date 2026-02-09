<script lang="ts">
  import type { EntityReplica } from '$lib/types/ui';
  import type { AccountKey } from '@xln/runtime/ids';
  import { createEventDispatcher } from 'svelte';
  import { replicas, xlnFunctions } from '../../stores/xlnStore';
  import AccountPreview from './AccountPreview.svelte';

  export let replica: EntityReplica | null;

  const dispatch = createEventDispatcher();

  // Get accounts from entity state - DIRECT references (no shallow copy!)
  // CRITICAL: Don't spread account object - it creates stale snapshot
  $: accounts = (replica?.state?.accounts && replica.state.accounts instanceof Map)
    ? Array.from(replica.state.accounts.entries())
    : [];

  // DEBUG: Log accounts for entity
  $: if (replica && accounts.length > 0) {
    console.log(`[AccountList] Entity ${replica.entityId.slice(0,6)} has ${accounts.length} accounts:`,
      accounts.map(([id]) => id.slice(0,6)));
  }


  // Safety guard for XLN functions

  // Get ALL entities in the system (excluding self) - reactive to accounts changes
  // This will recompute whenever accounts or replicas change
  $: allEntities = replica && $replicas && accounts ? getAllEntities() : [];

  function getAllEntities() {
    if (!replica || !$replicas || !$xlnFunctions) return [];

    const currentEntityId = replica.entityId;
    const existingAccountIds = new Set((replica.state?.accounts && replica.state.accounts instanceof Map) ? Array.from(replica.state.accounts.keys()) : []);

    // Get unique entities from replicas, excluding only current entity
    const entitySet = new Set<string>();
    for (const [replicaKey] of $replicas.entries()) {
      const [entityId] = replicaKey.split(':');
      if (entityId !== currentEntityId) {
        entitySet.add(entityId);
      }
    }

    return Array.from(entitySet).map(entityId => {
      const hasAccount = existingAccountIds.has(entityId as AccountKey);
      return {
        entityId,
        displayName: entityId,
        shortId: entityId,
        hasAccount
      };
    }).sort((a, b) => {
      return a.entityId.localeCompare(b.entityId);
    });
  }

  function selectAccount(event: CustomEvent) {
    // Forward the selection to parent (EntityPanel) for focused navigation
    dispatch('select', event.detail);
  }



</script>

<div class="account-channels" data-testid="account-channels">
  <!-- Account List View (Always show previews, never full panel) -->
  <div class="accounts-list-view">


      {#if accounts.length === 0}
        <div class="no-accounts">
          <p>No accounts established</p>
          <small>Select an entity below to open an account</small>
        </div>
      {:else}
        <div class="scrollable-component accounts-list">
          {#each accounts as [counterpartyId, account] (counterpartyId)}
            <AccountPreview
              {account}
              {counterpartyId}
              entityId={replica?.entityId || ''}
              isSelected={false}
              on:select={selectAccount}
            />
          {/each}
        </div>

    {/if}
  </div>
</div>

<style>
  .account-channels {
    height: 100%;
    display: flex;
    flex-direction: column;
  }

  .accounts-list-view {
    height: 100%;
    display: flex;
    flex-direction: column;
  }

  .scrollable-component {
    flex: 1;
    overflow-y: auto;
    padding: 8px;
  }


  .no-accounts {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 30px 20px;
    text-align: center;
    background: rgba(108, 117, 125, 0.1);
    border: 1px solid rgba(108, 117, 125, 0.3);
    border-radius: 6px;
  }

  .no-accounts p {
    margin: 0 0 8px 0;
    color: #d4d4d4;
  }

  .no-accounts small {
    color: #9d9d9d;
  }

  .accounts-list {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }



</style>
