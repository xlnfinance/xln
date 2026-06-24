<script lang="ts">
  type HubOption = {
    value: string;
    label: string;
  };

  export let priceRatioInput = '';
  export let quoteTokenSymbol = '';
  export let marketPriceTicks: bigint | null = null;
  export let marketPriceSideLabel = '';
  export let marketPriceLabel = '';
  export let bookVenueLabel = '';
  export let hubMenuOpen = false;
  export let createOrderAccountId = '';
  export let activeOrderAccountId = '';
  export let selectedHubDisplayLabel = '';
  export let selectedHubLabel = '';
  export let selectedHubJurisdictionLabel = '';
  export let selectedHubOptions: HubOption[] = [];
  export let orderPercent = 100;
  export let handlePriceRatioInput: (event: Event) => void = () => {};
  export let stepPrice: (direction: 1 | -1) => void = () => {};
  export let useMarketPrice: () => void = () => {};
  export let toggleHubMenu: () => void = () => {};
  export let handleSelectedHubChange: (nextValue: string) => void = () => {};
  export let selectHubOption: (nextValue: string) => void = () => {};
  export let entityAvatarSrc: (entityIdValue: string) => string = () => '';
  export let entityInitials: (entityIdValue: string, label?: string) => string = () => '';
  export let jurisdictionBadgeText: (jurisdictionName: string) => string = () => '';
  export let formatEntityNetworkLabel: (label: string, jurisdictionLabel: string) => string = (label) => label;
  export let hubJurisdictionLabel: (entityIdValue: string) => string = () => '';
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

<div class="venue-row">
  <span>Hub</span>
  <div class="entity-select-wrap hub-select-wrap" data-swap-menu-root>
    <button
      type="button"
      class="entity-select-button"
      aria-haspopup="listbox"
      aria-expanded={hubMenuOpen}
      title={selectedHubDisplayLabel}
      on:click|stopPropagation={toggleHubMenu}
    >
      <span class="entity-avatar-wrap">
        {#if createOrderAccountId && entityAvatarSrc(createOrderAccountId)}
          <img class="entity-avatar-mini" src={entityAvatarSrc(createOrderAccountId)} alt="" />
        {:else}
          <span class="entity-avatar-mini placeholder">{entityInitials(createOrderAccountId, selectedHubLabel)}</span>
        {/if}
        <span class="jurisdiction-mini-badge">{jurisdictionBadgeText(selectedHubJurisdictionLabel)}</span>
      </span>
      <span class="entity-select-copy">
        <strong>{formatEntityNetworkLabel(selectedHubLabel, selectedHubJurisdictionLabel)}</strong>
      </span>
      <span class="entity-select-chevron" aria-hidden="true">⌄</span>
    </button>
    <select
      class="entity-select-native"
      bind:value={createOrderAccountId}
      data-testid="swap-account-select"
      data-active-order-account-id={activeOrderAccountId}
      title={selectedHubDisplayLabel}
      aria-label="Swap venue"
      on:change={(event) => handleSelectedHubChange((event.currentTarget as HTMLSelectElement).value)}
    >
      {#each selectedHubOptions as hub (hub.value)}
        <option
          value={hub.value}
          selected={hub.value === activeOrderAccountId}
          title={formatEntityNetworkLabel(hub.label, hubJurisdictionLabel(hub.value))}
        >
          {formatEntityNetworkLabel(hub.label, hubJurisdictionLabel(hub.value))}
        </option>
      {/each}
    </select>
    {#if hubMenuOpen}
      <div class="entity-menu hub-menu" role="listbox" aria-label="Hub">
        {#each selectedHubOptions as hub (hub.value)}
          {@const hubJurisdiction = hubJurisdictionLabel(hub.value)}
          <button
            type="button"
            class:selected={hub.value === createOrderAccountId}
            class="entity-option"
            role="option"
            aria-selected={hub.value === createOrderAccountId}
            title={formatEntityNetworkLabel(hub.label, hubJurisdiction)}
            on:click|stopPropagation={() => selectHubOption(hub.value)}
          >
            <span class="entity-avatar-wrap">
              {#if entityAvatarSrc(hub.value)}
                <img class="entity-avatar-mini" src={entityAvatarSrc(hub.value)} alt="" />
              {:else}
                <span class="entity-avatar-mini placeholder">{entityInitials(hub.value, hub.label)}</span>
              {/if}
              <span class="jurisdiction-mini-badge">{jurisdictionBadgeText(hubJurisdiction)}</span>
            </span>
            <span class="entity-select-copy">
              <strong>{formatEntityNetworkLabel(hub.label, hubJurisdiction)}</strong>
            </span>
          </button>
        {/each}
      </div>
    {/if}
  </div>
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
