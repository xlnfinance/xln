<script lang="ts">
  /**
   * AccountDropdown - Account selector for bilateral relationships
   * Uses unified Dropdown base component
   */
  import { createEventDispatcher } from 'svelte';
  import { xlnEnvironment, xlnFunctions, xlnInstance } from '../../stores/xlnStore';
  import type { EntityReplica, AccountMachine } from '$lib/types/ui';
  import Dropdown from '$lib/components/UI/Dropdown.svelte';

  export let replica: EntityReplica | null = null;
  export let selectedAccountId: string | null = null;
  export let allowAdd: boolean = false;

  const dispatch = createEventDispatcher();

  let isOpen = false;

  // Build account list reactively
  interface AccountItem {
    id: string;
    name: string;
    shortId: string;
    avatarUrl: string;
    status: 'synced' | 'pending';
    pendingCount: number;
  }

  $: xlnReady = !!$xlnInstance;
  $: gossipProfiles = $xlnEnvironment?.gossip?.getProfiles?.() || [];
  $: accounts = buildAccountList(replica, xlnReady ? $xlnFunctions : null, gossipProfiles as any[]);

  function buildAccountList(replica: EntityReplica | null, xlnFuncs: any, profiles: any[]): AccountItem[] {
    if (!replica?.state?.accounts) return [];

    const items: AccountItem[] = [];
    const accountsMap = replica.state.accounts;

    for (const [counterpartyId, account] of accountsMap.entries()) {
      const acc = account as AccountMachine;
      const profile = profiles.find((p) => String(p?.entityId || '').toLowerCase() === String(counterpartyId).toLowerCase());
      const profileName = String(profile?.metadata?.name || '').trim();
      items.push({
        id: counterpartyId,
        name: profileName || counterpartyId,
        shortId: counterpartyId,
        avatarUrl: xlnFuncs?.generateEntityAvatar?.(counterpartyId) || '',
        status: acc.mempool?.length > 0 ? 'pending' : 'synced',
        pendingCount: acc.mempool?.length || 0
      });
    }

    return items;
  }

  $: selectedAccount = accounts.find(acc => acc.id === selectedAccountId);

  $: displayText = selectedAccount
    ? `${selectedAccount.name}`
    : accounts.length > 0
      ? `${accounts.length} Account${accounts.length !== 1 ? 's' : ''}`
      : 'Select Account...';

  function selectAccount(accountId: string | null) {
    dispatch('accountSelect', { accountId });
    isOpen = false;
  }

  function handleAddAccount() {
    if (!allowAdd || !replica) return;
    dispatch('addAccount', { replica });
    isOpen = false;
  }
</script>

<Dropdown bind:open={isOpen} minWidth={180} maxWidth={300}>
  <span slot="trigger" class="trigger-content">
    {#if selectedAccount?.avatarUrl}
      <img src={selectedAccount.avatarUrl} alt="" class="trigger-avatar" />
    {/if}
    <span class="trigger-text">{displayText}</span>
    <span class="trigger-arrow" class:open={isOpen}>▼</span>
  </span>

  <div slot="menu" class="menu-content">
    <!-- Back to entity option -->
    {#if selectedAccountId}
      <button class="menu-item back-item" on:click={() => selectAccount(null)}>
        <span class="back-arrow">←</span>
        <span>Back to Entity</span>
      </button>
      <div class="menu-divider"></div>
    {/if}

    <!-- Account list -->
    {#if accounts.length === 0}
      <div class="empty-state">
        <div class="empty-icon">🤝</div>
        <div class="empty-text">No connections yet</div>
        {#if allowAdd}
          <div class="empty-hint">Click "+ Add Account" below to connect</div>
        {/if}
      </div>
    {:else}
      {#each accounts as account (account.id)}
        <button
          class="menu-item account-item"
          class:selected={account.id === selectedAccountId}
          on:click={() => selectAccount(account.id)}
        >
          {#if account.avatarUrl}
            <img src={account.avatarUrl} alt="" class="account-avatar" />
          {/if}
          <span class="account-meta">
            <span class="account-name">{account.name}</span>
            <span class="account-id">{account.id}</span>
          </span>
          <span class="account-status" class:pending={account.status === 'pending'}>
            {account.status === 'pending' ? `${account.pendingCount} pending` : 'Synced'}
          </span>
        </button>
      {/each}
    {/if}

    {#if allowAdd && replica}
      <div class="menu-divider"></div>
      <button class="menu-item add-item" on:click={handleAddAccount}>
        <span class="account-name">+ Add Account</span>
      </button>
    {/if}
  </div>
</Dropdown>

<style>
  .trigger-content {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
  }

  .trigger-avatar {
    width: 20px;
    height: 20px;
    border-radius: 4px;
    flex-shrink: 0;
  }

  .trigger-text {
    flex: 1;
    text-align: left;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .trigger-arrow {
    color: #888;
    font-size: 10px;
    transition: transform 0.2s;
    flex-shrink: 0;
  }

  .trigger-arrow.open {
    transform: rotate(180deg);
  }

  /* Menu */
  .menu-content {
    padding: 4px;
  }

  .menu-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 8px 12px;
    background: transparent;
    border: none;
    border-radius: 4px;
    color: #e1e1e1;
    font-size: 13px;
    cursor: pointer;
    transition: background 0.1s;
    text-align: left;
  }

  .menu-item:hover {
    background: rgba(255, 255, 255, 0.05);
  }

  .menu-item.selected {
    background: rgba(0, 122, 255, 0.15);
  }

  .back-item {
    color: #888;
  }

  .back-arrow {
    font-size: 14px;
  }

  .menu-divider {
    height: 1px;
    background: #333;
    margin: 4px 8px;
  }

  .empty-state {
    padding: 20px 16px;
    text-align: center;
    display: flex;
    flex-direction: column;
    gap: 8px;
    align-items: center;
  }

  .empty-icon {
    font-size: 32px;
    opacity: 0.3;
  }

  .empty-text {
    color: rgba(255, 255, 255, 0.6);
    font-size: 13px;
    font-weight: 500;
  }

  .empty-hint {
    color: rgba(255, 255, 255, 0.4);
    font-size: 11px;
  }

  .account-avatar {
    width: 24px;
    height: 24px;
    border-radius: 4px;
  }

  .account-meta {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    gap: 2px;
  }

  .account-name {
    color: #e1e1e1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .account-id {
    color: #8a8f98;
    font-size: 10px;
    font-family: 'JetBrains Mono', monospace;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .add-item .account-name {
    flex: 1;
  }

  .account-status {
    font-size: 11px;
    color: #0f8;
    font-weight: 500;
  }

  .account-status.pending {
    color: #fa4;
  }

  .add-item {
    color: #7aa8ff;
  }
</style>
