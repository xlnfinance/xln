<script lang="ts">
  import type { CrossSwapSetupStep } from './swap-panel-helpers';
  import { formatEntityNetworkLabel } from './swap-panel-helpers';

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

<div class="section section-order ticket-v2">
  <div class="v2-top">
    <div class="v2-sel v2-sel-hub" title="Hub counterparty">
      <span class="v2-net-dot">{(selectedHubOption?.label || '?').slice(0, 2)}</span>
      <span class="v2-sel-text">{selectedHubOption ? formatEntityNetworkLabel(selectedHubOption.label, hubJurisdictionLabel(selectedHubOption.value)) : 'Select hub'}</span>
      <span class="v2-chevron" aria-hidden="true"></span>
      <select
        class="v2-native"
        bind:value={createOrderAccountId}
        data-testid="swap2-hub-select"
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
      class="v2-book-toggle"
      class:active={showOrderbook}
      aria-pressed={showOrderbook}
      data-testid="swap2-orderbook-toggle"
      on:click={() => showOrderbook = !showOrderbook}
    >
      {showOrderbook ? 'Hide book' : 'Book'}
    </button>
  </div>

  <div class="v2-leg">
    <div class="v2-leg-head">
      <span class="v2-label">You pay</span>
    </div>
    <div class="v2-box">
      <div class="v2-selects">
        <div class="v2-sel">
          <span class="v2-net-dot">{(selectedSourceOption?.jurisdiction || '?').slice(0, 2)}</span>
          <span class="v2-sel-text">{selectedSourceOption?.label || 'Network'}</span>
          <span class="v2-chevron" aria-hidden="true"></span>
          <select
            class="v2-native"
            value={selectedSourceEntityValue}
            data-testid="swap2-from-network"
            aria-label="From network"
            on:change={handleSourceEntityChange}
          >
            {#each sourceEntityOptions as option (option.value)}
              <option value={option.value}>{option.label}</option>
            {/each}
          </select>
        </div>
        <div class="v2-sel">
          <span class={`token-dot token-${tokenClass(giveTokenSymbol)}`}>{tokenIconText(giveTokenSymbol)}</span>
          <span class="v2-sel-text v2-sel-token">{giveTokenSymbol}</span>
          <span class="v2-chevron" aria-hidden="true"></span>
          <select
            class="v2-native"
            bind:value={giveTokenId}
            data-testid="swap2-from-token"
            aria-label="From token"
            on:change={handleGiveTokenChange}
          >
            {#each giveTokenOptions as token (token.tokenId)}
              <option value={String(token.tokenId)}>{token.symbol}</option>
            {/each}
          </select>
        </div>
      </div>
      <div class="v2-amount-row">
        <input
          class="v2-amount"
          type="text"
          value={orderAmountInput}
          inputmode="decimal"
          placeholder="0"
          data-testid="swap2-amount"
          aria-label="Amount to pay"
          on:input={(event) => handleOrderAmountInput((event.currentTarget as HTMLInputElement).value)}
        />
        <span class="v2-balance">
          <span>Available</span>
          <strong>{formattedAvailableGiveAmount}</strong>
        </span>
      </div>
    </div>
  </div>

  <div class="v2-flip">
    <button
      type="button"
      data-testid="swap2-flip"
      title="Flip tokens"
      aria-label="Flip tokens"
      on:click={flipSwapTokens}
    >&#8645;</button>
  </div>

  <div class="v2-leg">
    <div class="v2-leg-head">
      <span class="v2-label">You receive</span>
    </div>
    <div class="v2-box">
      <div class="v2-selects">
        <div class="v2-sel">
          <span class="v2-net-dot">{(selectedRouteOption?.targetJurisdiction || selectedRouteOption?.label || '=').slice(0, 2)}</span>
          <span class="v2-sel-text">{selectedRouteOption?.label || 'Same account'}</span>
          <span class="v2-chevron" aria-hidden="true"></span>
          <select
            class="v2-native"
            bind:this={routeSelectElement}
            bind:value={selectedRouteValue}
            data-testid="swap2-to-network"
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
        <div class="v2-sel">
          <span class={`token-dot token-${tokenClass(wantTokenSymbol)}`}>{tokenIconText(wantTokenSymbol)}</span>
          <span class="v2-sel-text v2-sel-token">{wantTokenSymbol}</span>
          <span class="v2-chevron" aria-hidden="true"></span>
          <select
            class="v2-native"
            bind:value={wantTokenId}
            data-testid="swap2-to-token"
            aria-label="To token"
            on:change={handleWantTokenChange}
          >
            {#each wantTokenOptions as token (token.tokenId)}
              <option value={String(token.tokenId)}>{token.symbol}</option>
            {/each}
          </select>
        </div>
      </div>
      <div class="v2-amount-row" data-testid="swap2-receive-amount">
        <span class="v2-amount v2-receive-value" class:muted={wantAmount === 0n}>{receiveDisplay}</span>
        <span class="v2-balance">
          <span>Capacity</span>
          <strong>{targetCapacityLabel}</strong>
        </span>
      </div>
    </div>
  </div>

  <div class="v2-rate">
    <div class="v2-rate-box">
      <span class="v2-rate-label">Rate</span>
      <input
        class="v2-rate-input"
        type="text"
        bind:value={priceRatioInput}
        inputmode="decimal"
        data-testid="swap2-rate"
        aria-label="Limit rate"
        on:input={handlePriceRatioInput}
      />
      <span class="v2-rate-unit">{quoteTokenSymbol}</span>
    </div>
    <button type="button" class="v2-step" aria-label="Rate down" on:click={() => stepPrice(-1)}>&#8722;</button>
    <button type="button" class="v2-step" aria-label="Rate up" on:click={() => stepPrice(1)}>+</button>
    <button
      type="button"
      class="v2-market"
      data-testid="swap2-use-market"
      disabled={!marketPriceTicks || marketPriceTicks <= 0n}
      title={marketPriceLabel}
      on:click={useMarketPrice}
    >Market</button>
  </div>

  {#if capacityWarning}
    <p class="v2-warn" data-testid="swap2-capacity-warn">{capacityWarning}</p>
  {/if}

  {#if autoCapacityNote}
    <p class="v2-note" data-testid="swap2-auto-capacity-note">{autoCapacityNote}</p>
  {/if}

  {#if crossSwapSetupSteps.length > 0}
    <div class="v2-setup">
      {#each crossSwapSetupSteps as step (step.id)}
        <p class="v2-note">{step.label}</p>
      {/each}
    </div>
  {/if}

  <button
    class="v2-submit"
    data-testid="swap2-submit"
    on:click={placeSwapOffer}
    disabled={placingSwapOffer || Boolean(swapActionDisabledReason)}
  >
    {placingSwapOffer ? swapSubmitLabel : (swapActionDisabledReason || swapSubmitLabel)}
  </button>
  {#if submitError}
    <p class="v2-error" data-testid="swap2-error">{submitError}</p>
  {/if}
</div>

<style>
  .ticket-v2 {
    display: grid;
    gap: 12px;
    padding: 20px;
    border-radius: 18px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  }

  .v2-label {
    color: #8a919c;
    font-size: 13px;
    font-weight: 500;
    font-family: inherit;
  }

  .v2-top {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .v2-sel {
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

  .v2-sel:hover {
    border-color: #333a48;
  }

  .v2-sel-hub {
    flex: 1;
    height: 44px;
  }

  .v2-sel-text {
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

  .v2-sel-token {
    flex: 0 1 auto;
    font-weight: 600;
  }

  .v2-chevron {
    flex-shrink: 0;
    width: 8px;
    height: 8px;
    border-right: 1.5px solid #8a919c;
    border-bottom: 1.5px solid #8a919c;
    transform: rotate(45deg) translateY(-2px);
  }

  .v2-native {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    opacity: 0;
    cursor: pointer;
    appearance: none;
  }

  .v2-net-dot {
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

  .v2-book-toggle {
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

  .v2-book-toggle:hover {
    border-color: #333a48;
    color: #e8eaed;
  }

  .v2-leg {
    display: grid;
    gap: 8px;
  }

  .v2-leg-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    padding: 0 2px;
  }

  .v2-box {
    display: grid;
    gap: 1px;
    background: #262b35;
    border: 1px solid #262b35;
    border-radius: 14px;
    overflow: hidden;
  }

  .v2-box:focus-within {
    border-color: #3a4152;
  }

  .v2-selects {
    display: grid;
    grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr);
    gap: 1px;
  }

  .v2-selects .v2-sel {
    height: 56px;
    border: none;
    border-radius: 0;
    background: #1a1e26;
  }

  .v2-amount-row {
    display: flex;
    align-items: center;
    gap: 14px;
    height: 72px;
    padding: 0 18px;
    background: #14171d;
  }

  .ticket-v2 .v2-amount,
  .ticket-v2 input.v2-amount,
  .ticket-v2 input.v2-amount:focus {
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

  .v2-amount::placeholder {
    color: #4b5261;
  }

  .v2-receive-value.muted {
    color: #4b5261;
  }

  .v2-balance {
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 2px;
    max-width: 40%;
  }

  .v2-balance span {
    color: #6b7280;
    font-size: 12px;
  }

  .v2-balance strong {
    color: #aeb4bd;
    font-size: 13px;
    font-weight: 500;
    font-family: var(--font-mono, ui-monospace, monospace);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 100%;
  }

  .v2-flip {
    display: flex;
    justify-content: center;
    margin: -22px 0;
    position: relative;
    z-index: 1;
  }

  .v2-flip button {
    width: 38px;
    height: 38px;
    border: 4px solid #0a0c11;
    border-radius: 12px;
    background: #262b35;
    color: #e8eaed;
    font-size: 16px;
    cursor: pointer;
  }

  .v2-flip button:hover {
    background: #333a48;
  }

  .v2-rate {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 2px;
  }

  .v2-rate-box {
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

  .v2-rate-label {
    flex-shrink: 0;
    color: #8a919c;
    font-size: 13px;
    font-weight: 500;
  }

  .v2-rate-box:focus-within {
    border-color: #3a4152;
  }

  .ticket-v2 .v2-rate-box input,
  .ticket-v2 .v2-rate-box input:focus {
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

  .v2-rate-unit {
    flex-shrink: 0;
    color: #6b7280;
    font-size: 12px;
  }

  .v2-step,
  .v2-market {
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

  .v2-step {
    width: 44px;
    padding: 0;
  }

  .v2-step:hover,
  .v2-market:hover {
    border-color: #333a48;
    color: #e8eaed;
  }

  .v2-market {
    font-size: 13px;
    font-weight: 500;
  }

  .v2-market:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .v2-warn {
    margin: 0;
    padding: 11px 14px;
    border: 1px solid rgba(239, 184, 74, 0.25);
    border-radius: 12px;
    background: rgba(239, 184, 74, 0.08);
    color: #e8d9ab;
    font-size: 13px;
    line-height: 1.5;
  }

  .v2-note {
    margin: 0;
    padding: 0 2px;
    color: #8a919c;
    font-size: 12px;
    line-height: 1.5;
  }

  .v2-setup {
    display: grid;
    gap: 4px;
  }

  .v2-submit {
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

  .v2-submit:hover:not(:disabled) {
    background: #ffffff;
  }

  .v2-submit:disabled {
    background: #1e222a;
    color: #6b7280;
    cursor: default;
  }

  .v2-error {
    margin: 0;
    color: #e07a79;
    font-size: 13px;
    line-height: 1.5;
  }
</style>
