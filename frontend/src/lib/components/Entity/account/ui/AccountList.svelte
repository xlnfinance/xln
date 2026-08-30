<script lang="ts">
  import type { Profile as GossipProfile } from '@xln/core/api/public/runtime-module';
  import type { EntityReplica } from '$lib/types/ui';
  import { createEventDispatcher } from 'svelte';
  import AccountPreview from './AccountPreview.svelte';
  import { compareStableText } from '$lib/utils/stableSort';
  import { buildAccountPageView, isAccountsMapLike, resolveAccountListEntityName } from '../../core/account-list-view';

  export let replica: EntityReplica | null;
  export let selectedAccountId: string | null = null;
  export let pendingFaucetKeys: Set<string> = new Set();
  export let runtimeHeight: number = 0;
  export let entityNames: Map<string, string> = new Map();
  export let profileByEntityId: Map<string, GossipProfile> = new Map();
  export let isDevnet = false;

  $: entityHeight = Number(replica?.state?.height ?? 0);
  $: effectiveRuntimeHeight = Number(runtimeHeight || 0);

  const dispatch = createEventDispatcher();
  let accountBrowserOpen = false;
  let accountPage = 0;
  let accountSearch = '';
  let lastAccountSearchKey = '';

  type LockDirection = 'incoming' | 'outgoing';

  type PaymentFlowView = {
    hashlock: string;
    counterpartyId: string;
    tokenId: number;
    amount: bigint;
    direction: LockDirection;
    description?: string;
    secretAckPending?: boolean;
    startedAtMs: number;
  };

  type ActiveFlowSummary = {
    id: string;
    direction: LockDirection;
    tokenId: number;
    amount: bigint;
    title: string;
    subtitle: string;
  };

  function buildPaymentFlowsByCounterparty(current: EntityReplica | null): Map<string, PaymentFlowView[]> {
    const flows = new Map<string, PaymentFlowView[]>();
    if (!current) return flows;
    const append = (
      counterpartyId: string | undefined,
      direction: LockDirection,
      payment: EntityReplica['state']['paybook']['entries'] extends Map<string, infer Entry> ? Entry : never,
    ): void => {
      const counterparty = normalizeId(counterpartyId || '');
      if (!counterparty || payment.tokenId === undefined || payment.amount === undefined) return;
      const rows = flows.get(counterparty) ?? [];
      rows.push({
        hashlock: payment.hashlock,
        counterpartyId: counterparty,
        tokenId: payment.tokenId,
        amount: payment.amount,
        direction,
        ...(payment.description ? { description: payment.description } : {}),
        ...(payment.secretAckPending ? { secretAckPending: true } : {}),
        startedAtMs: payment.startedAtMs ?? payment.createdTimestamp,
      });
      flows.set(counterparty, rows);
    };
    for (const payment of current.state.paybook.entries.values()) {
      append(payment.inboundEntity, 'incoming', payment);
      append(payment.outboundEntity, 'outgoing', payment);
    }
    return flows;
  }

  $: accountSearchKey = accountSearch.trim().toLowerCase();
  $: if (accountSearchKey !== lastAccountSearchKey) {
    lastAccountSearchKey = accountSearchKey;
    accountPage = 0;
  }
  $: if (!accountBrowserOpen && accountPage !== 0) accountPage = 0;
	  $: accountPageView = buildAccountPageView(replica, accountBrowserOpen, accountPage, accountSearch);
	  $: visibleAccounts = accountPageView.entries;
	  $: hasAccountsToShow = visibleAccounts.length > 0;
	  $: accountTotal = isAccountsMapLike(replica?.state?.accounts)
	    ? replica.state.accounts.size
	    : visibleAccounts.length;
  $: paymentFlowsByCounterparty = buildPaymentFlowsByCounterparty(replica);

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

  function shortHash(value: string): string {
    return value.length > 18 ? `${value.slice(0, 10)}...${value.slice(-4)}` : value;
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

    const cpNorm = normalizeId(counterpartyId);
    for (const payment of paymentFlowsByCounterparty.get(cpNorm) ?? []) {
      if (payment.direction === 'incoming') {
        summary.incomingCount += 1;
        summary.incomingAmount += payment.amount;
      } else {
        summary.outgoingCount += 1;
        summary.outgoingAmount += payment.amount;
      }
    }

    return summary;
  }

  function getActiveFlowSummary(counterpartyId: string): { items: ActiveFlowSummary[]; overflowCount: number } {
    const items: Array<ActiveFlowSummary & { createdAt: number }> = [];
    const cpNorm = normalizeId(counterpartyId);
    for (const payment of paymentFlowsByCounterparty.get(cpNorm) ?? []) {
      const tokenId = Number(payment.tokenId);
      if (!Number.isFinite(tokenId) || tokenId <= 0) continue;
      const peerEntityId = payment.counterpartyId || counterpartyId;
      const peerName = resolveAccountListEntityName(peerEntityId, replica?.entityId || '', entityNames, 'You');

      const subtitle = payment.description
        || (payment.secretAckPending
          ? 'Awaiting secret ACK'
          : payment.direction === 'incoming'
            ? `From ${peerName}`
            : `To ${peerName}`);

      items.push({
        id: `${payment.hashlock}:${payment.direction}`,
        direction: payment.direction,
        tokenId,
        amount: payment.amount,
        title: payment.direction === 'incoming' ? 'Incoming HTLC' : 'Outgoing HTLC',
        subtitle: subtitle || `Hash ${shortHash(payment.hashlock)}`,
        createdAt: payment.startedAtMs,
      });
    }

    items.sort((left, right) => right.createdAt - left.createdAt || compareStableText(left.id, right.id));
    return {
      items: items.slice(0, 3),
      overflowCount: Math.max(0, items.length - 3),
    };
  }



</script>

<div class="account-list-wrapper" data-testid="account-list-wrapper">
  <!-- Account List View (Always show previews, never full panel) -->
  <div class="accounts-list-view">


      {#if !hasAccountsToShow}
        <div class="no-accounts">
          <p>{accountPageView.isSearching ? 'No matching accounts' : 'No accounts established'}</p>
          <small>{accountPageView.isSearching ? 'Refine the search or clear it' : 'Select an entity below to open an account'}</small>
          {#if accountPageView.isSearching || accountPageView.hasPrevious}
            <div class="empty-actions">
              {#if accountPageView.isSearching}
                <button class="list-toggle" on:click={() => accountSearch = ''}>Clear search</button>
              {/if}
              {#if accountPageView.hasPrevious}
                <button class="list-toggle" on:click={() => accountPage = Math.max(0, accountPage - 1)}>Previous page</button>
              {/if}
            </div>
          {/if}
        </div>
      {:else}
	        <div class="list-header">
	          <div class="account-count" data-testid="account-list-count">
	            {accountTotal} Accounts
	          </div>
	          <div class="list-controls">
            {#if accountBrowserOpen}
              <input
                class="account-search"
                type="search"
                bind:value={accountSearch}
                placeholder="Search account"
                aria-label="Search account"
              />
              <span class="page-label">Page {accountPageView.page + 1}</span>
              <button
                class="list-toggle"
                on:click={() => accountPage = Math.max(0, accountPage - 1)}
                disabled={!accountPageView.hasPrevious}
                title="Previous accounts page"
              >
                Prev
              </button>
              <button
                class="list-toggle"
                on:click={() => accountPage = accountPage + 1}
                disabled={!accountPageView.hasNext}
                title="Next accounts page"
              >
                Next
              </button>
              <button
                class="list-toggle"
                on:click={() => {
                  accountBrowserOpen = false;
                  accountSearch = '';
                  accountPage = 0;
                }}
                title="Close account browser"
              >
                Close
              </button>
            {:else if accountPageView.hasNext}
              <button
                class="list-toggle"
                on:click={() => accountBrowserOpen = true}
                title="Browse accounts"
              >
                Browse accounts
              </button>
            {/if}
          </div>
        </div>
        <div class="accounts-list">
          {#each visibleAccounts as entry, index (entry.counterpartyId)}
            {@const activeFlowSummary = getActiveFlowSummary(entry.counterpartyId)}
            <AccountPreview
              account={entry.account}
              counterpartyId={entry.counterpartyId}
              entityId={replica?.entityId || ''}
              {entityHeight}
              runtimeHeight={effectiveRuntimeHeight}
              counterpartyName={resolveAccountListEntityName(entry.counterpartyId, replica?.entityId || '', entityNames, 'You')}
              counterpartyProfile={profileByEntityId.get(normalizeId(entry.counterpartyId)) ?? null}
              {isDevnet}
              lockSummary={getLockSummary(entry.counterpartyId)}
              activeFlows={activeFlowSummary.items}
              activeFlowOverflowCount={activeFlowSummary.overflowCount}
              {pendingFaucetKeys}
              isSelected={selectedAccountId
                ? String(selectedAccountId).toLowerCase() === String(entry.counterpartyId).toLowerCase()
                : index === 0}
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
    height: auto;
    display: flex;
    flex-direction: column;
    color: var(--theme-text-primary, #e4e4e7);
  }

  .accounts-list-view {
    height: auto;
    display: flex;
    flex-direction: column;
  }

  .accounts-list {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 6px 0;
  }


  .no-accounts {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 30px 20px;
    text-align: center;
    background: color-mix(in srgb, var(--theme-card-bg, var(--theme-surface, #18181b)) 98%, transparent);
    border: 1px solid color-mix(in srgb, var(--theme-card-border, var(--theme-border, #27272a)) 88%, transparent);
    border-radius: 6px;
    box-shadow: 0 10px 24px color-mix(in srgb, var(--theme-background, #09090b) 6%, transparent);
  }

  .no-accounts p {
    margin: 0 0 8px 0;
    color: var(--theme-text-primary, #d4d4d4);
  }

  .no-accounts small {
    color: var(--theme-text-muted, #9d9d9d);
  }

  .empty-actions {
    display: flex;
    gap: 8px;
    margin-top: 14px;
  }

  .accounts-list {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

	  .list-header {
	    display: flex;
	    justify-content: space-between;
	    align-items: center;
	    gap: 12px;
	    padding: 2px 8px 6px;
	  }

	  .account-count {
	    color: var(--theme-text-muted, #a1a1aa);
	    font-size: 0.78rem;
	    font-weight: 700;
	    letter-spacing: 0;
	    white-space: nowrap;
	  }

  .list-controls {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }

  .list-toggle {
    background: transparent;
    border: 1px solid color-mix(in srgb, var(--theme-card-border, var(--theme-border, #27272a)) 86%, transparent);
    border-radius: 999px;
    color: var(--theme-text-secondary, #a8a29e);
    font-size: 0.72em;
    cursor: pointer;
    padding: 5px 10px;
    line-height: 1.2;
  }

  .list-toggle:hover {
    border-color: color-mix(in srgb, var(--theme-card-hover-border, var(--theme-border, #27272a)) 82%, transparent);
    color: var(--theme-text-primary, #e7e5e4);
  }

  .list-toggle:disabled {
    opacity: 0.42;
    cursor: not-allowed;
  }

  .account-search {
    width: min(260px, 42vw);
    min-height: 32px;
    border-radius: 6px;
    border: 1px solid color-mix(in srgb, var(--theme-card-border, var(--theme-border, #27272a)) 88%, transparent);
    background: color-mix(in srgb, var(--theme-surface, #101014) 92%, transparent);
    color: var(--theme-text-primary, #e4e4e7);
    padding: 0 10px;
    font-size: 12px;
    outline: none;
  }

  .account-search:focus {
    border-color: color-mix(in srgb, var(--theme-accent, #facc15) 72%, transparent);
  }

  .page-label {
    color: var(--theme-text-muted, #8f8f96);
    font-size: 11px;
    white-space: nowrap;
  }

  @media (max-width: 760px) {
    .accounts-list {
      gap: 10px;
      padding: 4px 0;
    }

    .list-header {
      padding: 0 0 6px;
    }

    .list-controls {
      width: 100%;
      flex-wrap: wrap;
    }

    .list-toggle {
      min-height: 34px;
      font-size: 11px;
    }

    .account-search {
      width: 100%;
    }
  }
</style>
