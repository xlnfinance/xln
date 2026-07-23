<script lang="ts">
  import type { RoutedSwapRouteCandidate } from './routed-swap-planner';

  export let orderAmountInput = '';
  export let giveToken = 0;
  export let wantToken = 0;
  export let giveTokenDecimals = 18;
  export let giveAmount: bigint = 0n;
  export let canonicalGiveAmount: bigint = 0n;
  export let routeSummaryLabel = '';
  export let routePathLabel = '';
  export let routeVenueDisplayLabel = '';
  export let routeSummaryAssetsLabel = '';
  export let routeDetailsOpen = false;
  export let swapRouteMode: 'same' | 'cross' = 'same';
  export let liveSelectedRouteValue = '';
  export let routePathSourceLabel = '';
  export let routePathTargetLabel = '';
  export let selectedRouteLabel = '';
  export let sourceRouteEntityLabel = '';
  export let targetRouteEntityLabel = '';
  export let showManualRouteRecommendation = false;
  export let routedRouteRecommendations: RoutedSwapRouteCandidate[] = [];
  export let manualRouteEstimateLabel: (route: RoutedSwapRouteCandidate) => string = () => '';
</script>

<div
  class="route-builder"
  class:cross-route={swapRouteMode === 'cross'}
  data-testid="swap-route-picker"
  data-order-amount-state={orderAmountInput}
  data-give-token={giveToken}
  data-want-token={wantToken}
  data-give-decimals={giveTokenDecimals}
  data-give-amount={giveAmount.toString()}
  data-canonical-give-amount={canonicalGiveAmount.toString()}
>
  <button
    type="button"
    class="route-summary"
    title={`${routeSummaryLabel} · ${routePathLabel} · ${routeVenueDisplayLabel}`}
    on:click={() => routeDetailsOpen = !routeDetailsOpen}
  >
    <span>Route</span>
    <strong>{routeSummaryLabel}</strong>
    <em>{routeSummaryAssetsLabel}</em>
  </button>
  <div
    class="route-flow"
    data-testid="swap-route-flow"
    data-selected-route-value={liveSelectedRouteValue}
    data-route-mode={swapRouteMode}
    data-source-jurisdiction={routePathSourceLabel}
    data-target-jurisdiction={routePathTargetLabel}
    data-route-venue={routeVenueDisplayLabel}
    data-selected-route-label={selectedRouteLabel}
  >
    <span title={`${sourceRouteEntityLabel} -> ${targetRouteEntityLabel}`}>{routePathLabel}</span>
    <em>via {routeVenueDisplayLabel}</em>
  </div>
  {#if routeDetailsOpen}
    <div class="route-details">
      <span>Source account: {sourceRouteEntityLabel}</span>
      <span>Target account: {targetRouteEntityLabel}</span>
      <span>Venue/orderbook: {routeVenueDisplayLabel}</span>
    </div>
  {/if}
  {#if showManualRouteRecommendation}
    <div class="manual-route-card" data-testid="swap-route-recommendation">
      <div class="manual-route-head">
        <span>No direct orderbook</span>
        <strong>Swap manually in order</strong>
      </div>
      {#each routedRouteRecommendations as route (route.id)}
        <div
          class="manual-route-row"
          data-testid="swap-route-recommendation-row"
          data-route-id={route.id}
          data-hop-count={route.hops.length}
        >
          <span>{route.label}</span>
          <strong>{manualRouteEstimateLabel(route)}</strong>
          <em>{route.summary}</em>
        </div>
      {/each}
    </div>
  {/if}
</div>
