<script lang="ts">
  import type { CrossJurisdictionSwapRoute, SwapBookEntry } from '@xln/core/api/public/runtime-module';
  import { isCrossJurisdictionTerminalStatus } from '@xln/core/extensions/cross-j';
  import { toBigIntSafe } from '../swap-formatting';
  import type { ClosedOrderStatus, ClosedOrderView, OfferLike, PairOrientation } from './swap-order-history';

  export let orderListTab: 'open' | 'closed' = 'open';
  export let closedOrderStatusFilter: 'all' | ClosedOrderStatus = 'all';
  export let openOrders: SwapBookEntry[] = [];
  export let crossOrders: CrossJurisdictionSwapRoute[] = [];
  export let sourceEntityIdValue = '';
  export let crossNetworkLabel: (stackId: string) => string = stackId => stackId;
  export let closedOrderViews: ClosedOrderView[] = [];
  export let filteredClosedOrderViews: ClosedOrderView[] = [];
  export let totalPriceImprovementSummary = '';
  export let offerPriceImprovementByKey: Map<string, { amount: bigint; tokenId: number | null }> = new Map();
  export let minOrderNotionalUsd = 10;
  export let tokenSymbol: (tokenId: number) => string = (tokenId) => `Token #${tokenId}`;
  export let resolvePairOrientation: (tokenA: number, tokenB: number) => PairOrientation = (tokenA, tokenB) => ({
    baseTokenId: tokenA,
    quoteTokenId: tokenB,
  });
  export let offerLifecycleKey: (accountId: string, offerId: string) => string = (accountId, offerId) => `${accountId}:${offerId}`;
  export let offerSideLabel: (offer: OfferLike) => 'Ask' | 'Bid' = () => 'Ask';
  export let offerPriceTicks: (offer: OfferLike) => bigint = () => 0n;
  export let isDustOpenOffer: (offer: SwapBookEntry) => boolean = () => false;
  export let remainingOfferUsd: (offer: SwapBookEntry) => number = () => 0;
  export let formatPriceTicks: (ticks: bigint) => string = (ticks) => String(ticks);
  export let formatAmount: (amount: bigint, tokenId: number) => string = (amount) => String(amount);
  export let formatPriceImprovement: (amount: bigint, tokenId: number | null) => string = (amount) => String(amount);
  export let formatCloseComment: (comment: string) => string = (comment) => comment;
  export let formatOrderTime: (ms: number) => string = (ms) => String(ms);
  export let closedOrderStatusLabel: (status: ClosedOrderStatus) => string = (status) => status;
  export let closedOrderStatusTone: (status: ClosedOrderStatus) => 'bid' | 'ask' | 'neutral' = () => 'neutral';
  export let closedHistoryLoading = false;
  export let closedHistoryHasMore = false;
  export let onSelectClosedHistory: () => void | Promise<void> = () => {};
  export let onLoadOlderClosedHistory: () => void | Promise<void> = () => {};
  export let cancelSwapOffer: (offerId: string, accountId: string) => void | Promise<void> = () => {};
  export let requestCrossClear: (offerId: string, cancelRemainder?: boolean) => void | Promise<void> = () => {};
</script>

<div class="section section-orders">
  {#if crossOrders.length > 0}
    <section aria-label="Recent cross-network orders" data-testid="cross-swap-orders">
      <h4>Recent cross-network orders</h4>
      <p>Confirmed route status from this account's latest view. Matched amounts remain pending until settlement; a closed route releases its unfilled remainder.</p>
      {#each crossOrders as route (route.orderId)}
        {@const terminal = isCrossJurisdictionTerminalStatus(route.status)}
        <article class="cross-route-result" data-testid="cross-swap-order" data-order-id={route.orderId} data-status={route.status}>
          <strong>{crossNetworkLabel(route.source.jurisdiction)} → {crossNetworkLabel(route.target.jurisdiction)}</strong>
          <p>Order: {formatAmount(route.source.amount, route.source.tokenId)} {tokenSymbol(route.source.tokenId)} → {formatAmount(route.target.amount, route.target.tokenId)} {tokenSymbol(route.target.tokenId)}</p>
          <p role="status" data-testid="cross-swap-status">
            {#if route.status === 'settled'}Settled · closed
            {:else if terminal}{route.status === 'cancelled' ? 'Cancelled' : 'Expired'} · closed
            {:else}Pending · {route.status.replace(/_/g, ' ')}{/if}
          </p>
          {#if route.status === 'settled'}
            <p data-testid="cross-swap-delivery">Delivered: {formatAmount(route.filledSourceAmount ?? 0n, route.source.tokenId)} {tokenSymbol(route.source.tokenId)} → {formatAmount(route.filledTargetAmount ?? 0n, route.target.tokenId)} {tokenSymbol(route.target.tokenId)}</p>
          {:else if !terminal}
            <p>Matched, pending settlement: {formatAmount(route.filledSourceAmount ?? 0n, route.source.tokenId)} {tokenSymbol(route.source.tokenId)} → {formatAmount(route.filledTargetAmount ?? 0n, route.target.tokenId)} {tokenSymbol(route.target.tokenId)}</p>
          {:else}<p>No funds delivered.</p>{/if}
          {#if !terminal && route.source.entityId.toLowerCase() === sourceEntityIdValue}
            <button class="cancel-btn" data-testid="cross-swap-clear" disabled={route.status === 'clearing' || route.status === 'clear_requested'} on:click={() => requestCrossClear(route.orderId, true)}>Clear + Close</button>
          {/if}
          {#if route.error}<p role="alert">{route.error}</p>{/if}
          <details><summary>Order evidence</summary><code>{route.orderId}</code><p>Check the receiving account on {crossNetworkLabel(route.target.jurisdiction)} to verify its balance.</p></details>
        </article>
      {/each}
    </section>
  {/if}
  <div class="orders-toolbar">
    <div class="orders-header-left">
      <h4 class="orders-inline-title">Same-network orders</h4>
      <div class="orders-tabs" role="tablist" aria-label="Swap orders">
        <button
          type="button"
          class="orders-tab-text"
          class:active={orderListTab === 'open'}
          aria-pressed={orderListTab === 'open'}
          data-testid="swap-orders-tab-open"
          on:click={() => (orderListTab = 'open')}
        >Open ({openOrders.length})</button>
        <button
          type="button"
          class="orders-tab-text"
          class:active={orderListTab === 'closed'}
          aria-pressed={orderListTab === 'closed'}
          data-testid="swap-orders-tab-closed"
          on:click={() => {
            orderListTab = 'closed';
            void onSelectClosedHistory();
          }}
        >Closed ({closedOrderViews.length})</button>
      </div>
    </div>
    <label class="closed-status-filter" class:is-hidden={orderListTab !== 'closed'}>
      <span>Status</span>
      <select bind:value={closedOrderStatusFilter} disabled={orderListTab !== 'closed'}>
        <option value="all">All</option>
        <option value="filled">Filled</option>
        <option value="partial">Partial</option>
        <option value="canceled">Canceled</option>
        <option value="closed">Closed</option>
      </select>
    </label>
  </div>
  {#if orderListTab === 'closed' && totalPriceImprovementSummary}
    <p class="improvement-summary">Total price improvement: <strong>{totalPriceImprovementSummary}</strong></p>
  {/if}

  {#if orderListTab === 'open'}
    {#if openOrders.length === 0}
      <div class="orders-empty">No open orders yet.</div>
    {:else}
      <div class="orders-table-wrap">
        <table class="orders-table" data-testid="swap-open-orders">
          <thead>
            <tr>
              <th>Side</th>
              <th>Pair</th>
              <th>Price</th>
              <th>Remaining</th>
              <th>Price Improvement</th>
              <th>Hub</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {#each openOrders as offer (offerLifecycleKey(String(offer.accountId || ''), String(offer.offerId || '')))}
              {@const side = offerSideLabel(offer)}
              {@const pairView = resolvePairOrientation(offer.giveTokenId, offer.wantTokenId)}
              {@const isDust = isDustOpenOffer(offer)}
              {@const remainingUsd = remainingOfferUsd(offer)}
              {@const offerImprovement = offerPriceImprovementByKey.get(offerLifecycleKey(String(offer.accountId || ''), String(offer.offerId || ''))) || { amount: 0n, tokenId: null }}
              <tr data-testid="swap-open-order-row">
                <td>
                  <span class:side-ask={side === 'Ask'} class:side-bid={side === 'Bid'} class="side-badge">{side}</span>
                </td>
                <td>
                  <span>{tokenSymbol(pairView.baseTokenId)}/{tokenSymbol(pairView.quoteTokenId)}</span>
                </td>
                <td>{formatPriceTicks(offerPriceTicks(offer))}</td>
                <td>
                  {#if isDust}
                    <div class="remaining-cell">
                      <span class="dust-label">Dust (&lt;${minOrderNotionalUsd})</span>
                      <span class="dust-amount">
                        {formatAmount(toBigIntSafe(offer.giveAmount) ?? 0n, Number(offer.giveTokenId || 0))} {tokenSymbol(Number(offer.giveTokenId || 0))}
                        {#if remainingUsd > 0}
                          · ~${remainingUsd.toFixed(2)}
                        {/if}
                      </span>
                    </div>
                  {:else}
                    {formatAmount(toBigIntSafe(offer.giveAmount) ?? 0n, Number(offer.giveTokenId || 0))} {tokenSymbol(Number(offer.giveTokenId || 0))}
                  {/if}
                </td>
                <td>{formatPriceImprovement(offerImprovement.amount, offerImprovement.tokenId)}</td>
                <td>{String(offer.accountId || '').slice(0, 10)}...</td>
                <td>
                  <button class="cancel-btn" data-testid="swap-open-order-cancel" on:click={() => cancelSwapOffer(String(offer.offerId || ''), String(offer.accountId || ''))}>Request Cancel</button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  {:else}
    {#if filteredClosedOrderViews.length === 0}
      <div class="orders-empty">No closed orders for selected filter.</div>
    {:else}
      <div class="orders-table-wrap">
        <table class="orders-table" data-testid="swap-closed-orders">
          <thead>
            <tr>
              <th>Status</th>
              <th>Pair</th>
              <th>Price</th>
              <th>Filled</th>
              <th>Executed</th>
              <th>Fee</th>
              <th>Price Improvement</th>
              <th>Closed At</th>
              <th>Hub</th>
            </tr>
          </thead>
          <tbody>
            {#each filteredClosedOrderViews as order (offerLifecycleKey(order.accountId, order.offerId))}
              {@const pairView = resolvePairOrientation(order.giveTokenId, order.wantTokenId)}
              <tr data-testid="swap-closed-order-row">
                <td>
                  <span class:side-ask={closedOrderStatusTone(order.status) === 'ask'} class:side-bid={closedOrderStatusTone(order.status) === 'bid'} class="side-badge">
                    {closedOrderStatusLabel(order.status)}
                  </span>
                  {#if order.closeComment}
                    <div class="close-comment">{formatCloseComment(order.closeComment)}</div>
                  {/if}
                </td>
                <td>{order.pairLabel}</td>
                <td>{formatPriceTicks(order.priceTicks)}</td>
                <td>
                  {order.filledPercent.toFixed(2)}%
                  ({formatAmount(order.filledBaseAmount, pairView.baseTokenId)} {tokenSymbol(pairView.baseTokenId)})
                </td>
                <td data-testid="swap-closed-execution">{formatAmount(order.filledGiveAmount, order.giveTokenId)} {tokenSymbol(order.giveTokenId)} → {formatAmount(order.filledWantAmount, order.wantTokenId)} {tokenSymbol(order.wantTokenId)}</td>
                <td data-testid="swap-closed-fee">{order.feeTokenId === null ? '—' : `${formatAmount(order.feeAmount, order.feeTokenId)} ${tokenSymbol(order.feeTokenId)}`}</td>
                <td>{formatPriceImprovement(order.priceImprovementAmount, order.priceImprovementTokenId)}</td>
                <td>{formatOrderTime(order.closedAt)}</td>
                <td>{order.accountId.slice(0, 10)}...</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
    {#if closedHistoryHasMore}
      <div class="orders-history-more">
        <button
          type="button"
          class="cancel-btn"
          disabled={closedHistoryLoading}
          data-testid="swap-closed-orders-load-more"
          on:click={() => void onLoadOlderClosedHistory()}
        >{closedHistoryLoading ? 'Loading…' : 'Load older orders'}</button>
      </div>
    {/if}
  {/if}
</div>

<style>
  .cross-route-result { margin: 12px 0; padding: 12px; border: 1px solid var(--border-color, #627084); border-radius: 8px; overflow-wrap: anywhere; }
  .cross-route-result p { margin: 6px 0; }
</style>
