<script lang="ts">
  import type { AccountMachine } from '@xln/runtime/xln-api';
  import type { EntityReplica } from '$lib/types/ui';
  import { createEventDispatcher } from 'svelte';
  import { xlnEnvironment } from '../../stores/xlnStore';
  import AccountPreview from './AccountPreview.svelte';
  import { getEntityDisplayName } from '$lib/utils/entityNaming';
  import { compareStableText } from '$lib/utils/stableSort';

export let replica: EntityReplica | null;
export let selectedAccountId: string | null = null;
export let pendingFaucetKeys: Set<string> = new Set();

  $: entityHeight = Number(replica?.state?.height ?? 0);
  $: runtimeHeight = Number($xlnEnvironment?.height ?? 0);

  const dispatch = createEventDispatcher();
  let accountBrowserOpen = false;
  let accountPage = 0;
  let accountSearch = '';
  let lastAccountSearchKey = '';
  const COLLAPSED_ACCOUNT_LIMIT = 5;
  const ACCOUNT_PAGE_SIZE = 50;

  type AccountView = {
    status?: string;
    activeDispute?: unknown;
  };

  type LockDirection = 'incoming' | 'outgoing';

  type LockBookEntryView = {
    lockId?: string;
    accountId: string;
    tokenId?: number;
    amount: bigint;
    hashlock?: string;
    direction: LockDirection;
    createdAt?: bigint;
  };

  type HtlcRouteView = {
    hashlock?: string;
    inboundEntity?: string;
    inboundLockId?: string;
    outboundEntity?: string;
    outboundLockId?: string;
    secretAckPending?: boolean;
  };

  type ActiveFlowSummary = {
    id: string;
    direction: LockDirection;
    tokenId: number;
    amount: bigint;
    title: string;
    subtitle: string;
  };

  type AccountListEntry = {
    counterpartyId: string;
    account: AccountMachine;
  };

  type AccountPageView = {
    entries: AccountListEntry[];
    page: number;
    pageSize: number;
    hasPrevious: boolean;
    hasNext: boolean;
    isSearching: boolean;
  };

  const isLockBookEntryView = (value: unknown): value is LockBookEntryView => {
    if (typeof value !== 'object' || value === null) return false;
    const candidate = value as Partial<LockBookEntryView>;
    return (
      typeof candidate.accountId === 'string' &&
      typeof candidate.amount === 'bigint' &&
      (candidate.direction === 'incoming' || candidate.direction === 'outgoing')
    );
  };

  const isHtlcRouteView = (value: unknown): value is HtlcRouteView => {
    if (typeof value !== 'object' || value === null) return false;
    const candidate = value as Partial<HtlcRouteView>;
    return (
      typeof candidate.hashlock === 'string' ||
      typeof candidate.inboundLockId === 'string' ||
      typeof candidate.outboundLockId === 'string'
    );
  };

	  function isFinalizedDisputed(account: AccountView): boolean {
	    const status = String(account.status || '');
	    const activeDispute = !!account.activeDispute;
	    return status === 'disputed' && !activeDispute;
	  }

  function getAccountsMap(sourceReplica: EntityReplica | null): Map<string, AccountMachine> | null {
    const accounts = sourceReplica?.state?.accounts;
    return accounts instanceof Map ? (accounts as Map<string, AccountMachine>) : null;
  }

  function accountMatchesSearch(counterpartyId: string, account: AccountMachine, query: string): boolean {
    if (!query) return true;
    const fields = [
      counterpartyId,
      account.leftEntity,
      account.rightEntity,
      account.status,
    ];
    return fields.some((field) => String(field || '').toLowerCase().includes(query));
  }

  function buildAccountPageView(
    sourceReplica: EntityReplica | null,
    browserOpen: boolean,
    pageIndex: number,
    searchRaw: string,
  ): AccountPageView {
    const accounts = getAccountsMap(sourceReplica);
    const pageSize = browserOpen ? ACCOUNT_PAGE_SIZE : COLLAPSED_ACCOUNT_LIMIT;
    const page = browserOpen ? Math.max(0, pageIndex) : 0;
    const start = page * pageSize;
    const query = searchRaw.trim().toLowerCase();
    const entries: AccountListEntry[] = [];
    let matched = 0;
    let hasNext = false;

    if (!accounts) {
      return { entries, page, pageSize, hasPrevious: page > 0, hasNext, isSearching: Boolean(query) };
    }

    // Preserve Map insertion order so the UI stays stable by first account appearance.
    // The loop stops after the current page plus one sentinel row; a hub with a large
    // account map must not force Svelte to allocate every account just to render a list.
    for (const [counterpartyId, account] of accounts.entries()) {
      if (isFinalizedDisputed(account)) continue;
      if (!accountMatchesSearch(String(counterpartyId), account, query)) continue;
      if (matched < start) {
        matched += 1;
        continue;
      }
      if (entries.length >= pageSize) {
        hasNext = true;
        break;
      }
      entries.push({ counterpartyId: String(counterpartyId), account });
      matched += 1;
    }

    return {
      entries,
      page,
      pageSize,
      hasPrevious: page > 0,
      hasNext,
      isSearching: Boolean(query),
    };
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

    const lockBook = replica?.state?.lockBook;
    if (!lockBook || typeof lockBook.values !== 'function') return summary;

    const cpNorm = normalizeId(counterpartyId);
    for (const lock of lockBook.values()) {
      if (!isLockBookEntryView(lock)) continue;
      if (normalizeId(lock.accountId) !== cpNorm) continue;
      const amount = lock.amount;
      if (lock.direction === 'incoming') {
        summary.incomingCount += 1;
        summary.incomingAmount += amount;
      } else {
        summary.outgoingCount += 1;
        summary.outgoingAmount += amount;
      }
    }

    return summary;
  }

  function getActiveFlowSummary(counterpartyId: string): { items: ActiveFlowSummary[]; overflowCount: number } {
    const items: Array<ActiveFlowSummary & { createdAt: number }> = [];
    const lockBook = replica?.state?.lockBook;
    const notes = replica?.state?.htlcNotes;
    const routes = replica?.state?.htlcRoutes;
    if (!lockBook || typeof lockBook.values !== 'function') return { items: [], overflowCount: 0 };

    const cpNorm = normalizeId(counterpartyId);
    for (const lock of lockBook.values()) {
      if (!isLockBookEntryView(lock)) continue;
      if (normalizeId(lock.accountId) !== cpNorm) continue;

      const tokenId = Number(lock.tokenId ?? 0);
      if (!Number.isFinite(tokenId) || tokenId <= 0) continue;

      let matchedRoute: HtlcRouteView | null = null;
      if (routes && typeof routes.values === 'function') {
        for (const route of routes.values()) {
          if (!isHtlcRouteView(route)) continue;
          if (
            (typeof route.outboundLockId === 'string' && route.outboundLockId === lock.lockId) ||
            (typeof route.inboundLockId === 'string' && route.inboundLockId === lock.lockId) ||
            (typeof route.hashlock === 'string' && route.hashlock === lock.hashlock)
          ) {
            matchedRoute = route;
            break;
          }
        }
      }

      const paymentNote = typeof notes?.get === 'function'
        ? (() => {
            const lockKey = typeof lock.lockId === 'string' ? notes.get(`lock:${lock.lockId}`) : '';
            if (typeof lockKey === 'string' && lockKey.trim()) return lockKey.trim();
            const hashKey = typeof lock.hashlock === 'string' ? notes.get(`hashlock:${lock.hashlock}`) : '';
            return typeof hashKey === 'string' ? hashKey.trim() : '';
          })()
        : '';

      const peerEntityId = lock.direction === 'incoming'
        ? String(matchedRoute?.inboundEntity || counterpartyId)
        : String(matchedRoute?.outboundEntity || counterpartyId);
      const peerName = getEntityDisplayName(peerEntityId, {
        source: $xlnEnvironment,
        selfEntityId: replica?.entityId || '',
        selfLabel: 'You',
      });

      const subtitle = paymentNote
        || (matchedRoute?.secretAckPending
          ? 'Awaiting secret ACK'
          : lock.direction === 'incoming'
            ? `From ${peerName}`
            : `To ${peerName}`);

      items.push({
        id: String(lock.lockId || lock.hashlock || `${counterpartyId}-${items.length}`),
        direction: lock.direction,
        tokenId,
        amount: lock.amount,
        title: lock.direction === 'incoming' ? 'Incoming HTLC' : 'Outgoing HTLC',
        subtitle: subtitle || `Hash ${shortHash(String(lock.hashlock || ''))}`,
        createdAt: typeof lock.createdAt === 'bigint' ? Number(lock.createdAt) : 0,
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
              {runtimeHeight}
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
    justify-content: flex-end;
    align-items: center;
    padding: 2px 8px 6px;
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
