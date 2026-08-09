<script lang="ts">
  import type { RoutedSwapRouteCandidate } from './routed-swap-planner';
  import type { CrossSwapSetupStep } from './swap-panel-helpers';
  import { formatEntityNetworkLabel } from './swap-panel-helpers';
  import SwapRouteBuilder from './SwapRouteBuilder.svelte';

  type SourceEntityOption = {
    value: string;
    label: string;
    name: string;
    entityId: string;
    jurisdiction: string;
  };

  type TokenOption = {
    tokenId: number;
    symbol: string;
    label: string;
  };

  type RouteOption = {
    value: string;
    label: string;
    targetEntityId: string;
    targetJurisdiction: string;
    disabled?: boolean;
    disabledReason?: string;
  };

  type HubOption = {
    value: string;
    label: string;
  };

  const noop = () => {};

  export let showOrderbook = true;

  export let createOrderAccountId = '';
  export let selectedHubOptions: HubOption[] = [];
  export let handleSelectedHubChange: (nextValue: string) => void = noop;
  export let hubJurisdictionLabel: (entityIdValue: string) => string = () => '';

  export let selectedSourceEntityValue = '';
  export let sourceEntityOptions: SourceEntityOption[] = [];
  export let handleSourceEntityChange: (event: Event) => void = noop;

  export let orderAmountInput = '';
  export let handleOrderAmountInput: (value: string) => void = noop;
  export let giveTokenId = '1';
  export let giveToken = 1;
  export let giveTokenOptions: TokenOption[] = [];
  export let handleGiveTokenChange: (event: Event) => void = noop;
  export let giveTokenSymbol = '';
  export let formattedAvailableGiveAmount = '0';
  export let flipSwapTokens: () => void = noop;

  export let routeSelectElement: HTMLSelectElement | null = null;
  export let selectedRouteValue = 'same';
  export let visibleRouteOptions: RouteOption[] = [];
  export let handleRouteSelectChange: (event: Event) => void = noop;

  export let wantTokenId = '2';
  export let wantTokenOptions: TokenOption[] = [];
  export let handleWantTokenChange: (event: Event) => void = noop;
  export let wantTokenSymbol = '';
  export let wantAmount: bigint = 0n;
  export let wantToken = 2;
  export let formatAmount: (amount: bigint, tokenId: number) => string = () => '';
  export let targetCapacityLabel = '0';

  export let tokenClass: (symbol: string) => string = () => '';
  export let tokenIconText: (symbol: string) => string = () => '';

  export let priceRatioInput = '';
  export let quoteTokenSymbol = '';
  export let handlePriceRatioInput: (event: Event) => void = noop;
  export let stepPrice: (direction: 1 | -1) => void = noop;
  export let useMarketPrice: () => void = noop;
  export let marketPriceTicks: bigint | null = null;
  export let marketPriceLabel = '';

  export let giveTokenDecimals = 18;
  export let giveAmount = 0n;
  export let canonicalGiveAmount = 0n;
  export let routeSummaryLabel = '';
  export let routePathLabel = '';
  export let routeVenueDisplayLabel = '';
  export let routeSummaryAssetsLabel = '';
  export let routeDetailsOpen = false;
  export let swapRouteMode: 'same' | 'cross' = 'same';
  export let liveSelectedRouteValue = 'same';
  export let routePathSourceLabel = '';
  export let routePathTargetLabel = '';
  export let selectedRouteLabel = '';
  export let sourceRouteEntityLabel = '';
  export let targetRouteEntityLabel = '';
  export let showManualRouteRecommendation = false;
  export let routedRouteRecommendations: RoutedSwapRouteCandidate[] = [];
  export let manualRouteEstimateLabel: (route: RoutedSwapRouteCandidate) => string = () => '';

  export let capacityWarning = '';
  export let autoCapacityNote = '';
  export let crossSwapSetupSteps: CrossSwapSetupStep[] = [];

  export let placingSwapOffer = false;
  export let swapActionDisabledReason = '';
  export let placeSwapOffer: () => void | Promise<void> = noop;
  export let swapSubmitLabel = '';
  export let submitError = '';

  function trimDecimals(value: string, places: number): string {
    const dot = value.indexOf('.');
    if (dot < 0) return value;
    const trimmed = value.slice(0, dot + places + 1).replace(/\.?0+$/, '');
    return trimmed || '0';
  }

  $: selectedSourceOption = sourceEntityOptions.find((option) => option.value === selectedSourceEntityValue) || null;
  $: selectedRouteOption = visibleRouteOptions.find((option) => option.value === selectedRouteValue) || null;
  $: selectedHubOption = selectedHubOptions.find((hub) => hub.value === createOrderAccountId) || null;
  $: receiveDisplay = trimDecimals(formatAmount(wantAmount, wantToken), 6);
</script>

<div class="section section-order swap-ticket" data-testid="swap-ticket">
  <div class="swap-ticket-top">
    <div class="swap-ticket-sel swap-ticket-sel-hub" title="Hub counterparty">
      <span class="swap-ticket-net-dot">{(selectedHubOption?.label || '?').slice(0, 2)}</span>
      <span class="swap-ticket-sel-text">{selectedHubOption ? formatEntityNetworkLabel(selectedHubOption.label, hubJurisdictionLabel(selectedHubOption.value)) : 'Select hub'}</span>
      <span class="swap-ticket-chevron" aria-hidden="true"></span>
      <select
        class="swap-ticket-native"
        bind:value={createOrderAccountId}
        data-testid="swap-ticket-hub-select"
        aria-label="Hub counterparty"
        on:change={(event) => handleSelectedHubChange((event.currentTarget as HTMLSelectElement).value)}
      >
        {#each selectedHubOptions as hub (hub.value)}
          <option value={hub.value}>{formatEntityNetworkLabel(hub.label, hubJurisdictionLabel(hub.value))}</option>
        {/each}
      </select>
    </div>
    <button
      type="button"
      class="swap-ticket-book-toggle"
      class:active={showOrderbook}
      aria-pressed={showOrderbook}
      data-testid="swap-ticket-orderbook-toggle"
      on:click={() => showOrderbook = !showOrderbook}
    >
      {showOrderbook ? 'Hide book' : 'Book'}
    </button>
  </div>

  <div class="swap-ticket-leg">
    <div class="swap-ticket-leg-head">
      <span class="swap-ticket-label">You pay</span>
    </div>
    <div class="swap-ticket-box">
      <div class="swap-ticket-selects">
        <div class="swap-ticket-sel">
          <span class="swap-ticket-net-dot">{(selectedSourceOption?.jurisdiction || '?').slice(0, 2)}</span>
          <span class="swap-ticket-sel-text">{selectedSourceOption?.label || 'Network'}</span>
          <span class="swap-ticket-chevron" aria-hidden="true"></span>
          <select
            class="swap-ticket-native"
            value={selectedSourceEntityValue}
            data-testid="swap-ticket-from-network"
            aria-label="From network"
            on:change={handleSourceEntityChange}
          >
            {#each sourceEntityOptions as option (option.value)}
              <option value={option.value}>{option.label}</option>
            {/each}
          </select>
        </div>
        <div class="swap-ticket-sel">
          <span class={`token-dot token-${tokenClass(giveTokenSymbol)}`}>{tokenIconText(giveTokenSymbol)}</span>
          <span class="swap-ticket-sel-text swap-ticket-sel-token">{giveTokenSymbol}</span>
          <span class="swap-ticket-chevron" aria-hidden="true"></span>
          <select
            class="swap-ticket-native"
            bind:value={giveTokenId}
            data-testid="swap-ticket-from-token"
            aria-label="From token"
            on:change={handleGiveTokenChange}
          >
            {#each giveTokenOptions as token (token.tokenId)}
              <option value={String(token.tokenId)}>{token.symbol}</option>
            {/each}
          </select>
        </div>
      </div>
      <div class="swap-ticket-amount-row">
        <input
          class="swap-ticket-amount"
          type="text"
          value={orderAmountInput}
          inputmode="decimal"
          placeholder="0"
          data-testid="swap-ticket-amount"
          aria-label="Amount to pay"
          on:input={(event) => handleOrderAmountInput((event.currentTarget as HTMLInputElement).value)}
        />
        <span class="swap-ticket-balance">
          <span>Available</span>
          <strong data-testid="swap-ticket-available">{formattedAvailableGiveAmount}</strong>
        </span>
      </div>
    </div>
  </div>

  <div class="swap-ticket-flip">
    <button
      type="button"
      data-testid="swap-ticket-flip"
      title="Flip tokens"
      aria-label="Flip tokens"
      on:click={flipSwapTokens}
    >&#8645;</button>
  </div>

  <div class="swap-ticket-leg">
    <div class="swap-ticket-leg-head">
      <span class="swap-ticket-label">You receive</span>
    </div>
    <div class="swap-ticket-box">
      <div class="swap-ticket-selects">
        <div class="swap-ticket-sel">
          <span class="swap-ticket-net-dot">{(selectedRouteOption?.targetJurisdiction || selectedRouteOption?.label || '=').slice(0, 2)}</span>
          <span class="swap-ticket-sel-text">{selectedRouteOption?.label || 'Same account'}</span>
          <span class="swap-ticket-chevron" aria-hidden="true"></span>
          <select
            class="swap-ticket-native"
            bind:this={routeSelectElement}
            bind:value={selectedRouteValue}
            data-testid="swap-ticket-to-network"
            aria-label="To network"
            on:input={handleRouteSelectChange}
            on:change={handleRouteSelectChange}
          >
            {#each visibleRouteOptions as option (option.value)}
              <option value={option.value} disabled={option.disabled} title={option.disabledReason || option.label}>
                {option.label}
              </option>
            {/each}
          </select>
        </div>
        <div class="swap-ticket-sel">
          <span class={`token-dot token-${tokenClass(wantTokenSymbol)}`}>{tokenIconText(wantTokenSymbol)}</span>
          <span class="swap-ticket-sel-text swap-ticket-sel-token">{wantTokenSymbol}</span>
          <span class="swap-ticket-chevron" aria-hidden="true"></span>
          <select
            class="swap-ticket-native"
            bind:value={wantTokenId}
            data-testid="swap-ticket-to-token"
            aria-label="To token"
            on:change={handleWantTokenChange}
          >
            {#each wantTokenOptions as token (token.tokenId)}
              <option value={String(token.tokenId)}>{token.symbol}</option>
            {/each}
          </select>
        </div>
      </div>
      <div class="swap-ticket-amount-row" data-testid="swap-ticket-receive-amount">
        <span class="swap-ticket-amount swap-ticket-receive-value" class:muted={wantAmount === 0n}>{receiveDisplay}</span>
        <span class="swap-ticket-balance">
          <span>Capacity</span>
          <strong>{targetCapacityLabel}</strong>
        </span>
      </div>
    </div>
  </div>

  <div class="swap-ticket-rate">
    <div class="swap-ticket-rate-box">
      <span class="swap-ticket-rate-label">Rate</span>
      <input
        class="swap-ticket-rate-input"
        type="text"
        bind:value={priceRatioInput}
        inputmode="decimal"
        data-testid="swap-ticket-rate"
        aria-label="Limit rate"
        on:input={handlePriceRatioInput}
      />
      <span class="swap-ticket-rate-unit">{quoteTokenSymbol}</span>
    </div>
    <button type="button" class="swap-ticket-step" aria-label="Rate down" on:click={() => stepPrice(-1)}>&#8722;</button>
    <button type="button" class="swap-ticket-step" aria-label="Rate up" on:click={() => stepPrice(1)}>+</button>
    <button
      type="button"
      class="swap-ticket-market"
      data-testid="swap-ticket-use-market"
      disabled={!marketPriceTicks || marketPriceTicks <= 0n}
      title={marketPriceLabel}
      on:click={useMarketPrice}
    >Market</button>
  </div>

  <SwapRouteBuilder
    {orderAmountInput}
    {giveToken}
    {wantToken}
    {giveTokenDecimals}
    {giveAmount}
    {canonicalGiveAmount}
    {routeSummaryLabel}
    {routePathLabel}
    {routeVenueDisplayLabel}
    {routeSummaryAssetsLabel}
    bind:routeDetailsOpen
    {swapRouteMode}
    {liveSelectedRouteValue}
    {routePathSourceLabel}
    {routePathTargetLabel}
    {selectedRouteLabel}
    {sourceRouteEntityLabel}
    {targetRouteEntityLabel}
    {showManualRouteRecommendation}
    {routedRouteRecommendations}
    {manualRouteEstimateLabel}
  />

  {#if swapRouteMode === 'cross'}
    <section class="cross-j-safety-banner" data-testid="cross-j-safety-banner" aria-live="polite">
      <strong>Stay online for this cross-network swap</strong>
      <span>
        Cross-jurisdiction Pulls require this device to relay secrets. Fills and closure are not automatic:
        cancel the remaining order manually when you are done. Dispute progress is quantized into 65,535 steps.
      </span>
    </section>
  {/if}

  {#if capacityWarning}
    <p class="swap-ticket-warn" data-testid="swap-ticket-capacity-warn">{capacityWarning}</p>
  {/if}

  {#if autoCapacityNote}
    <p class="swap-ticket-note" data-testid="swap-ticket-auto-capacity-note">{autoCapacityNote}</p>
  {/if}

  {#if crossSwapSetupSteps.length > 0}
    <div class="swap-setup-consent" data-testid="swap-setup-consent">
      {#each crossSwapSetupSteps as step (step.id)}
        <label class="swap-setup-step" data-testid="swap-setup-step" data-step-id={step.id}>
          <input type="checkbox" checked disabled aria-label={step.label} />
          <span>
            <strong>{step.label}</strong>
            <small>{step.detail}</small>
          </span>
        </label>
      {/each}
    </div>
  {/if}

  <button
    class="swap-ticket-submit"
    data-testid="swap-ticket-submit"
    on:click={placeSwapOffer}
    disabled={placingSwapOffer || Boolean(swapActionDisabledReason)}
  >
    {placingSwapOffer ? swapSubmitLabel : (swapActionDisabledReason || swapSubmitLabel)}
  </button>
  {#if swapActionDisabledReason || submitError}
    <p class="swap-ticket-error" data-testid="swap-ticket-error">{submitError || swapActionDisabledReason}</p>
  {/if}
</div>

<style>
  .swap-ticket {
    display: grid;
    gap: 12px;
    padding: 20px;
    border-radius: 18px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  }

  .cross-j-safety-banner {
    display: grid;
    gap: 6px;
    padding: 14px 16px;
    border: 1px solid color-mix(in srgb, #ffb020 72%, transparent);
    border-left-width: 5px;
    border-radius: 12px;
    background: color-mix(in srgb, #ffb020 14%, var(--surface, #111827));
    color: var(--text-primary, #f8fafc);
    box-shadow: 0 8px 24px color-mix(in srgb, #000 20%, transparent);
  }

  .cross-j-safety-banner strong {
    color: #ffd27a;
    font-size: 14px;
    letter-spacing: 0.01em;
  }

  .cross-j-safety-banner span {
    color: var(--text-secondary, #cbd5e1);
    font-size: 12px;
    line-height: 1.5;
  }

  .swap-ticket-label {
    color: #8a919c;
    font-size: 13px;
    font-weight: 500;
    font-family: inherit;
  }

  .swap-ticket-top {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .swap-ticket-sel {
    position: relative;
    display: flex;
    align-items: center;
    gap: 9px;
    height: 48px;
    padding: 0 14px;
    background: #1a1e26;
    border: 1px solid #262b35;
    border-radius: 12px;
    min-width: 0;
    cursor: pointer;
  }

  .swap-ticket-sel:hover {
    border-color: #333a48;
  }

  .swap-ticket-sel-hub {
    flex: 1;
    height: 44px;
  }

  .swap-ticket-sel-text {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: #e8eaed;
    font-size: 14px;
    font-weight: 500;
    font-family: inherit;
    text-align: left;
  }

  .swap-ticket-sel-token {
    flex: 0 1 auto;
    font-weight: 600;
  }

  .swap-ticket-chevron {
    flex-shrink: 0;
    width: 8px;
    height: 8px;
    border-right: 1.5px solid #8a919c;
    border-bottom: 1.5px solid #8a919c;
    transform: rotate(45deg) translateY(-2px);
  }

  .swap-ticket-native {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    opacity: 0;
    cursor: pointer;
    appearance: none;
  }

  .swap-ticket-net-dot {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    border-radius: 50%;
    background: #262b35;
    color: #aeb4bd;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
  }

  .swap-ticket-book-toggle {
    flex-shrink: 0;
    height: 44px;
    padding: 0 14px;
    border: 1px solid #262b35;
    border-radius: 12px;
    background: transparent;
    color: #8a919c;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
  }

  .swap-ticket-book-toggle:hover {
    border-color: #333a48;
    color: #e8eaed;
  }

  .swap-ticket-leg {
    display: grid;
    gap: 8px;
  }

  .swap-ticket-leg-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    padding: 0 2px;
  }

  .swap-ticket-box {
    display: grid;
    gap: 1px;
    background: #262b35;
    border: 1px solid #262b35;
    border-radius: 14px;
    overflow: hidden;
  }

  .swap-ticket-box:focus-within {
    border-color: #3a4152;
  }

  .swap-ticket-selects {
    display: grid;
    grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr);
    gap: 1px;
  }

  .swap-ticket-selects .swap-ticket-sel {
    height: 56px;
    border: none;
    border-radius: 0;
    background: #1a1e26;
  }

  .swap-ticket-amount-row {
    display: flex;
    align-items: center;
    gap: 14px;
    height: 72px;
    padding: 0 18px;
    background: #14171d;
  }

  .swap-ticket .swap-ticket-amount,
  .swap-ticket input.swap-ticket-amount,
  .swap-ticket input.swap-ticket-amount:focus {
    flex: 1;
    min-width: 0;
    padding: 0 !important;
    border: none !important;
    border-radius: 0 !important;
    outline: none !important;
    box-shadow: none !important;
    background: transparent !important;
    color: #e8eaed;
    font-family: var(--font-mono, ui-monospace, monospace) !important;
    font-size: 28px !important;
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .swap-ticket-amount::placeholder {
    color: #4b5261;
  }

  .swap-ticket-receive-value.muted {
    color: #4b5261;
  }

  .swap-ticket-balance {
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 2px;
    max-width: 40%;
  }

  .swap-ticket-balance span {
    color: #6b7280;
    font-size: 12px;
  }

  .swap-ticket-balance strong {
    color: #aeb4bd;
    font-size: 13px;
    font-weight: 500;
    font-family: var(--font-mono, ui-monospace, monospace);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 100%;
  }

  .swap-ticket-flip {
    display: flex;
    justify-content: center;
    margin: -22px 0;
    position: relative;
    z-index: 1;
  }

  .swap-ticket-flip button {
    width: 38px;
    height: 38px;
    border: 4px solid #0a0c11;
    border-radius: 12px;
    background: #262b35;
    color: #e8eaed;
    font-size: 16px;
    cursor: pointer;
  }

  .swap-ticket-flip button:hover {
    background: #333a48;
  }

  .swap-ticket-rate {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 2px;
  }

  .swap-ticket-rate-box {
    display: flex;
    flex: 1;
    align-items: center;
    gap: 10px;
    min-width: 0;
    height: 44px;
    padding: 0 14px;
    border: 1px solid #262b35;
    border-radius: 12px;
    background: #14171d;
  }

  .swap-ticket-rate-label {
    flex-shrink: 0;
    color: #8a919c;
    font-size: 13px;
    font-weight: 500;
  }

  .swap-ticket-rate-box:focus-within {
    border-color: #3a4152;
  }

  .swap-ticket .swap-ticket-rate-box input,
  .swap-ticket .swap-ticket-rate-box input:focus {
    flex: 1;
    min-width: 0;
    padding: 0 !important;
    border: none !important;
    border-radius: 0 !important;
    outline: none !important;
    box-shadow: none !important;
    background: transparent !important;
    color: #e8eaed;
    font-family: var(--font-mono, ui-monospace, monospace) !important;
    font-size: 14px !important;
    text-align: right;
  }

  .swap-ticket-rate-unit {
    flex-shrink: 0;
    color: #6b7280;
    font-size: 12px;
  }

  .swap-ticket-step,
  .swap-ticket-market {
    flex-shrink: 0;
    height: 44px;
    padding: 0 14px;
    border: 1px solid #262b35;
    border-radius: 12px;
    background: transparent;
    color: #a7afbd;
    font-size: 15px;
    cursor: pointer;
  }

  .swap-ticket-step {
    width: 44px;
    padding: 0;
  }

  .swap-ticket-step:hover,
  .swap-ticket-market:hover {
    border-color: #333a48;
    color: #e8eaed;
  }

  .swap-ticket-market {
    font-size: 13px;
    font-weight: 500;
  }

  .swap-ticket-market:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .swap-ticket-warn {
    margin: 0;
    padding: 11px 14px;
    border: 1px solid rgba(239, 184, 74, 0.25);
    border-radius: 12px;
    background: rgba(239, 184, 74, 0.08);
    color: #e8d9ab;
    font-size: 13px;
    line-height: 1.5;
  }

  .swap-ticket-note {
    margin: 0;
    padding: 0 2px;
    color: #8a919c;
    font-size: 12px;
    line-height: 1.5;
  }

  .swap-ticket-setup {
    display: grid;
    gap: 4px;
  }

  .swap-ticket-submit {
    height: 50px;
    margin-top: 2px;
    border: none;
    border-radius: 13px;
    background: #e8eaed;
    color: #0f1114;
    font-size: 15px;
    font-weight: 600;
    cursor: pointer;
  }

  .swap-ticket-submit:hover:not(:disabled) {
    background: #ffffff;
  }

  .swap-ticket-submit:disabled {
    background: #1e222a;
    color: #6b7280;
    cursor: default;
  }

  .swap-ticket-error {
    margin: 0;
    color: #e07a79;
    font-size: 13px;
    line-height: 1.5;
  }
</style>
