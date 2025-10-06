<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { xlnFunctions } from '../../stores/xlnStore';
  import type { EntityReplica, AccountMachine } from '$lib/types/ui';

  export let replica: EntityReplica;
  export let selectedAccountId: string | null = null;

  const dispatch = createEventDispatcher();

  // Get available accounts from entity state
  $: availableAccounts = Array.from(replica?.state?.accounts?.entries() || [] as [string, AccountMachine][])
    .map(([counterpartyId, account]: [string, AccountMachine]) => ({
      id: counterpartyId,
      account,
      entityNumber: $xlnFunctions.getEntityNumber(counterpartyId),
      hasPending: account.mempool.length > 0,
      status: account.mempool.length > 0 ? 'pending' : 'synced'
    }));

  function handleAccountSelect(event: Event) {
    const target = event.target as HTMLSelectElement;
    const accountId = target.value;

    if (accountId && accountId !== '') {
      dispatch('accountSelect', { accountId });
    } else {
      dispatch('accountSelect', { accountId: null }); // Clear selection
    }
  }
</script>

<select
  class="account-dropdown"
  value={selectedAccountId || ''}
  on:change={handleAccountSelect}
  disabled={false}
>
  {#if availableAccounts.length === 0}
    <option value="">No accounts available</option>
  {:else}
    <option value="">Select Account...</option>
    {#each availableAccounts as acc (acc.id)}
      <option value={acc.id}>
        Entity #{acc.entityNumber}
        {acc.hasPending ? `(${acc.account.mempool.length} pending)` : '(Synced)'}
      </option>
    {/each}
  {/if}
</select>

<style>
  .account-dropdown {
    background: #2d2d2d;
    border: 1px solid #3e3e3e;
    border-radius: 4px;
    color: #e1e1e1;
    padding: 8px 12px;
    font-size: 0.9em;
    min-width: 200px;
    cursor: pointer;
    outline: none;
    -webkit-appearance: none;
    appearance: none;
  }

  .account-dropdown:hover {
    border-color: #0084ff;
    background: #333;
  }

  .account-dropdown:focus {
    border-color: #0084ff;
    box-shadow: 0 0 0 2px rgba(0, 132, 255, 0.2);
  }

  /* Mobile-first responsive design */
  @media (max-width: 768px) {
    .account-dropdown {
      width: 100%;
      min-width: unset;
      font-size: 16px; /* Prevent zoom on iOS */
    }
  }
</style>