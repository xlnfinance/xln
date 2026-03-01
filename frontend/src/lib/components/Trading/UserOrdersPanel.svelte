<!--
  UserOrdersPanel.svelte

  Displays all swap orders for a specific entity across ALL accounts.
  Aggregates swapOffers from all bilateral accounts.

  Usage:
    <UserOrdersPanel entityId="0x..." />
-->
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { xlnEnvironment } from '$lib/stores/xlnStore';
  import { formatEntityId } from '$lib/utils/format';

  export let entityId: string = '';

  interface Order {
    offerId: string;
    counterpartyId: string;
    counterpartyName: string;
    side: 'BUY' | 'SELL';
    giveTokenId: number;
    giveAmount: bigint;
    wantTokenId: number;
    wantAmount: bigint;
    minFillRatio: number;
    price: number;  // Derived: wantAmount / giveAmount
    status: 'OPEN' | 'PARTIAL' | 'FILLED';
    filledPercent: number;
    createdAt?: number;
  }

  let orders: Order[] = [];
  let pollInterval: number | null = null;
  const POLL_MS = 500;

  // Token name mapping (extend as needed)
  const TOKEN_NAMES: Record<number, string> = {
    1: 'ETH',
    2: 'USDC',
    3: 'DAI',
  };

  function getTokenName(tokenId: number): string {
    return TOKEN_NAMES[tokenId] || `T${tokenId}`;
  }

  function extractOrders() {
    const env = $xlnEnvironment;
    if (!env || !entityId) return;

    // Find entity replica
    let entityReplica: any = null;
    for (const [key, replica] of env.eReplicas) {
      if (key.startsWith(entityId + ':')) {
        entityReplica = replica;
        break;
      }
    }

    if (!entityReplica?.state?.accounts) {
      orders = [];
      return;
    }

    const newOrders: Order[] = [];

    for (const [counterpartyId, account] of entityReplica.state.accounts) {
      if (!account.swapOffers) continue;

      for (const [offerId, offer] of account.swapOffers) {
        // Determine side based on which token we're giving
        // Convention: giving base token (lower ID) = SELL, giving quote = BUY
        const side = offer.giveTokenId < offer.wantTokenId ? 'SELL' : 'BUY';

        // Calculate price (quote per base)
        let price: number;
        if (side === 'SELL') {
          // Selling base, want quote: price = quote / base
          price = Number(offer.wantAmount) / Number(offer.giveAmount);
        } else {
          // Buying base, give quote: price = give / want
          price = Number(offer.giveAmount) / Number(offer.wantAmount);
        }

        // Get counterparty name if available
        let counterpartyName = formatEntityId(counterpartyId);
        const counterpartyReplica = findReplica(env, counterpartyId);
        if (counterpartyReplica?.state?.profile?.name) {
          counterpartyName = counterpartyReplica.state.profile.name;
        }

        newOrders.push({
          offerId,
          counterpartyId,
          counterpartyName,
          side,
          giveTokenId: offer.giveTokenId,
          giveAmount: offer.giveAmount,
          wantTokenId: offer.wantTokenId,
          wantAmount: offer.wantAmount,
          minFillRatio: offer.minFillRatio || 0,
          price,
          status: 'OPEN',  // TODO: track partial fills
          filledPercent: 0,
          createdAt: offer.createdAt,
        });
      }
    }

    // Sort by creation time (newest first) or by side then price
    newOrders.sort((a, b) => {
      // Group by side
      if (a.side !== b.side) return a.side === 'BUY' ? -1 : 1;
      // Within side, sort by price (best first)
      if (a.side === 'BUY') return b.price - a.price;  // Highest bid first
      return a.price - b.price;  // Lowest ask first
    });

    orders = newOrders;
  }

  function findReplica(env: any, entityId: string): any {
    for (const [key, replica] of env.eReplicas) {
      if (key.startsWith(entityId + ':')) return replica;
    }
    return null;
  }

  function formatAmount(amount: bigint, tokenId: number): string {
    // Assuming 18 decimals
    const value = Number(amount) / 1e18;
    if (value >= 1_000_000) return (value / 1_000_000).toFixed(2) + 'M';
    if (value >= 1_000) return (value / 1_000).toFixed(2) + 'K';
    return value.toFixed(4);
  }

  function formatPrice(price: number): string {
    return price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 });
  }

  async function cancelOrder(order: Order) {
    const runtime = (window as any).XLN;
    if (!runtime) {
      console.error('XLN runtime not available');
      return;
    }

    const env = $xlnEnvironment;
    if (!env) return;

    // Find signer for this entity
    let signerId = 'user';
    const replica = findReplica(env, entityId);
    if (replica?.state?.config?.validators?.[0]) {
      signerId = replica.state.config.validators[0];
    }

    try {
      runtime.enqueueRuntimeInput(env, { runtimeTxs: [], entityInputs: [{
        entityId,
        signerId,
        entityTxs: [{
          type: 'proposeCancelSwap',
          data: {
            counterpartyEntityId: order.counterpartyId,
            offerId: order.offerId,
          }
        }]
      }] });
      console.log(`Cancelled order ${order.offerId}`);
    } catch (err) {
      console.error('Failed to cancel order:', err);
    }
  }

  onMount(() => {
    extractOrders();
    pollInterval = setInterval(extractOrders, POLL_MS) as unknown as number;
  });

  onDestroy(() => {
    if (pollInterval) clearInterval(pollInterval);
  });

  $: if (entityId) extractOrders();
</script>

<div class="user-orders-panel">
  <div class="header">
    <span class="title">My Orders</span>
    <span class="count">{orders.length} active</span>
  </div>

  {#if orders.length === 0}
    <div class="empty-state">
      <span>No open orders</span>
      <span class="hint">Place orders to see them here</span>
    </div>
  {:else}
    <div class="orders-list">
      <div class="list-header">
        <span class="col-side">Side</span>
        <span class="col-pair">Pair</span>
        <span class="col-price">Price</span>
        <span class="col-amount">Amount</span>
        <span class="col-hub">Hub</span>
        <span class="col-actions"></span>
      </div>

      {#each orders as order}
        <div class="order-row" class:buy={order.side === 'BUY'} class:sell={order.side === 'SELL'}>
          <span class="col-side side-badge" class:buy={order.side === 'BUY'} class:sell={order.side === 'SELL'}>
            {order.side}
          </span>
          <span class="col-pair">
            {getTokenName(Math.min(order.giveTokenId, order.wantTokenId))}/{getTokenName(Math.max(order.giveTokenId, order.wantTokenId))}
          </span>
          <span class="col-price">{formatPrice(order.price)}</span>
          <span class="col-amount">
            {formatAmount(order.giveAmount, order.giveTokenId)} {getTokenName(order.giveTokenId)}
          </span>
          <span class="col-hub" title={order.counterpartyId}>
            {order.counterpartyName}
          </span>
          <span class="col-actions">
            <button class="cancel-btn" on:click={() => cancelOrder(order)} title="Request cancellation">
              ×
            </button>
          </span>
        </div>
      {/each}
    </div>
  {/if}

  <div class="footer">
    <span class="entity-label">Entity: {entityId ? formatEntityId(entityId) : 'None'}</span>
  </div>
</div>

<style>
  .user-orders-panel {
    background: var(--bg-secondary, #1a1a2e);
    border: 1px solid var(--border-color, #333);
    border-radius: 8px;
    padding: 12px;
    font-family: 'JetBrains Mono', 'Fira Code', monospace;
    font-size: 12px;
    min-width: 400px;
  }

  .header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 12px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--border-color, #333);
  }

  .title {
    font-weight: 600;
    color: var(--text-primary, #fff);
  }

  .count {
    color: var(--text-secondary, #888);
    font-size: 11px;
  }

  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 24px;
    color: var(--text-secondary, #888);
  }

  .hint {
    font-size: 11px;
    color: var(--text-tertiary, #555);
    margin-top: 4px;
  }

  .orders-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .list-header {
    display: grid;
    grid-template-columns: 50px 80px 80px 100px 1fr 30px;
    gap: 8px;
    padding: 6px 8px;
    color: var(--text-tertiary, #555);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .order-row {
    display: grid;
    grid-template-columns: 50px 80px 80px 100px 1fr 30px;
    gap: 8px;
    padding: 8px;
    background: var(--bg-tertiary, #252540);
    border-radius: 4px;
    align-items: center;
  }

  .order-row:hover {
    background: var(--bg-hover, #2a2a4a);
  }

  .side-badge {
    padding: 2px 6px;
    border-radius: 3px;
    font-size: 10px;
    font-weight: 600;
    text-align: center;
  }

  .side-badge.buy {
    background: rgba(34, 197, 94, 0.2);
    color: #22c55e;
  }

  .side-badge.sell {
    background: rgba(239, 68, 68, 0.2);
    color: #ef4444;
  }

  .col-pair {
    color: var(--text-primary, #fff);
  }

  .col-price {
    color: var(--text-primary, #fff);
    text-align: right;
  }

  .col-amount {
    color: var(--text-secondary, #888);
    text-align: right;
  }

  .col-hub {
    color: var(--text-secondary, #888);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .cancel-btn {
    background: transparent;
    border: 1px solid var(--border-color, #444);
    color: var(--text-secondary, #888);
    border-radius: 4px;
    width: 22px;
    height: 22px;
    cursor: pointer;
    font-size: 14px;
    line-height: 1;
    transition: all 0.2s;
  }

  .cancel-btn:hover {
    background: rgba(239, 68, 68, 0.2);
    border-color: #ef4444;
    color: #ef4444;
  }

  .footer {
    margin-top: 12px;
    padding-top: 8px;
    border-top: 1px solid var(--border-color, #333);
    font-size: 10px;
    color: var(--text-tertiary, #555);
  }
</style>
