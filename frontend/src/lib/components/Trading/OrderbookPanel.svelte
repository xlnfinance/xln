<!--
  OrderbookPanel.svelte

  Displays a real-time orderbook from hub's orderbookExt state.
  Reads directly from env.eReplicas (side-channel pattern - no consensus needed for view data).

  Usage:
    <OrderbookPanel hubId="0x..." pairId="1/2" />
-->
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import type { Readable } from 'svelte/store';
  import { xlnEnvironment } from '$lib/stores/xlnStore';
  import { formatEntityId } from '$lib/utils/format';

  export let hubId: string = '';
  export let pairId: string = '1/2';  // e.g., "1/2" for ETH/USDC
  export let depth: number = 10;
  export let showOwners: boolean = false;
  export let envStore: Readable<any> = xlnEnvironment;

  // Derived state
  interface OrderLevel {
    price: number;
    size: number;
    total: number;
    owners?: string[];
  }
  let bids: OrderLevel[] = [];
  let asks: OrderLevel[] = [];
  let spread: number | null = null;
  let spreadPercent: string = '-';
  let lastUpdate: number = 0;

  // Polling interval for orderbook updates
  let pollInterval: number | null = null;
  const POLL_MS = 200;  // 5 updates/sec

  function extractOrderbook() {
    const env = $envStore;
    if (!env || !hubId) return;

    // Find hub replica
    let hubReplica: any = null;
    for (const [key, replica] of env.eReplicas) {
      if (key.startsWith(hubId + ':')) {
        hubReplica = replica;
        break;
      }
    }

    if (!hubReplica?.state?.orderbookExt?.books) return;

    const book = hubReplica.state.orderbookExt.books.get(pairId);
    if (!book) {
      bids = [];
      asks = [];
      spread = null;
      return;
    }

    // Extract bids (descending by price)
    const newBids: OrderLevel[] = [];
    let bidTotal = 0;

    // Use book's bitmap/levels to find non-empty price levels
    const { levelHeadBid, orderQtyLots, orderOwnerIdx, orderNext, orderActive, owners, bestBidIdx, params } = book;
    const { pmin, tick } = params;

    let bidIdx = bestBidIdx;
    while (bidIdx !== -1 && newBids.length < depth) {
      let headIdx = levelHeadBid[bidIdx];
      let levelSize = 0;
      const levelOwners: string[] = [];

      while (headIdx !== -1) {
        if (orderActive[headIdx]) {
          levelSize += orderQtyLots[headIdx];
          if (showOwners) {
            levelOwners.push(owners[orderOwnerIdx[headIdx]]?.slice(-4) || '?');
          }
        }
        headIdx = orderNext[headIdx];
      }

      if (levelSize > 0) {
        bidTotal += levelSize;
        const entry: OrderLevel = {
          price: pmin + bidIdx * tick,
          size: levelSize,
          total: bidTotal,
        };
        if (showOwners) entry.owners = levelOwners;
        newBids.push(entry);
      }

      // Find previous non-empty bid level
      bidIdx = findPrevLevel(book.bitmapBid, bidIdx - 1);
    }

    // Extract asks (ascending by price)
    const newAsks: OrderLevel[] = [];
    let askTotal = 0;

    const { levelHeadAsk, bestAskIdx, levels } = book;

    let askIdx = bestAskIdx;
    while (askIdx !== -1 && newAsks.length < depth) {
      let headIdx = levelHeadAsk[askIdx];
      let levelSize = 0;
      const levelOwners: string[] = [];

      while (headIdx !== -1) {
        if (orderActive[headIdx]) {
          levelSize += orderQtyLots[headIdx];
          if (showOwners) {
            levelOwners.push(owners[orderOwnerIdx[headIdx]]?.slice(-4) || '?');
          }
        }
        headIdx = orderNext[headIdx];
      }

      if (levelSize > 0) {
        askTotal += levelSize;
        const entry: OrderLevel = {
          price: pmin + askIdx * tick,
          size: levelSize,
          total: askTotal,
        };
        if (showOwners) entry.owners = levelOwners;
        newAsks.push(entry);
      }

      // Find next non-empty ask level
      askIdx = findNextLevel(book.bitmapAsk, levels, askIdx + 1);
    }

    bids = newBids;
    asks = newAsks;

    // Calculate spread
    const firstAsk = newAsks[0];
    const firstBid = newBids[0];
    if (firstBid && firstAsk) {
      spread = firstAsk.price - firstBid.price;
      spreadPercent = ((spread / firstAsk.price) * 100).toFixed(3);
    } else {
      spread = null;
      spreadPercent = '-';
    }

    lastUpdate = Date.now();
  }

  function findPrevLevel(bitmap: Uint32Array | number[], start: number): number {
    for (let i = start; i >= 0; i--) {
      const w = Math.floor(i / 32);
      const b = i & 31;
      if (bitmap[w] && (bitmap[w] & (1 << b))) return i;
    }
    return -1;
  }

  function findNextLevel(bitmap: Uint32Array | number[], levels: number, start: number): number {
    for (let i = start; i < levels; i++) {
      const w = Math.floor(i / 32);
      const b = i & 31;
      if (bitmap[w] && (bitmap[w] & (1 << b))) return i;
    }
    return -1;
  }

  function formatPrice(price: number): string {
    return price.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  }

  function formatSize(size: number): string {
    if (size >= 1_000_000) return (size / 1_000_000).toFixed(2) + 'M';
    if (size >= 1_000) return (size / 1_000).toFixed(2) + 'K';
    return size.toString();
  }

  // Max size for bar scaling
  $: maxBidSize = Math.max(...bids.map(b => b.size), 1);
  $: maxAskSize = Math.max(...asks.map(a => a.size), 1);
  $: maxSize = Math.max(maxBidSize, maxAskSize);

  onMount(() => {
    extractOrderbook();
    pollInterval = setInterval(extractOrderbook, POLL_MS) as unknown as number;
  });

  onDestroy(() => {
    if (pollInterval) clearInterval(pollInterval);
  });

  // React to hubId/pairId changes
  $: if (hubId || pairId) extractOrderbook();
</script>

<div class="orderbook-panel">
  <div class="header">
    <span class="title">Order Book</span>
    <span class="pair">{pairId.replace('/', ' / ')}</span>
  </div>

  <div class="spread-row">
    <span class="spread-label">Spread</span>
    <span class="spread-value">{spread !== null ? formatPrice(spread) : '-'}</span>
    <span class="spread-percent">({spreadPercent}%)</span>
  </div>

  <div class="book-container">
    <!-- Asks (sells) - shown in reverse order, lowest ask at bottom -->
    <div class="asks-section">
      {#each [...asks].reverse() as ask, i}
        <div class="row ask-row">
          <div class="bar ask-bar" style="width: {(ask.size / maxSize) * 100}%"></div>
          <span class="price ask-price">{formatPrice(ask.price)}</span>
          <span class="size">{formatSize(ask.size)}</span>
          <span class="total">{formatSize(ask.total)}</span>
          {#if showOwners && ask.owners}
            <span class="owners">{ask.owners.join(',')}</span>
          {/if}
        </div>
      {:else}
        <div class="empty-side">No asks</div>
      {/each}
    </div>

    <!-- Spread indicator -->
    <div class="spread-indicator">
      {#if spread !== null}
        <span class="mid-price">{formatPrice((bids[0]?.price || 0) + (spread / 2))}</span>
      {/if}
    </div>

    <!-- Bids (buys) -->
    <div class="bids-section">
      {#each bids as bid, i}
        <div class="row bid-row">
          <div class="bar bid-bar" style="width: {(bid.size / maxSize) * 100}%"></div>
          <span class="price bid-price">{formatPrice(bid.price)}</span>
          <span class="size">{formatSize(bid.size)}</span>
          <span class="total">{formatSize(bid.total)}</span>
          {#if showOwners && bid.owners}
            <span class="owners">{bid.owners.join(',')}</span>
          {/if}
        </div>
      {:else}
        <div class="empty-side">No bids</div>
      {/each}
    </div>
  </div>

  <div class="footer">
    <span class="hub-label">Hub: {hubId ? formatEntityId(hubId) : 'None'}</span>
    <span class="update-time">Updated: {new Date(lastUpdate).toLocaleTimeString()}</span>
  </div>
</div>

<style>
  .orderbook-panel {
    background: var(--bg-secondary, #1a1a2e);
    border: 1px solid var(--border-color, #333);
    border-radius: 8px;
    padding: 12px;
    font-family: 'JetBrains Mono', 'Fira Code', monospace;
    font-size: 12px;
    min-width: 280px;
  }

  .header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--border-color, #333);
  }

  .title {
    font-weight: 600;
    color: var(--text-primary, #fff);
  }

  .pair {
    color: var(--text-secondary, #888);
    font-size: 11px;
  }

  .spread-row {
    display: flex;
    justify-content: center;
    gap: 8px;
    padding: 4px 0;
    color: var(--text-secondary, #888);
    font-size: 11px;
  }

  .spread-value {
    color: var(--text-primary, #fff);
  }

  .book-container {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .asks-section, .bids-section {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .spread-indicator {
    display: flex;
    justify-content: center;
    padding: 6px 0;
    border-top: 1px solid var(--border-color, #333);
    border-bottom: 1px solid var(--border-color, #333);
    margin: 4px 0;
  }

  .mid-price {
    color: var(--text-primary, #fff);
    font-weight: 600;
  }

  .row {
    display: grid;
    grid-template-columns: 1fr 60px 50px;
    gap: 8px;
    padding: 3px 6px;
    position: relative;
    align-items: center;
  }

  .bar {
    position: absolute;
    top: 0;
    bottom: 0;
    opacity: 0.15;
    pointer-events: none;
  }

  .bid-bar {
    background: #22c55e;
    right: 0;
  }

  .ask-bar {
    background: #ef4444;
    right: 0;
  }

  .price {
    font-weight: 500;
    z-index: 1;
  }

  .bid-price {
    color: #22c55e;
  }

  .ask-price {
    color: #ef4444;
  }

  .size, .total {
    text-align: right;
    color: var(--text-secondary, #888);
    z-index: 1;
  }

  .owners {
    font-size: 10px;
    color: var(--text-tertiary, #555);
  }

  .empty-side {
    text-align: center;
    color: var(--text-tertiary, #555);
    padding: 12px;
    font-style: italic;
  }

  .footer {
    display: flex;
    justify-content: space-between;
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px solid var(--border-color, #333);
    font-size: 10px;
    color: var(--text-tertiary, #555);
  }
</style>
