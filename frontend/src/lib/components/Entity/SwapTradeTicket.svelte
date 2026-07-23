<script lang="ts">
  import type { Action } from 'svelte/action';
  import { readable, type Readable } from 'svelte/store';
  import type { RoutedSwapRouteCandidate } from './routed-swap-planner';
  import {
    entityInitials,
    formatEntityNetworkLabel,
    jurisdictionBadgeText,
    type CrossSwapSetupStep,
  } from './swap-panel-helpers';
  import SwapPriceVenueControls from './SwapPriceVenueControls.svelte';
  import SwapVenueSelector from './SwapVenueSelector.svelte';
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

  type SelectedOrderLevel = {
    inputPriceTicks: bigint;
    priceTicks: bigint;
    accountId: string;
  };

  const noopButtonAction: Action<HTMLButtonElement> = () => ({});
  const noop = () => {};

  export let swapRouteMode: 'same' | 'cross' = 'same';
  export let sourceAssetLabel = '';
  export let targetAssetLabel = '';
  export let swapRouteTitle = '';
  export let showOrderbook = true;

  export let selectedSourceEntity: SourceEntityOption | null = null;
  export let selectedSourceEntityValue = '';
  export let selectedSourceEntityLabel = '';
  export let sourceEntityIdValue = '';
  export let sourceJurisdictionLabel = '';
  export let sourceMenuOpen = false;
  export let sourceEntityOptions: SourceEntityOption[] = [];
  export let toggleSourceMenu: () => void = noop;
  export let handleSourceEntityChange: (event: Event) => void = noop;
  export let selectSourceEntityOption: (value: string) => void = noop;
  export let accountLabel: (entityIdValue: string) => string = () => '';
  export let entityAvatarSrc: (entityIdValue: string) => string = () => '';

  export let orderAmountInput = '';
  export let handleOrderAmountInput: (value: string) => void = noop;

  export let openTokenMenu: 'give' | 'want' | '' = '';
  export let toggleTokenMenu: (side: 'give' | 'want') => void = noop;
  export let tokenClass: (symbol: string) => string = () => '';
  export let tokenIconText: (symbol: string) => string = () => '';
  export let giveTokenId = '1';
  export let giveToken = 1;
  export let giveTokenSymbol = '';
  export let giveTokenOptions: TokenOption[] = [];
  export let handleGiveTokenChange: (event: Event) => void = noop;
  export let selectGiveTokenOption: (tokenId: number) => void = noop;
  export let formattedAvailableGive = '0';
  export let formattedAvailableGiveAmount = '0';
  export let flipSwapTokens: () => void = noop;

  export let routeMenuButtonAction: Action<HTMLButtonElement> = noopButtonAction;
  export let routeMenuOpenStore: Readable<boolean> = readable(false);
  export let routeMenuToggleCount = 0;
  export let routeMenuNativeClickCount = 0;
  export let routeMenuSetCount = 0;
  export let routeMenuLastSetReason = 'init';
  export let selectedRouteLabel = '';
  export let selectedRouteEntityId = '';
  export let selectedRouteEntityName = '';
  export let selectedRouteJurisdictionLabel = '';
  export let routeSelectElement: HTMLSelectElement | null = null;
  export let selectedRouteValue = 'same';
  export let liveSelectedRouteValue = 'same';
  export let committedRouteSelectionValue = 'same';
  export let routeSelectionCommitNonce = 0;
  export let visibleRouteOptions: RouteOption[] = [];
  export let handleRouteSelectChange: (event: Event) => void = noop;
  export let selectRouteOption: (value: string) => void = noop;

  export let wantAmount: bigint = 0n;
  export let wantToken = 2;
  export let wantTokenId = '2';
  export let wantTokenSymbol = '';
  export let wantTokenOptions: TokenOption[] = [];
  export let handleWantTokenChange: (event: Event) => void = noop;
  export let selectWantTokenOption: (tokenId: number) => void = noop;
  export let targetAccountReady = false;
  export let formattedTargetCapacityAmount = '0';
  export let targetCapacityLabel = '0';

  export let priceRatioInput = '';
  export let createOrderAccountId = '';
  export let quoteTokenSymbol = '';
  export let marketPriceTicks: bigint | null = null;
  export let marketPriceSideLabel = '';
  export let marketPriceLabel = '';
  export let bookVenueLabel = '';
  export let hubMenuOpen = false;
  export let activeOrderAccountId = '';
  export let selectedHubDisplayLabel = '';
  export let selectedHubLabel = '';
  export let selectedHubJurisdictionLabel = '';
  export let selectedHubOptions: HubOption[] = [];
  export let orderPercent = 100;
  export let handlePriceRatioInput: (event: Event) => void = noop;
  export let stepPrice: (direction: 1 | -1) => void = noop;
  export let useMarketPrice: () => void = noop;
  export let toggleHubMenu: () => void = noop;
  export let handleSelectedHubChange: (nextValue: string) => void = noop;
  export let selectHubOption: (nextValue: string) => void = noop;
  export let hubJurisdictionLabel: (entityIdValue: string) => string = () => '';
  export let applyOrderPercent: (percent: number) => void = noop;

  export let giveTokenDecimals = 18;
  export let giveAmount: bigint = 0n;
  export let canonicalGiveAmount: bigint = 0n;
  export let routeSummaryLabel = '';
  export let routePathLabel = '';
  export let routeVenueDisplayLabel = '';
  export let routeSummaryAssetsLabel = '';
  export let routeDetailsOpen = false;
  export let routePathSourceLabel = '';
  export let routePathTargetLabel = '';
  export let sourceRouteEntityLabel = '';
  export let targetRouteEntityLabel = '';
  export let showManualRouteRecommendation = false;
  export let routedRouteRecommendations: RoutedSwapRouteCandidate[] = [];
  export let manualRouteEstimateLabel: (route: RoutedSwapRouteCandidate) => string = () => '';

  export let capacityWarning = '';
  export let autoCapacityNote = '';
  export let crossSwapSetupSteps: CrossSwapSetupStep[] = [];
  export let selectedOrderLevel: SelectedOrderLevel | null = null;
  export let formatPriceTicks: (ticks: bigint) => string = () => '';
  export let formatAmount: (amount: bigint, tokenId: number) => string = () => '';

  export let orderMode: 'buy-base' | 'sell-base' | 'none' = 'none';
  export let placingSwapOffer = false;
  export let swapActionDisabledReason = '';
  export let placeSwapOffer: () => void | Promise<void> = noop;
  export let swapSubmitLabel = '';
  export let submitError = '';
</script>

<div class="section section-order">
  <div class="swap-mode-bar">
    <span>{swapRouteMode === 'cross' ? 'Cross chain' : 'Same chain'}</span>
    <strong title={`${sourceAssetLabel} -> ${targetAssetLabel}`}>{swapRouteTitle}</strong>
    <button
      type="button"
      class="book-toggle"
      class:active={showOrderbook}
      data-testid="swap-orderbook-toggle"
      aria-pressed={showOrderbook}
      on:click={() => showOrderbook = !showOrderbook}
    >
      {showOrderbook ? 'Hide book' : 'Open book'}
    </button>
  </div>
  <div class="anyswap-builder" data-testid="swap-any-builder">
    <SwapVenueSelector
      bind:createOrderAccountId
      {hubMenuOpen}
      {activeOrderAccountId}
      {selectedHubDisplayLabel}
      {selectedHubLabel}
      {selectedHubJurisdictionLabel}
      {selectedHubOptions}
      {toggleHubMenu}
      {handleSelectedHubChange}
      {selectHubOption}
      {entityAvatarSrc}
      {entityInitials}
      {jurisdictionBadgeText}
      {formatEntityNetworkLabel}
      {hubJurisdictionLabel}
    />
    <div class="swap-leg-card">
      <div class="leg-header">
        <span>From</span>
        <div class="entity-select-wrap" data-swap-menu-root>
          <button
            type="button"
            class="entity-select-button"
            aria-haspopup="listbox"
            aria-expanded={sourceMenuOpen}
            title={selectedSourceEntityLabel}
            on:click|stopPropagation={toggleSourceMenu}
          >
            <span class="entity-avatar-wrap">
              {#if selectedSourceEntity && entityAvatarSrc(selectedSourceEntity.entityId)}
                <img class="entity-avatar-mini" src={entityAvatarSrc(selectedSourceEntity.entityId)} alt="" />
              {:else}
                <span class="entity-avatar-mini placeholder">{entityInitials(sourceEntityIdValue, selectedSourceEntity?.name || selectedSourceEntityLabel)}</span>
              {/if}
              <span class="jurisdiction-mini-badge">{jurisdictionBadgeText(selectedSourceEntity?.jurisdiction || sourceJurisdictionLabel)}</span>
            </span>
            <span class="entity-select-copy">
              <strong>{formatEntityNetworkLabel(selectedSourceEntity?.name || accountLabel(sourceEntityIdValue), selectedSourceEntity?.jurisdiction || sourceJurisdictionLabel)}</strong>
            </span>
            <span class="entity-select-chevron" aria-hidden="true">⌄</span>
          </button>
          <select
            class="entity-select-native"
            value={selectedSourceEntityValue}
            data-testid="swap-from-chain-select"
            title={selectedSourceEntityLabel}
            aria-label="Swap from account and network"
            on:change={handleSourceEntityChange}
          >
            {#each sourceEntityOptions as option}
              <option value={option.value} title={option.label}>{option.label}</option>
            {/each}
          </select>
          {#if sourceMenuOpen}
            <div class="entity-menu" role="listbox" aria-label="Source account">
              {#each sourceEntityOptions as option}
                <button
                  type="button"
                  class:selected={option.value === selectedSourceEntityValue}
                  class="entity-option"
                  role="option"
                  aria-selected={option.value === selectedSourceEntityValue}
                  title={option.label}
                  on:click|stopPropagation={() => selectSourceEntityOption(option.value)}
                >
                  <span class="entity-avatar-wrap">
                    {#if entityAvatarSrc(option.entityId)}
                      <img class="entity-avatar-mini" src={entityAvatarSrc(option.entityId)} alt="" />
                    {:else}
                      <span class="entity-avatar-mini placeholder">{entityInitials(option.entityId, option.name)}</span>
                    {/if}
                    <span class="jurisdiction-mini-badge">{jurisdictionBadgeText(option.jurisdiction)}</span>
                  </span>
                  <span class="entity-select-copy">
                    <strong>{formatEntityNetworkLabel(option.name, option.jurisdiction)}</strong>
                  </span>
                </button>
              {/each}
            </div>
          {/if}
        </div>
      </div>
      <div class="leg-main">
        <input
          type="text"
          value={orderAmountInput}
          inputmode="decimal"
          placeholder="0"
          data-testid="swap-order-amount"
          aria-label="Swap from amount"
          on:input={(event) => handleOrderAmountInput((event.currentTarget as HTMLInputElement).value)}
        />
        <div class="token-select-wrap" data-swap-menu-root title={giveTokenSymbol}>
          <button
            type="button"
            class="token-select-button"
            aria-haspopup="listbox"
            aria-expanded={openTokenMenu === 'give'}
            on:click|stopPropagation={() => toggleTokenMenu('give')}
          >
            <span class={`token-dot token-${tokenClass(giveTokenSymbol)}`}>{tokenIconText(giveTokenSymbol)}</span>
            {#key giveTokenId}
              <span class="token-select-visible" data-testid="swap-from-token-label">{sourceAssetLabel}</span>
            {/key}
            <span class="token-select-chevron" aria-hidden="true">⌄</span>
          </button>
          <select
            class="token-select-native"
            bind:value={giveTokenId}
            data-testid="swap-from-token-select"
            aria-label="Swap from token"
            on:change={handleGiveTokenChange}
          >
            {#each giveTokenOptions as token}
              <option value={String(token.tokenId)}>{token.label}</option>
            {/each}
          </select>
          {#if openTokenMenu === 'give'}
            <div class="token-menu" role="listbox" aria-label="Sell token">
              {#each giveTokenOptions as token}
                <button
                  type="button"
                  class:selected={token.tokenId === giveToken}
                  class="token-option"
                  role="option"
                  aria-selected={token.tokenId === giveToken}
                  on:click|stopPropagation={() => selectGiveTokenOption(token.tokenId)}
                >
                  <span class={`token-dot token-${tokenClass(token.symbol)}`}>{tokenIconText(token.symbol)}</span>
                  <span>{token.label}</span>
                </button>
              {/each}
            </div>
          {/if}
        </div>
      </div>
      <div class="leg-meta">
        <span>{sourceAssetLabel}</span>
        <strong data-testid="swap-available-stat" title={`Available ${formattedAvailableGive}`}>
          Available: {formattedAvailableGiveAmount}
        </strong>
      </div>
    </div>

    <div class="swap-leg-divider">
      <button
        type="button"
        class="direction-chip"
        data-testid="swap-flip-tokens"
        on:click={flipSwapTokens}
        title="Swap selected tokens"
        aria-label="Swap selected tokens"
      >⇅</button>
    </div>

    <div class="swap-leg-card">
      <div class="leg-header">
        <span>To</span>
        <div class="route-select-wrap" data-swap-menu-root>
          <button
            type="button"
            class="entity-select-button route-menu-button"
            use:routeMenuButtonAction
            data-testid="swap-route-menu-button"
            data-route-menu-open={$routeMenuOpenStore ? 'true' : 'false'}
            data-route-menu-toggle-count={routeMenuToggleCount}
            data-route-native-click-count={routeMenuNativeClickCount}
            data-route-menu-set-count={routeMenuSetCount}
            data-route-menu-last-set={routeMenuLastSetReason}
            aria-haspopup="listbox"
            aria-expanded={$routeMenuOpenStore}
            title={selectedRouteLabel}
          >
            <span class="entity-avatar-wrap">
              {#if selectedRouteEntityId && entityAvatarSrc(selectedRouteEntityId)}
                <img class="entity-avatar-mini" src={entityAvatarSrc(selectedRouteEntityId)} alt="" />
              {:else}
                <span class="entity-avatar-mini placeholder">{entityInitials(selectedRouteEntityId, selectedRouteEntityName)}</span>
              {/if}
              <span class="jurisdiction-mini-badge">{jurisdictionBadgeText(selectedRouteJurisdictionLabel)}</span>
            </span>
            <span class="entity-select-copy">
              <strong>{formatEntityNetworkLabel(selectedRouteEntityName, selectedRouteJurisdictionLabel)}</strong>
            </span>
            <span class="entity-select-chevron" aria-hidden="true">⌄</span>
          </button>
          <select
            class="route-select-native"
            bind:this={routeSelectElement}
            bind:value={selectedRouteValue}
            data-testid="swap-route-select"
            data-selected-route-value={liveSelectedRouteValue}
            data-committed-route-value={committedRouteSelectionValue}
            data-route-commit-nonce={routeSelectionCommitNonce}
            data-selected-route-mode={swapRouteMode}
            data-selected-route-known={visibleRouteOptions.some((option) => option.value === liveSelectedRouteValue) ? 'true' : 'false'}
            data-selected-route-disabled={liveSelectedRouteValue !== 'same' && visibleRouteOptions.find((option) => option.value === liveSelectedRouteValue)?.disabled ? 'true' : 'false'}
            aria-label="Swap to network"
            title={selectedRouteLabel}
            on:input={handleRouteSelectChange}
            on:change={handleRouteSelectChange}
          >
            {#each visibleRouteOptions as option}
              <option
                value={option.value}
                disabled={option.disabled}
                selected={option.value === liveSelectedRouteValue}
                title={option.label}
              >
                {option.label}
              </option>
            {/each}
          </select>
          {#if $routeMenuOpenStore}
            <div class="route-menu" data-testid="swap-route-menu" role="listbox" aria-label="Destination account">
              {#each visibleRouteOptions as option}
                <button
                  type="button"
                  data-testid="swap-route-option"
                  data-route-value={option.value}
                  class:selected={option.value === liveSelectedRouteValue}
                  class:disabled={option.disabled}
                  class="route-option"
                  role="option"
                  aria-selected={option.value === liveSelectedRouteValue}
                  disabled={option.disabled}
                  title={option.disabledReason || option.label}
                  on:click|stopPropagation={() => selectRouteOption(option.value)}
                >
                  <span class="entity-avatar-wrap">
                    {#if option.targetEntityId && entityAvatarSrc(option.targetEntityId)}
                      <img class="entity-avatar-mini" src={entityAvatarSrc(option.targetEntityId)} alt="" />
                    {:else}
                      <span class="entity-avatar-mini placeholder">{entityInitials(option.targetEntityId, accountLabel(option.targetEntityId))}</span>
                    {/if}
                    <span class="jurisdiction-mini-badge">{jurisdictionBadgeText(option.targetJurisdiction)}</span>
                  </span>
                  <span class="route-option-copy">
                    <strong>{formatEntityNetworkLabel(accountLabel(option.targetEntityId), option.targetJurisdiction)}</strong>
                    {#if option.disabledReason}
                      <small>{option.disabledReason}</small>
                    {/if}
                  </span>
                </button>
              {/each}
            </div>
          {/if}
        </div>
      </div>
      <div class="leg-main">
        <input
          type="text"
          readonly
          value={formatAmount(wantAmount, wantToken)}
          class="readonly-input receive-amount"
          data-testid="swap-receive-amount"
          aria-label="Estimated receive amount"
        />
        <div class="token-select-wrap" data-swap-menu-root title={wantTokenSymbol}>
          <button
            type="button"
            class="token-select-button"
            aria-haspopup="listbox"
            aria-expanded={openTokenMenu === 'want'}
            on:click|stopPropagation={() => toggleTokenMenu('want')}
          >
            <span class={`token-dot token-${tokenClass(wantTokenSymbol)}`}>{tokenIconText(wantTokenSymbol)}</span>
            {#key wantTokenId}
              <span class="token-select-visible" data-testid="swap-to-token-label">{targetAssetLabel}</span>
            {/key}
            <span class="token-select-chevron" aria-hidden="true">⌄</span>
          </button>
          <select
            class="token-select-native"
            bind:value={wantTokenId}
            data-testid="swap-to-token-select"
            aria-label="Swap to token"
            on:change={handleWantTokenChange}
          >
            {#each wantTokenOptions as token}
              <option value={String(token.tokenId)}>{token.label}</option>
            {/each}
          </select>
          {#if openTokenMenu === 'want'}
            <div class="token-menu" role="listbox" aria-label="Buy token">
              {#each wantTokenOptions as token}
                <button
                  type="button"
                  class:selected={token.tokenId === wantToken}
                  class="token-option"
                  role="option"
                  aria-selected={token.tokenId === wantToken}
                  on:click|stopPropagation={() => selectWantTokenOption(token.tokenId)}
                >
                  <span class={`token-dot token-${tokenClass(token.symbol)}`}>{tokenIconText(token.symbol)}</span>
                  <span>{token.label}</span>
                </button>
              {/each}
            </div>
          {/if}
        </div>
      </div>
      <div class="leg-meta">
        <span>{targetAssetLabel}</span>
        <strong title={targetAccountReady ? `Inbound capacity ${formattedTargetCapacityAmount} ${wantTokenSymbol}` : 'Account setup required'}>{targetCapacityLabel}</strong>
      </div>
    </div>
  </div>

  <SwapPriceVenueControls
    bind:priceRatioInput
    {quoteTokenSymbol}
    {marketPriceTicks}
    {marketPriceSideLabel}
    {marketPriceLabel}
    {bookVenueLabel}
    {orderPercent}
    {handlePriceRatioInput}
    {stepPrice}
    {useMarketPrice}
    {applyOrderPercent}
  />

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

  {#if capacityWarning}
    <p class="capacity-warn">{capacityWarning}</p>
  {/if}

  {#if autoCapacityNote}
    <p class="auto-capacity-note" data-testid="swap-auto-capacity-note">{autoCapacityNote}</p>
  {/if}

  {#if selectedOrderLevel}
    <p class="size-hint" data-testid="swap-size-hint">
      Filled from book level at {formatPriceTicks(selectedOrderLevel.inputPriceTicks > 0n
        ? selectedOrderLevel.inputPriceTicks
        : selectedOrderLevel.priceTicks)}
      from {accountLabel(selectedOrderLevel.accountId)}
    </p>
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
    class="primary-btn"
    class:buy-action={orderMode === 'buy-base'}
    class:sell-action={orderMode === 'sell-base'}
    data-testid="swap-submit-order"
    on:click={placeSwapOffer}
    disabled={placingSwapOffer || Boolean(swapActionDisabledReason)}
  >
    {swapSubmitLabel}
  </button>
  {#if swapActionDisabledReason || submitError}
    <p class="form-error" data-testid="swap-form-error">{submitError || swapActionDisabledReason}</p>
  {/if}
</div>
