<script lang="ts">
  import type { EntityReplica } from '$lib/types/ui';
  import { createEventDispatcher } from 'svelte';
  import { replicas, xlnFunctions } from '../../stores/xlnStore';
  import { settings, settingsOperations } from '../../stores/settingsStore';
  import AccountPreview from './AccountPreview.svelte';

  export let replica: EntityReplica | null;

  const dispatch = createEventDispatcher();
  let showAllAccounts = false;

  // Get accounts from entity state - DIRECT references (no shallow copy!)
  // CRITICAL: Don't spread account object - it creates stale snapshot
  $: accounts = (replica?.state?.accounts && replica.state.accounts instanceof Map)
    ? Array.from(replica.state.accounts.entries())
    : [];

  function absBigInt(v: bigint): bigint {
    return v >= 0n ? v : -v;
  }

  function getAccountDeltaMagnitude(account: any): bigint {
    const deltas = account?.deltas;
    if (!deltas || typeof deltas.values !== 'function') return 0n;
    let sum = 0n;
    for (const delta of deltas.values()) {
      const on = typeof delta?.ondelta === 'bigint' ? delta.ondelta : 0n;
      const off = typeof delta?.offdelta === 'bigint' ? delta.offdelta : 0n;
      sum += absBigInt(on + off);
    }
    return sum;
  }

  $: rankedAccounts = accounts
    .map(([counterpartyId, account]) => ({
      counterpartyId,
      account,
      score: getAccountDeltaMagnitude(account),
    }))
    .sort((a, b) => {
      if (a.score === b.score) return a.counterpartyId.localeCompare(b.counterpartyId);
      return a.score > b.score ? -1 : 1;
    });

  $: visibleAccounts = showAllAccounts ? rankedAccounts : rankedAccounts.slice(0, 3);
  $: hiddenAccountsCount = Math.max(0, rankedAccounts.length - visibleAccounts.length);

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
      const hasAccount = existingAccountIds.has(entityId);
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
    dispatch('select', event.detail);
  }

  function forwardFaucet(event: CustomEvent) {
    dispatch('faucet', event.detail);
  }

  function forwardSettleApprove(event: CustomEvent) {
    dispatch('settleApprove', event.detail);
  }

  function normalizeId(id: string): string {
    return String(id || '').toLowerCase();
  }

  function getLockSummary(counterpartyId: string): {
    incomingCount: number;
    incomingAmount: bigint;
    outgoingCount: number;
    outgoingAmount: bigint;
  } {
    const summary = {
      incomingCount: 0,
      incomingAmount: 0n,
      outgoingCount: 0,
      outgoingAmount: 0n,
    };

    const lockBook = replica?.state?.lockBook;
    if (!lockBook || typeof lockBook.values !== 'function') return summary;

    const cpNorm = normalizeId(counterpartyId);
    for (const lock of lockBook.values()) {
      if (normalizeId(String((lock as any)?.accountId || '')) !== cpNorm) continue;
      const amount = typeof (lock as any)?.amount === 'bigint' ? (lock as any).amount : 0n;
      if ((lock as any)?.direction === 'incoming') {
        summary.incomingCount += 1;
        summary.incomingAmount += amount;
      } else if ((lock as any)?.direction === 'outgoing') {
        summary.outgoingCount += 1;
        summary.outgoingAmount += amount;
      }
    }

    return summary;
  }



</script>

<div class="account-list-wrapper" data-testid="account-list-wrapper">
  <!-- Account List View (Always show previews, never full panel) -->
  <div class="accounts-list-view">


      {#if accounts.length === 0}
        <div class="no-accounts">
          <p>No accounts established</p>
          <small>Select an entity below to open an account</small>
        </div>
      {:else}
        <div class="list-header">
          <span class="list-count">
            {#if hiddenAccountsCount > 0}
              Top {visibleAccounts.length} of {accounts.length} accounts
            {:else}
              {accounts.length} account{accounts.length !== 1 ? 's' : ''}
            {/if}
          </span>
          <div class="list-controls">
            {#if accounts.length > 3}
              <button
                class="list-toggle"
                on:click={() => showAllAccounts = !showAllAccounts}
                title={showAllAccounts ? 'Show top 3 only' : 'Show all accounts'}
              >
                {showAllAccounts ? 'Top 3' : `All (${accounts.length})`}
              </button>
            {/if}
            <button class="layout-toggle" on:click={() => settingsOperations.update({ barLayout: $settings.barLayout === 'center' ? 'sides' : 'center' })} title="{$settings.barLayout === 'center' ? 'Switch to sides view' : 'Switch to center view'}">
              {$settings.barLayout === 'center' ? '⊞' : '⊟'}
            </button>
          </div>
        </div>
        <div class="scrollable-component accounts-list">
          {#each visibleAccounts as entry (entry.counterpartyId)}
            <AccountPreview
              account={entry.account}
              counterpartyId={entry.counterpartyId}
              entityId={replica?.entityId || ''}
              lockSummary={getLockSummary(entry.counterpartyId)}
              isSelected={false}
              on:select={selectAccount}
              on:faucet={forwardFaucet}
              on:settleApprove={forwardSettleApprove}
            />
          {/each}
        </div>

    {/if}
  </div>
</div>

<style>
  .account-list-wrapper {
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
    gap: 6px;
  }

  .list-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 6px 8px;
  }

  .list-count {
    font-size: 0.75em;
    color: #78716c;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .layout-toggle {
    background: none;
    border: 1px solid #292524;
    border-radius: 3px;
    color: #78716c;
    font-size: 1em;
    cursor: pointer;
    padding: 2px 6px;
    line-height: 1;
  }

  .layout-toggle:hover {
    color: #a8a29e;
    border-color: #44403c;
  }

  .list-controls {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .list-toggle {
    background: transparent;
    border: 1px solid #292524;
    border-radius: 3px;
    color: #a8a29e;
    font-size: 0.72em;
    cursor: pointer;
    padding: 3px 8px;
    line-height: 1.2;
  }

  .list-toggle:hover {
    border-color: #57534e;
    color: #e7e5e4;
  }
</style>
