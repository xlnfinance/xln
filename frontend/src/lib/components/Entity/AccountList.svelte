<script lang="ts">
  import type { EntityReplica } from '$lib/types/ui';
  import { createEventDispatcher } from 'svelte';
  import { replicas, xlnFunctions, xlnEnvironment } from '../../stores/xlnStore';
  import AccountPreview from './AccountPreview.svelte';
  import { getEntityDisplayName } from '$lib/utils/entityNaming';

export let replica: EntityReplica | null;
export let selectedAccountId: string | null = null;

  $: entityHeight = Number(replica?.state?.height ?? 0);
  $: runtimeHeight = Number($xlnEnvironment?.height ?? 0);

  const dispatch = createEventDispatcher();
  let showAllAccounts = false;

  // Get accounts from entity state - DIRECT references (no shallow copy!)
  // CRITICAL: Don't spread account object - it creates stale snapshot
  $: accounts = (replica?.state?.accounts && replica.state.accounts instanceof Map)
    ? Array.from(replica.state.accounts.entries())
    : [];

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

  $: rankedAccounts = accounts
    .map(([counterpartyId, account]) => ({
      counterpartyId,
      account,
    }))
    // Preserve Map insertion order so the UI stays stable by first account appearance.
    .filter((entry) => !isFinalizedDisputed(entry.account));

  $: visibleAccounts = showAllAccounts ? rankedAccounts : rankedAccounts.slice(0, 5);
  $: hiddenAccountsCount = Math.max(0, rankedAccounts.length - visibleAccounts.length);
  $: activeAccountsCount = rankedAccounts.length;

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

  function forwardDispute(event: CustomEvent) {
    dispatch('dispute', event.detail);
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

    items.sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id));
    return {
      items: items.slice(0, 3),
      overflowCount: Math.max(0, items.length - 3),
    };
  }



</script>

<div class="account-list-wrapper" data-testid="account-list-wrapper">
  <!-- Account List View (Always show previews, never full panel) -->
  <div class="accounts-list-view">


      {#if activeAccountsCount === 0}
        <div class="no-accounts">
          <p>No accounts established</p>
          <small>Select an entity below to open an account</small>
        </div>
      {:else}
        <div class="list-header">
          <div class="list-controls">
            {#if activeAccountsCount > 5}
              <button
                class="list-toggle"
                on:click={() => showAllAccounts = !showAllAccounts}
                title={showAllAccounts ? 'Show first 5 only' : 'Show all accounts'}
              >
                {showAllAccounts ? 'Collapse' : `Show All (${activeAccountsCount})`}
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
              isSelected={selectedAccountId
                ? String(selectedAccountId).toLowerCase() === String(entry.counterpartyId).toLowerCase()
                : index === 0}
              on:select={selectAccount}
              on:faucet={forwardFaucet}
              on:settleApprove={forwardSettleApprove}
              on:dispute={forwardDispute}
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
    color: var(--theme-text-primary, #e4e4e7);
  }

  .accounts-list-view {
    height: 100%;
    display: flex;
    flex-direction: column;
  }

  .accounts-list {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 8px;
  }


  .no-accounts {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 30px 20px;
    text-align: center;
    background: color-mix(in srgb, var(--theme-surface, #18181b) 72%, transparent);
    border: 1px solid color-mix(in srgb, var(--theme-border, #27272a) 72%, transparent);
    border-radius: 6px;
  }

  .no-accounts p {
    margin: 0 0 8px 0;
    color: var(--theme-text-primary, #d4d4d4);
  }

  .no-accounts small {
    color: var(--theme-text-muted, #9d9d9d);
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
  }

  .list-toggle {
    background: transparent;
    border: 1px solid color-mix(in srgb, var(--theme-border, #27272a) 76%, transparent);
    border-radius: 999px;
    color: var(--theme-text-secondary, #a8a29e);
    font-size: 0.72em;
    cursor: pointer;
    padding: 5px 10px;
    line-height: 1.2;
  }

  .list-toggle:hover {
    border-color: color-mix(in srgb, var(--theme-border, #27272a) 84%, white 16%);
    color: var(--theme-text-primary, #e7e5e4);
  }
</style>
