<script lang="ts">
  import type { SwapBookEntry } from '@xln/runtime/xln-api';
  import { toBigIntSafe } from './swap-formatting';
  import type { ClosedOrderStatus, ClosedOrderView, OfferLike, PairOrientation } from './swap-order-history';

  export let orderListTab: 'open' | 'closed' = 'open';
  export let orderRouteFilter: 'all' | 'same' | 'cross' = 'all';
  export let closedOrderStatusFilter: 'all' | ClosedOrderStatus = 'all';
  export let openOrders: SwapBookEntry[] = [];
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
  export let cancelSwapOffer: (offerId: string, accountId: string) => void | Promise<void> = () => {};
  export let requestCrossClear: (offerId: string, cancelRemainder?: boolean) => void | Promise<void> = () => {};
</script>

<div class="section section-orders">
  <div class="orders-toolbar">
    <div class="orders-header-left">
      <h4 class="orders-inline-title">Orders</h4>
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
          on:click={() => (orderListTab = 'closed')}
        >Closed ({closedOrderViews.length})</button>
      </div>
    </div>
    <label class="closed-status-filter" class:is-hidden={orderListTab !== 'open'}>
      <span>Route</span>
      <select bind:value={orderRouteFilter} disabled={orderListTab !== 'open'} data-testid="swap-orders-route-filter">
        <option value="all">All</option>
        <option value="same">Same</option>
        <option value="cross">Cross-j</option>
      </select>
    </label>
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
                  {#if offer.crossJurisdiction}
                    <span class="route-badge">Cross-j</span>
                  {/if}
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
                  {#if offer.crossJurisdiction}
                    {@const route = offer.crossJurisdiction}
                    {@const pendingAmount = toBigIntSafe(route.filledSourceAmount ?? route.sourceClaimed ?? 0n) ?? 0n}
                    {@const settledAmount = String(route.status || '') === 'settled' ? pendingAmount : 0n}
                    <div class="cross-fill-meta">
                      <span>{String(route.status || 'resting').replace(/_/g, ' ')}</span>
                      <span>pending {formatAmount(pendingAmount, Number(offer.giveTokenId || 0))}</span>
                      <span>settled {formatAmount(settledAmount, Number(offer.giveTokenId || 0))}</span>
                    </div>
                  {/if}
                </td>
                <td>{formatPriceImprovement(offerImprovement.amount, offerImprovement.tokenId)}</td>
                <td>{String(offer.accountId || '').slice(0, 10)}...</td>
                <td>
                  {#if offer.crossJurisdiction}
                    <div class="cross-order-actions">
                      <button class="cancel-btn" data-testid="cross-swap-clear" on:click={() => requestCrossClear(String(offer.offerId || ''), true)}>
                        Clear + Close
                      </button>
                    </div>
                  {:else}
                    <button class="cancel-btn" data-testid="swap-open-order-cancel" on:click={() => cancelSwapOffer(String(offer.offerId || ''), String(offer.accountId || ''))}>
                      Request Cancel
                    </button>
                  {/if}
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
                <td>{formatPriceImprovement(order.priceImprovementAmount, order.priceImprovementTokenId)}</td>
                <td>{formatOrderTime(order.closedAt)}</td>
                <td>{order.accountId.slice(0, 10)}...</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  {/if}
</div>
