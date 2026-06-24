<script lang="ts">
  import OrderbookPanel from '../Trading/OrderbookPanel.svelte';
  import type { OrderbookSnapshot } from './routed-swap-planner';
  import type { SwapOrderbookLevelClickDetail, SwapOrderbookPairOption } from './swap-orderbook-view';

  export let activeBookHubId = '';
  export let orderbookHubIds: string[] = [];
  export let activeOrderAccountId = '';
  export let selectedBookAccountId = '';
  export let createOrderAccountId = '';
  export let selectedRouteSourceHub = '';
  export let selectedRouteTargetHub = '';
  export let selectedCrossTargetHub = '';
  export let swapRouteMode: 'same' | 'cross' = 'same';
  export let orderbookPairSelectValue = '';
  export let lastOrderbookPairSelectValue = '';
  export let lastOrderbookPairSelectMode = '';
  export let lastOrderbookPairSelectRoute = '';
  export let lastOrderbookPairSelectCommit = '';
  export let orderbookPairDisplayLabel = '';
  export let orderbookPairOptions: SwapOrderbookPairOption[] = [];
  export let orderbookScopeMode: 'aggregated' | 'selected' = 'selected';
  export let visibleOrderbookHubIds: string[] = [];
  export let activeOrderbookRelayUrl = '';
  export let orderbookPairId = '1/2';
  export let orderbookDepth = 10;
  export let orderbookSourceLabels: Record<string, string> = {};
  export let orderbookSourceAvatars: Record<string, string> = {};
  export let ownOrderbookEntityIds: string[] = [];
  export let orderbookPriceScale = 1;
  export let orderbookSizeDisplayScale = 1;
  export let orderMode: 'buy-base' | 'sell-base' | 'none' = 'none';
  export let orderbookRefreshNonce = 0;
  export let handleOrderbookPairSelectChange: (event: Event) => void;
  export let toggleOrderbookScope: () => void;
  export let handleOrderbookLevelClick: (event: CustomEvent<SwapOrderbookLevelClickDetail>) => void;
  export let handleOrderbookSnapshot: (event: CustomEvent<OrderbookSnapshot>) => void;
</script>

<div
  class="section section-market"
  data-testid="swap-market-section"
  data-active-book-hub-id={activeBookHubId}
  data-orderbook-hub-ids={orderbookHubIds.join(',')}
  data-active-order-account-id={activeOrderAccountId}
  data-selected-book-account-id={selectedBookAccountId}
  data-create-order-account-id={createOrderAccountId}
  data-selected-route-source-hub={selectedRouteSourceHub}
  data-selected-route-target-hub={selectedRouteTargetHub}
  data-selected-cross-target-hub={selectedCrossTargetHub}
  data-route-mode={swapRouteMode}
  data-orderbook-pair-select-value={orderbookPairSelectValue}
  data-last-orderbook-pair-select-value={lastOrderbookPairSelectValue}
  data-last-orderbook-pair-select-mode={lastOrderbookPairSelectMode}
  data-last-orderbook-pair-select-route={lastOrderbookPairSelectRoute}
  data-last-orderbook-pair-select-commit={lastOrderbookPairSelectCommit}
>
  <div class="book-toolbar">
    <div class="book-title">
      <span>Orderbook</span>
      <label class="orderbook-pair-select">
        <strong>{orderbookPairDisplayLabel}</strong>
        <select
          value={orderbookPairSelectValue}
          data-testid="swap-orderbook-pair-select"
          aria-label="Orderbook pair"
          title={orderbookPairDisplayLabel}
          on:change={handleOrderbookPairSelectChange}
        >
          {#each orderbookPairOptions as option (option.value)}
            <option value={option.value}>{option.label}</option>
          {/each}
        </select>
      </label>
    </div>
    <button
      type="button"
      class="scope-btn"
      class:active={orderbookScopeMode === 'aggregated'}
      data-testid="swap-scope-toggle"
      data-scope-mode={orderbookScopeMode}
      disabled={swapRouteMode === 'cross'}
      on:click={toggleOrderbookScope}
    >
      {orderbookScopeMode === 'aggregated' ? 'All hubs' : 'Selected'}
    </button>
  </div>
  {#if orderbookHubIds.length > 0}
    <div class="orderbook-wrap" data-testid="swap-orderbook">
      <OrderbookPanel
        hubIds={visibleOrderbookHubIds}
        hubId={activeBookHubId || selectedBookAccountId}
        relayUrl={activeOrderbookRelayUrl}
        pairId={orderbookPairId}
        pairLabel={orderbookPairDisplayLabel}
        depth={orderbookDepth}
        showSources={true}
        sourceLabels={orderbookSourceLabels}
        sourceAvatars={orderbookSourceAvatars}
        ownEntityIds={ownOrderbookEntityIds}
        compactHeader={true}
        showPriceStepControl={false}
        priceScale={orderbookPriceScale}
        sizeDisplayScale={orderbookSizeDisplayScale}
        disablePriceAggregation={true}
        preferredClickSide={orderMode === 'buy-base' ? 'ask' : 'bid'}
        refreshNonce={orderbookRefreshNonce}
        on:levelclick={handleOrderbookLevelClick}
        on:snapshot={handleOrderbookSnapshot}
      />
    </div>
  {:else}
    <div class="orderbook-empty" data-testid="swap-orderbook-empty">No connected account orderbooks yet.</div>
  {/if}
</div>
