<script lang="ts">
  import type { EntityReplica } from '$lib/types/ui';

  export let replica: EntityReplica;
  export let expanded: boolean = false;

  let showAll: boolean = false;

  $: lockBook = replica.state.lockBook || new Map();
  $: htlcRoutes = replica.state.htlcRoutes || new Map();
  $: feesEarned = replica.state.htlcFeesEarned || 0n;

  $: allLocks = Array.from(lockBook.values()).sort((a, b) =>
    Number(b.createdAt) - Number(a.createdAt)
  );

  $: displayedLocks = showAll ? allLocks : allLocks.slice(0, 10);
  $: hasMore = allLocks.length > 10;

  $: outgoingLocks = allLocks.filter(l => l.direction === 'outgoing');
  $: incomingLocks = allLocks.filter(l => l.direction === 'incoming');

  function getLockStatus(lock: any): string {
    const now = Date.now();

    // LockBookEntry only has timelock, not revealBeforeHeight
    if (now > Number(lock.timelock)) {
      return 'expired';
    }

    const route = htlcRoutes.get(lock.hashlock);
    if (route?.secret) {
      return 'revealed';
    }

    return 'pending';
  }

  function getTimeRemaining(lock: any): string {
    const now = Date.now();
    const remaining = Number(lock.timelock) - now;
    if (remaining <= 0) return 'Expired';

    const seconds = Math.floor(remaining / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h`;
  }

  function formatAmount(amount: bigint, tokenId: number): string {
    const decimals = 18;
    const divisor = 10n ** BigInt(decimals);
    const whole = amount / divisor;
    const symbol = tokenId === 1 ? 'USDC' : 'ETH';

    if (whole > 1000n) {
      return `$${(Number(whole) / 1000).toFixed(0)}k ${symbol}`;
    }
    return `${whole} ${symbol}`;
  }

  function formatFees(fees: bigint): string {
    const decimals = 18;
    const divisor = 10n ** BigInt(decimals);
    const value = Number(fees) / Number(divisor);
    return value.toFixed(2);
  }
</script>

<div class="htlc-activity">
  <div class="section-header" role="button" tabindex="0" on:click={() => expanded = !expanded} on:keydown={(e) => e.key === 'Enter' && (expanded = !expanded)}>
    <span class="title">
      🔐 HTLC Activity ({allLocks.length})
    </span>
    {#if feesEarned > 0n}
      <span class="fees-earned">
        Fees: ${formatFees(feesEarned)}
      </span>
    {/if}
    <span class="toggle">{expanded ? '▼' : '▶'}</span>
  </div>

  {#if expanded}
    <div class="htlc-content">
      <div class="summary">
        <div class="summary-item">
          <span class="label">Outgoing:</span>
          <span class="value">{outgoingLocks.length}</span>
        </div>
        <div class="summary-item">
          <span class="label">Incoming:</span>
          <span class="value">{incomingLocks.length}</span>
        </div>
      </div>

      {#if displayedLocks.length > 0}
        <div class="locks-list">
          {#each displayedLocks as lock}
            {@const status = getLockStatus(lock)}
            {@const timeLeft = getTimeRemaining(lock)}

            <div class="lock-item status-{status}">
              <div class="lock-header">
                <span class="direction">{lock.direction === 'outgoing' ? '→' : '←'}</span>
                <span class="amount">{formatAmount(lock.amount, lock.tokenId)}</span>
                <span class="status-badge {status}">
                  {status === 'pending' ? '🟡' : status === 'revealed' ? '🟢' : '🔴'}
                  {status}
                </span>
              </div>
              <div class="lock-details">
                <div class="detail-row">
                  <span class="label">Lock ID:</span>
                  <span class="value mono">{lock.lockId.slice(0, 16)}...</span>
                </div>
                <div class="detail-row">
                  <span class="label">Hashlock:</span>
                  <span class="value mono">{lock.hashlock.slice(0, 16)}...</span>
                </div>
                <div class="detail-row">
                  <span class="label">Expires:</span>
                  <span class="value">
                    {#if status === 'pending'}
                      <span class="countdown">{timeLeft}</span>
                    {:else}
                      {new Date(Number(lock.timelock)).toLocaleString()}
                    {/if}
                  </span>
                </div>
                <div class="detail-row">
                  <span class="label">Counterparty:</span>
                  <span class="value mono">{lock.accountId.slice(-8)}</span>
                </div>
              </div>
            </div>
          {/each}
        </div>

        {#if hasMore && !showAll}
          <button class="view-all-btn" on:click={() => showAll = true}>
            View All ({allLocks.length})
          </button>
        {/if}

        {#if showAll && allLocks.length > 10}
          <button class="view-less-btn" on:click={() => showAll = false}>
            Show Recent (10)
          </button>
        {/if}
      {:else}
        <div class="empty-state">No active HTLC locks</div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .htlc-activity {
    margin: 1rem 0;
    border: 1px solid #333;
    border-radius: 4px;
    background: #1a1a1a;
  }

  .section-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem 1rem;
    cursor: pointer;
    user-select: none;
    transition: background 0.2s;
  }

  .section-header:hover {
    background: #222;
  }

  .title {
    font-weight: 600;
    font-size: 0.95rem;
  }

  .fees-earned {
    color: #4ade80;
    font-size: 0.85rem;
    font-weight: 500;
  }

  .toggle {
    color: #666;
    font-size: 0.8rem;
  }

  .htlc-content {
    padding: 0 1rem 1rem 1rem;
  }

  .summary {
    display: flex;
    gap: 2rem;
    margin-bottom: 1rem;
    padding: 0.5rem;
    background: #0a0a0a;
    border-radius: 4px;
  }

  .summary-item {
    display: flex;
    gap: 0.5rem;
  }

  .summary-item .label {
    color: #888;
    font-size: 0.85rem;
  }

  .summary-item .value {
    color: #fff;
    font-weight: 600;
    font-size: 0.85rem;
  }

  .locks-list {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .lock-item {
    padding: 0.75rem;
    border: 1px solid #2a2a2a;
    border-radius: 4px;
    background: #111;
  }

  .lock-item.status-revealed {
    border-left: 3px solid #4ade80;
  }

  .lock-item.status-pending {
    border-left: 3px solid #fbbf24;
  }

  .lock-item.status-expired {
    border-left: 3px solid #ef4444;
    opacity: 0.7;
  }

  .lock-header {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 0.5rem;
  }

  .direction {
    font-size: 1.2rem;
    opacity: 0.7;
  }

  .amount {
    font-weight: 600;
    font-size: 0.95rem;
  }

  .status-badge {
    margin-left: auto;
    padding: 0.25rem 0.5rem;
    border-radius: 3px;
    font-size: 0.75rem;
    font-weight: 500;
  }

  .status-badge.pending {
    background: #fbbf2433;
    color: #fbbf24;
  }

  .status-badge.revealed {
    background: #4ade8033;
    color: #4ade80;
  }

  .status-badge.expired {
    background: #ef444433;
    color: #ef4444;
  }

  .lock-details {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.8rem;
  }

  .detail-row {
    display: flex;
    gap: 0.5rem;
  }

  .detail-row .label {
    color: #666;
    min-width: 90px;
  }

  .detail-row .value {
    color: #ccc;
  }

  .detail-row .value.mono {
    font-family: 'Courier New', monospace;
    font-size: 0.75rem;
  }

  .countdown {
    color: #fbbf24;
    font-style: italic;
  }

  .view-all-btn, .view-less-btn {
    width: 100%;
    margin-top: 0.5rem;
    padding: 0.5rem;
    background: #222;
    border: 1px solid #444;
    border-radius: 4px;
    color: #aaa;
    cursor: pointer;
    font-size: 0.85rem;
  }

  .view-all-btn:hover, .view-less-btn:hover {
    background: #2a2a2a;
    color: #fff;
  }

  .empty-state {
    padding: 1rem;
    text-align: center;
    color: #666;
    font-size: 0.85rem;
    font-style: italic;
  }
</style>
