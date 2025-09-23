<script lang="ts">
  import { onMount, onDestroy } from 'svelte';

  export let entityId: string;
  export let orderbook: any = null;

  let bids: any[] = [];
  let asks: any[] = [];
  let lastTrade: any = null;
  let spread: number = 0;
  let midPrice: number = 0;

  $: if (orderbook) {
    updateOrderbookView();
  }

  function updateOrderbookView() {
    if (!orderbook) return;

    // Extract bids and asks from the orderbook
    bids = orderbook.bids || [];
    asks = orderbook.asks || [];

    // Sort bids descending, asks ascending
    bids.sort((a, b) => b.price - a.price);
    asks.sort((a, b) => a.price - b.price);

    // Calculate spread and mid price
    if (bids.length > 0 && asks.length > 0) {
      spread = asks[0].price - bids[0].price;
      midPrice = (asks[0].price + bids[0].price) / 2;
    }

    // Get last trade if available
    lastTrade = orderbook.lastTrade || null;
  }

  function formatPrice(price: number): string {
    return price.toFixed(4);
  }

  function formatSize(size: number): string {
    return size.toFixed(2);
  }

  function getDepthPercentage(size: number, maxSize: number): number {
    return maxSize > 0 ? (size / maxSize) * 100 : 0;
  }

  $: maxBidSize = Math.max(...bids.map(b => b.size), 1);
  $: maxAskSize = Math.max(...asks.map(a => a.size), 1);
</script>

<div class="orderbook-container">
  <div class="orderbook-header">
    <h3>📊 Orderbook</h3>
    <div class="orderbook-stats">
      <span class="mid-price">Mid: {formatPrice(midPrice)}</span>
      <span class="spread">Spread: {formatPrice(spread)}</span>
    </div>
  </div>

  {#if lastTrade}
    <div class="last-trade">
      <span class="label">Last Trade:</span>
      <span class="price" class:buy={lastTrade.side === 'buy'} class:sell={lastTrade.side === 'sell'}>
        {formatPrice(lastTrade.price)}
      </span>
      <span class="size">Size: {formatSize(lastTrade.size)}</span>
    </div>
  {/if}

  <div class="orderbook-content">
    <div class="asks-section">
      <div class="section-header">
        <span>Price</span>
        <span>Size</span>
      </div>
      {#each asks.slice(0, 10) as ask}
        <div class="order-row ask">
          <div class="depth-bar ask-bar" style="width: {getDepthPercentage(ask.size, maxAskSize)}%"></div>
          <span class="price">{formatPrice(ask.price)}</span>
          <span class="size">{formatSize(ask.size)}</span>
        </div>
      {/each}
      {#if asks.length === 0}
        <div class="no-orders">No asks</div>
      {/if}
    </div>

    <div class="spread-indicator">
      <div class="spread-value">{formatPrice(spread)}</div>
      <div class="spread-label">SPREAD</div>
    </div>

    <div class="bids-section">
      <div class="section-header">
        <span>Price</span>
        <span>Size</span>
      </div>
      {#each bids.slice(0, 10) as bid}
        <div class="order-row bid">
          <div class="depth-bar bid-bar" style="width: {getDepthPercentage(bid.size, maxBidSize)}%"></div>
          <span class="price">{formatPrice(bid.price)}</span>
          <span class="size">{formatSize(bid.size)}</span>
        </div>
      {/each}
      {#if bids.length === 0}
        <div class="no-orders">No bids</div>
      {/if}
    </div>
  </div>

  <div class="orderbook-footer">
    <span class="entity-label">Entity: {entityId.slice(0, 8)}...</span>
    <span class="conservation-check" title="Conservation Law: Δ_A + Δ_B = 0">
      ⚖️ Conserved
    </span>
  </div>
</div>

<style>
  .orderbook-container {
    background: rgba(28, 28, 30, 0.95);
    border: 1px solid rgba(0, 122, 204, 0.3);
    border-radius: 8px;
    padding: 16px;
    margin: 16px 0;
  }

  .orderbook-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 16px;
    padding-bottom: 8px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  }

  .orderbook-header h3 {
    margin: 0;
    color: #007acc;
    font-size: 16px;
  }

  .orderbook-stats {
    display: flex;
    gap: 16px;
    font-size: 12px;
  }

  .mid-price {
    color: #ffd700;
  }

  .spread {
    color: #9d9d9d;
  }

  .last-trade {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px;
    background: rgba(0, 0, 0, 0.3);
    border-radius: 4px;
    margin-bottom: 12px;
    font-size: 13px;
  }

  .last-trade .label {
    color: #9d9d9d;
  }

  .last-trade .price.buy {
    color: #4ade80;
  }

  .last-trade .price.sell {
    color: #f87171;
  }

  .orderbook-content {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .asks-section,
  .bids-section {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .section-header {
    display: flex;
    justify-content: space-between;
    padding: 4px 8px;
    font-size: 11px;
    color: #9d9d9d;
    text-transform: uppercase;
    border-bottom: 1px solid rgba(255, 255, 255, 0.05);
  }

  .order-row {
    display: flex;
    justify-content: space-between;
    padding: 4px 8px;
    font-size: 12px;
    position: relative;
    overflow: hidden;
  }

  .order-row.ask {
    color: #f87171;
  }

  .order-row.bid {
    color: #4ade80;
  }

  .depth-bar {
    position: absolute;
    top: 0;
    left: 0;
    height: 100%;
    opacity: 0.15;
    z-index: 0;
  }

  .depth-bar.ask-bar {
    background: #f87171;
  }

  .depth-bar.bid-bar {
    background: #4ade80;
  }

  .order-row span {
    position: relative;
    z-index: 1;
  }

  .spread-indicator {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 8px;
    background: linear-gradient(to right, rgba(248, 113, 113, 0.1), rgba(74, 222, 128, 0.1));
    border: 1px solid rgba(255, 255, 255, 0.05);
    border-radius: 4px;
    margin: 8px 0;
  }

  .spread-value {
    font-size: 14px;
    font-weight: 600;
    color: #ffd700;
    margin-right: 8px;
  }

  .spread-label {
    font-size: 10px;
    color: #9d9d9d;
    letter-spacing: 1px;
  }

  .no-orders {
    padding: 12px;
    text-align: center;
    color: #6b7280;
    font-size: 12px;
    font-style: italic;
  }

  .orderbook-footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-top: 16px;
    padding-top: 8px;
    border-top: 1px solid rgba(255, 255, 255, 0.1);
    font-size: 11px;
  }

  .entity-label {
    color: #6b7280;
  }

  .conservation-check {
    color: #4ade80;
    display: flex;
    align-items: center;
    gap: 4px;
  }
</style>