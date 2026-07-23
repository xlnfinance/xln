<script lang="ts">
  export let priceRatioInput = '';
  export let quoteTokenSymbol = '';
  export let marketPriceTicks: bigint | null = null;
  export let marketPriceSideLabel = '';
  export let marketPriceLabel = '';
  export let bookVenueLabel = '';
  export let orderPercent = 100;
  export let handlePriceRatioInput: (event: Event) => void = () => {};
  export let stepPrice: (direction: 1 | -1) => void = () => {};
  export let useMarketPrice: () => void = () => {};
  export let applyOrderPercent: (percent: number) => void = () => {};
</script>

<div class="quote-row">
  <span class="input-label">Limit rate</span>
  <input
    type="text"
    bind:value={priceRatioInput}
    inputmode="decimal"
    data-testid="swap-order-price"
    aria-label="Swap limit rate"
    on:input={handlePriceRatioInput}
  />
  <span class="input-suffix">{quoteTokenSymbol}</span>
  <div class="input-steppers">
    <button type="button" class="step-btn" on:click={() => stepPrice(1)}>▲</button>
    <button type="button" class="step-btn" on:click={() => stepPrice(-1)}>▼</button>
  </div>
</div>

<div class="market-strip">
  <button
    type="button"
    class="market-price-btn"
    data-testid="swap-use-market-price"
    disabled={!marketPriceTicks || marketPriceTicks <= 0n}
    on:click={useMarketPrice}
  >
    <span>{marketPriceSideLabel}</span>
    <strong>{marketPriceLabel}</strong>
  </button>
  <span class="book-owner-label" title={bookVenueLabel}>{bookVenueLabel}</span>
</div>

<div class="size-slider-row">
  <input
    type="range"
    class="diamond-slider"
    min="0"
    max="100"
    step="1"
    style="--xln-slider-progress: {orderPercent}%"
    value={orderPercent}
    on:input={(event) => applyOrderPercent(Number(event.currentTarget.value))}
  />
  <div class="slider-marks">
    {#each [0, 25, 50, 75, 100] as mark}
      <span
        class="slider-mark-group"
        class:filled={orderPercent >= mark}
        on:click={() => applyOrderPercent(mark)}
        on:keydown={(event) => event.key === 'Enter' && applyOrderPercent(mark)}
        role="button"
        tabindex="0"
      ><span class="slider-diamond">&#9671;</span><span class="slider-pct">{mark}%</span></span>
    {/each}
  </div>
</div>
