<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { xlnFunctions } from '../../stores/xlnStore';
  import type { EntityReplica, AccountMachine } from '$lib/types/ui';
  import { ChevronDown } from 'lucide-svelte';

  export let replica: EntityReplica;
  export let selectedAccountId: string | null = null;

  const dispatch = createEventDispatcher();

  let isOpen = false;

  // Get available accounts from entity state
  $: availableAccounts = Array.from(replica?.state?.accounts?.entries() || [] as [string, AccountMachine][])
    .map(([counterpartyId, account]: [string, AccountMachine]) => ({
      id: counterpartyId,
      account,
      entityShortId: $xlnFunctions?.getEntityShortId?.(counterpartyId) || counterpartyId.slice(-4),
      avatarUrl: $xlnFunctions?.generateEntityAvatar?.(counterpartyId) || '',
      status: account.mempool?.length > 0 ? 'pending' : 'synced'
    }));

  $: selectedAccount = availableAccounts.find(acc => acc.id === selectedAccountId);
  $: displayText = selectedAccount
    ? `Entity #${selectedAccount.entityShortId} (${selectedAccount.status})`
    : 'Select Account...';

  function selectAccount(accountId: string) {
    dispatch('accountSelect', { accountId });
    isOpen = false;
  }

  function handleClickOutside(event: MouseEvent) {
    const target = event.target as HTMLElement;
    if (!target.closest('.account-dropdown-custom')) {
      isOpen = false;
    }
  }
</script>

<svelte:window on:click={handleClickOutside} />

<div class="account-dropdown-custom" class:open={isOpen}>
  <button
    class="dropdown-trigger"
    on:click|stopPropagation={() => isOpen = !isOpen}
  >
    {#if selectedAccount?.avatarUrl}
      <img src={selectedAccount.avatarUrl} alt="" class="account-avatar" />
    {/if}
    <span class="dropdown-text">{displayText}</span>
    <ChevronDown size={14} class="chevron" />
  </button>

  {#if isOpen}
    <div class="dropdown-menu">
      {#if availableAccounts.length === 0}
        <div class="empty-state">No accounts available</div>
      {:else}
        {#each availableAccounts as acc (acc.id)}
          <button
            class="account-item"
            class:selected={acc.id === selectedAccountId}
            on:click|stopPropagation={() => selectAccount(acc.id)}
          >
            {#if acc.avatarUrl}
              <img src={acc.avatarUrl} alt="" class="account-avatar" />
            {/if}
            <span class="account-name">Entity #{acc.entityShortId}</span>
            <span class="account-status" class:pending={acc.status === 'pending'}>
              {acc.status === 'pending' ? `${acc.account.mempool.length} pending` : 'Synced'}
            </span>
          </button>
        {/each}
      {/if}
    </div>
  {/if}
</div>

<style>
  .account-dropdown-custom {
    position: relative;
    display: inline-block;
  }

  .dropdown-trigger {
    display: flex;
    align-items: center;
    gap: 8px;
    background: #2d2d2d;
    border: 1px solid #3e3e3e;
    border-radius: 6px;
    color: #e1e1e1;
    padding: 8px 12px;
    font-size: 0.9em;
    min-width: 200px;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .dropdown-trigger:hover {
    background: #353535;
    border-color: #4e4e4e;
  }

  .account-avatar {
    width: 24px;
    height: 24px;
    border-radius: 4px;
    flex-shrink: 0;
  }

  .dropdown-text {
    flex: 1;
    text-align: left;
  }

  .dropdown-menu {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    right: 0;
    background: rgba(20, 20, 20, 0.98);
    backdrop-filter: blur(12px);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 6px;
    padding: 4px;
    max-height: 300px;
    overflow-y: auto;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5);
    z-index: 1000;
  }

  .account-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 8px 12px;
    background: transparent;
    border: none;
    border-radius: 4px;
    color: #e1e1e1;
    cursor: pointer;
    transition: background 0.15s ease;
  }

  .account-item:hover {
    background: rgba(255, 255, 255, 0.05);
  }

  .account-item.selected {
    background: rgba(0, 122, 255, 0.15);
  }

  .account-name {
    flex: 1;
    text-align: left;
  }

  .account-status {
    font-size: 0.8em;
    color: #0f8;
    font-weight: 500;
  }

  .account-status.pending {
    color: #fa4;
  }

  .empty-state {
    padding: 16px;
    text-align: center;
    color: #888;
    font-size: 0.85em;
  }

  .chevron {
    flex-shrink: 0;
    opacity: 0.5;
  }
</style>
