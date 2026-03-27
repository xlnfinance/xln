<script lang="ts">
  import { onDestroy } from 'svelte';
  import EntityInput from '../shared/EntityInput.svelte';

  type MoveEndpoint = 'external' | 'reserve' | 'account';
  type MoveEntityInputEvent = CustomEvent<{ value?: string }>;
  type MoveDisplayBalances = Record<MoveEndpoint, bigint>;
  type MoveNodeAction = (
    node: HTMLButtonElement,
    params: { side: 'from' | 'to'; endpoint: MoveEndpoint },
  ) => { update?: (next: { side: 'from' | 'to'; endpoint: MoveEndpoint }) => void; destroy?: () => void } | void;

  export let mode: 'assets' | 'accounts' = 'assets';
  export let moveAmount = '';
  export let moveAssetSymbol = 'USDC';
  export let moveFromEndpoint: MoveEndpoint = 'external';
  export let moveToEndpoint: MoveEndpoint = 'reserve';
  export let moveExternalRecipient = '';
  export let moveReserveRecipientEntityId = '';
  export let moveSourceAccountId = '';
  export let moveTargetEntityId = '';
  export let moveTargetHubEntityId = '';
  export let moveExecuting = false;
  export let moveProgressLabel = '';
  export let moveDraftError: string | null = null;
  export let moveBroadcastError: string | null = null;
  export let moveSelectedSource: MoveEndpoint | null = null;
  export let moveSelectedTarget: MoveEndpoint | null = null;
  export let moveDragSource: MoveEndpoint | null = null;
  export let moveDragHoverTarget: MoveEndpoint | null = null;
  export let moveLineReady = false;
  export let moveCommittedLineReady = false;
  export let moveNodeLayoutVersion = 0;
  export let moveNeedsReserveRecipient: (from: MoveEndpoint, to: MoveEndpoint) => boolean;
  export let moveNeedsExternalRecipient: (from: MoveEndpoint, to: MoveEndpoint) => boolean;
  export let isMoveRouteSupported: (from: MoveEndpoint, to: MoveEndpoint) => boolean;
  export let moveDisplayBalances: MoveDisplayBalances = { external: 0n, reserve: 0n, account: 0n };
  export let moveDisplayDecimals = 18;
  export let moveSourceAvailableBalance = 0n;
  export let fillMoveMax: () => void;
  export let setMoveSource: (endpoint: MoveEndpoint) => void;
  export let setMoveTarget: (endpoint: MoveEndpoint) => void;
  export let beginMoveDrag: (endpoint: MoveEndpoint, event: PointerEvent | MouseEvent) => void;
  export let getMoveNodeAnchor: (side: 'from' | 'to', endpoint: MoveEndpoint) => { x: number; y: number } | null;
  export let buildMoveArrowPath: (
    start: { x: number; y: number } | null,
    end: { x: number; y: number } | null,
  ) => string;
  export let moveRouteExecutionLabel: (from: MoveEndpoint, to: MoveEndpoint) => string;
  export let moveRouteMeta: (from: MoveEndpoint, to: MoveEndpoint) => string;
  export let moveRouteSteps: (from: MoveEndpoint, to: MoveEndpoint) => string[];
  export let canAddMoveToExistingBatch: () => boolean;
  export let submitMovePrimaryAction: () => Promise<void>;
  export let movePrimaryActionLabel = 'Add to Batch';
  export let handleMoveSourceAccountChange: (event: MoveEntityInputEvent) => void;
  export let handleMoveReserveRecipientChange: (event: MoveEntityInputEvent) => void;
  export let handleMoveTargetEntityChange: (event: MoveEntityInputEvent) => void;
  export let handleMoveTargetHubChange: (event: MoveEntityInputEvent) => void;
  export let moveNodeAction: MoveNodeAction;
  export let moveEntityOptions: string[] = [];
  export let moveHubEntityOptions: string[] = [];
  export let moveSourceAccountOptions: string[] = [];
  export let reserveRecipientPreferredId = '';
  export let targetEntityPreferredId = '';
  export let entityId = '';
  export let moveAssetOptions: Array<{ symbol: string }> = [];
  export let moveEndpointLabels: Record<MoveEndpoint, string>;
  export let moveEndpoints: MoveEndpoint[] = ['external', 'reserve', 'account'];
  export let formatAmount: (amount: bigint, decimals?: number) => string;
  export let formatInlineFillAmount: (amount: bigint, decimals?: number) => string;
  export let onMoveVisualRoot: (node: HTMLDivElement | null) => void = () => undefined;
  export let toastMoveError: (error: unknown) => void = () => undefined;

  let moveVisualRoot: HTMLDivElement | null = null;

  function getDisplayBalance(endpoint: MoveEndpoint): bigint {
    return moveDisplayBalances[endpoint] ?? 0n;
  }

  function getSourceNodeBalance(endpoint: MoveEndpoint): bigint {
    if (endpoint === moveFromEndpoint) {
      return moveSourceAvailableBalance;
    }
    return getDisplayBalance(endpoint);
  }

  function getEndpointDescriptor(endpoint: MoveEndpoint): string {
    switch (endpoint) {
      case 'external':
        return 'Wallet / EOA balance';
      case 'reserve':
        return 'Reserve ledger balance';
      case 'account':
        return 'Counterparty credit balance';
      default:
        return '';
    }
  }

  function getTargetHint(endpoint: MoveEndpoint): string {
    const activeSource = moveSelectedSource || moveFromEndpoint;
    if (!isMoveRouteSupported(activeSource, endpoint)) return 'Unavailable';
    if (moveToEndpoint === endpoint) return 'Destination selected';
    if (moveDragSource) return 'Drop here';
    return 'Set destination';
  }

  function stripStepPrefix(step: string): string {
    return step.replace(/^\d+\.\s*/, '').trim();
  }

  $: moveRouteKey = `${moveFromEndpoint}->${moveToEndpoint}`;
  $: moveRouteDirect = moveRouteKey === 'external->external';
  $: moveRouteRequiresDetails = moveFromEndpoint === 'account'
    || moveNeedsReserveRecipient(moveFromEndpoint, moveToEndpoint)
    || moveToEndpoint === 'account'
    || moveNeedsExternalRecipient(moveFromEndpoint, moveToEndpoint);
  $: movePrimaryActionDisabled = canAddMoveToExistingBatch() ? !!moveDraftError : !!moveBroadcastError;
  $: moveUsesDraftAction = canAddMoveToExistingBatch();
  $: moveVisibleActionError = moveUsesDraftAction ? moveDraftError : moveBroadcastError;
  $: moveSourceBalanceLabel = formatAmount(moveSourceAvailableBalance, moveDisplayDecimals);
  $: moveAmountPreview = moveAmount.trim() || '0.00';
  $: moveStepList = moveRouteSteps(moveFromEndpoint, moveToEndpoint);
  $: onMoveVisualRoot(moveVisualRoot);

  onDestroy(() => {
    onMoveVisualRoot(null);
  });
</script>

<div class="move-route-builder" data-testid={`move-workspace-${mode}`}>
  <div class="move-topline">
    <div class="move-hero-card">
      <div class="move-hero-copy">
        <span class="move-kicker">Move amount</span>
        <div class="move-hero-title">Choose amount and funding token</div>
        <div class="move-hero-caption">
          Available from {moveEndpointLabels[moveFromEndpoint]}: {moveSourceBalanceLabel}
        </div>
      </div>

      <div class="asset-amount-shell move-amount-shell">
        <input class="move-amount-input" type="text" bind:value={moveAmount} placeholder="0.00" data-testid="move-amount" />

        <button
          type="button"
          class="move-max-chip"
          on:click={fillMoveMax}
          disabled={moveSourceAvailableBalance <= 0n}
        >
          <span class="move-max-label">Max</span>
          <span class="move-max-value">{formatInlineFillAmount(moveSourceAvailableBalance, moveDisplayDecimals)}</span>
        </button>

        <div class="asset-inline-controls">
          <select class="asset-token-select-inline compact move-token-select" bind:value={moveAssetSymbol} data-testid="move-asset-symbol">
            {#each moveAssetOptions as token}
              <option value={token.symbol}>{token.symbol}</option>
            {/each}
          </select>
        </div>
      </div>
    </div>
  </div>

  <div class="move-visual" bind:this={moveVisualRoot}>
    <div class="move-column">
      <div class="move-column-head">
        <span>From</span>
        <span class="move-column-copy">Pick the balance you want to spend</span>
      </div>

      {#each moveEndpoints as endpoint}
        <button
          type="button"
          class="move-node"
          class:source-active={moveFromEndpoint === endpoint}
          class:selected={moveFromEndpoint === endpoint}
          class:pending={moveSelectedSource === endpoint}
          class:dragging={moveDragSource === endpoint}
          data-testid={`move-source-${endpoint}`}
          data-move-side="from"
          data-move-endpoint={endpoint}
          use:moveNodeAction={{ side: 'from', endpoint }}
          on:pointerdown={(event) => beginMoveDrag(endpoint, event)}
          on:mousedown={(event) => beginMoveDrag(endpoint, event)}
          on:click={() => setMoveSource(endpoint)}
        >
          <span class="move-node-top">
            <span class="move-node-label">{moveEndpointLabels[endpoint]}</span>
            {#if moveFromEndpoint === endpoint}
              <span class="move-node-badge">Source</span>
            {/if}
          </span>
          <span class="move-node-balance">{formatAmount(getSourceNodeBalance(endpoint), moveDisplayDecimals)}</span>
          <span class="move-node-subline">{getEndpointDescriptor(endpoint)}</span>
        </button>
      {/each}
    </div>

    <div class="move-column">
      <div class="move-column-head">
        <span>To</span>
        <span class="move-column-copy">Choose where the value should land</span>
      </div>

      {#each moveEndpoints as endpoint}
        <button
          type="button"
          class="move-node target"
          class:target-active={moveToEndpoint === endpoint}
          class:selected={moveToEndpoint === endpoint}
          class:pending={moveSelectedTarget === endpoint}
          class:hover-target={moveDragHoverTarget === endpoint}
          class:blocked={!isMoveRouteSupported(moveSelectedSource || moveFromEndpoint, endpoint)}
          data-testid={`move-target-${endpoint}`}
          data-move-side="to"
          data-move-endpoint={endpoint}
          use:moveNodeAction={{ side: 'to', endpoint }}
          on:pointerenter={() => {
            if (moveDragSource) moveDragHoverTarget = endpoint;
          }}
          on:mouseenter={() => {
            if (moveDragSource) moveDragHoverTarget = endpoint;
          }}
          on:pointerleave={() => {
            if (moveDragHoverTarget === endpoint) moveDragHoverTarget = null;
          }}
          on:mouseleave={() => {
            if (moveDragHoverTarget === endpoint) moveDragHoverTarget = null;
          }}
          on:click={() => setMoveTarget(endpoint)}
        >
          <span class="move-node-top">
            <span class="move-node-label">{moveEndpointLabels[endpoint]}</span>
            {#if moveToEndpoint === endpoint}
              <span class="move-node-badge target">Destination</span>
            {/if}
          </span>
          <span class="move-node-target-hint">{getTargetHint(endpoint)}</span>
          <span class="move-node-subline">{getEndpointDescriptor(endpoint)}</span>
        </button>
      {/each}
    </div>

    {#if moveRouteRequiresDetails}
      <section class="move-route-details" data-testid="move-route-details">
        <div class="move-route-details-head">
          <span class="move-column-head details-head">Route details</span>
          <span class="move-route-details-copy">Only the extra fields required for this route are shown.</span>
        </div>

        <div class="move-detail-grid">
          {#if moveFromEndpoint === 'account'}
            <div class="move-account-slot source-detail" data-testid="move-source-account-field">
              <EntityInput
                variant="move"
                testId="move-source-account-picker"
                label="From account"
                value={moveSourceAccountId}
                entities={moveSourceAccountOptions}
                excludeId={entityId}
                placeholder="Select source account..."
                disabled={moveSourceAccountOptions.length === 0}
                on:change={handleMoveSourceAccountChange}
              />
            </div>
          {/if}

          {#if moveNeedsReserveRecipient(moveFromEndpoint, moveToEndpoint)}
            <div class="move-account-slot target-detail" data-testid="move-reserve-recipient-field">
              <EntityInput
                variant="move"
                testId="move-reserve-recipient-picker"
                label="To reserve entity"
                value={moveReserveRecipientEntityId}
                entities={moveEntityOptions}
                placeholder="Recipient entity..."
                preferredId={reserveRecipientPreferredId}
                on:change={handleMoveReserveRecipientChange}
              />
            </div>
          {/if}

          {#if moveToEndpoint === 'account'}
            <div class="move-account-slot target-detail" data-testid="move-target-entity-field">
              <EntityInput
                variant="move"
                testId="move-target-entity-picker"
                label="Recipient"
                value={moveTargetEntityId}
                entities={moveEntityOptions}
                placeholder="Recipient entity..."
                preferredId={targetEntityPreferredId}
                on:change={handleMoveTargetEntityChange}
              />
            </div>

            <div class="move-account-slot target-detail" data-testid="move-target-counterparty-field">
              <EntityInput
                variant="move"
                testId="move-target-counterparty-picker"
                label="Counterparty"
                value={moveTargetHubEntityId}
                entities={moveHubEntityOptions}
                placeholder="Counterparty entity..."
                on:change={handleMoveTargetHubChange}
              />
            </div>
          {/if}

          {#if moveNeedsExternalRecipient(moveFromEndpoint, moveToEndpoint)}
            <label class="asset-field move-account-slot move-detail-field target-detail" data-testid="move-external-recipient-field">
              <span class="asset-field-head">
                <span>Recipient EOA</span>
              </span>
              <input class="move-external-input" type="text" bind:value={moveExternalRecipient} placeholder="0x..." data-testid="move-external-recipient" />
            </label>
          {/if}
        </div>
      </section>
    {/if}

    {#if !moveDragSource}
      {@const _moveLayoutTick = moveNodeLayoutVersion}
      {@const committedStart = getMoveNodeAnchor('from', moveFromEndpoint)}
      {@const committedEnd = getMoveNodeAnchor('to', moveToEndpoint)}
      {#if moveCommittedLineReady && committedStart && committedEnd}
        <svg class="move-drag-layer committed" data-testid="move-committed-line" aria-hidden="true">
          <path d={buildMoveArrowPath(committedStart, committedEnd)}></path>
        </svg>
      {/if}
    {:else}
      {@const _moveLayoutTick = moveNodeLayoutVersion}
      {@const dragStart = getMoveNodeAnchor('from', moveDragSource)}
      {@const dragEnd = getMoveNodeAnchor('to', moveDragHoverTarget || moveToEndpoint)}
      {#if moveLineReady && dragStart && dragEnd}
        <svg class="move-drag-layer" data-testid="move-drag-line" aria-hidden="true">
          <path d={buildMoveArrowPath(dragStart, dragEnd)}></path>
        </svg>
      {/if}
    {/if}
  </div>

  <div class="move-summary" data-testid="move-route-summary">
    <div class="move-summary-top">
      <div class="move-summary-copy">
        <div class="move-summary-pill">
          {moveEndpointLabels[moveFromEndpoint]} → {moveEndpointLabels[moveToEndpoint]}
        </div>
        <div class="move-summary-title">{moveRouteExecutionLabel(moveFromEndpoint, moveToEndpoint)}</div>
        <div class="move-summary-meta">{moveRouteMeta(moveFromEndpoint, moveToEndpoint)}</div>
      </div>

      <div class="move-summary-hero">
        <span class="move-summary-hero-label">Amount</span>
        <strong class="move-summary-hero-value">{moveAmountPreview} {moveAssetSymbol}</strong>
      </div>
    </div>

    <div class="move-summary-grid">
      <div class="move-summary-metric">
        <span class="move-summary-metric-label">Source balance</span>
        <span class="move-summary-metric-value mono">{moveSourceBalanceLabel}</span>
      </div>
      <div class="move-summary-metric">
        <span class="move-summary-metric-label">How it runs</span>
        <span class="move-summary-metric-value">
          {moveRouteDirect ? 'Direct wallet submission' : (moveUsesDraftAction ? 'Queued on-chain batch' : 'Queued settlement flow')}
        </span>
      </div>
      <div class="move-summary-metric">
        <span class="move-summary-metric-label">Destination</span>
        <span class="move-summary-metric-value">{moveEndpointLabels[moveToEndpoint]}</span>
      </div>
    </div>

    {#if moveProgressLabel || moveVisibleActionError || moveUsesDraftAction}
      <div class="move-summary-statuses">
        {#if moveProgressLabel}
          <div class="move-summary-status accent" data-testid="move-status">{moveProgressLabel}</div>
        {/if}
        {#if moveUsesDraftAction && !moveVisibleActionError}
          <div class="move-summary-status neutral" data-testid="move-status">Queued in draft batch</div>
        {/if}
        {#if moveVisibleActionError}
          <div
            class="move-summary-status"
            class:warning={moveUsesDraftAction}
            class:error={!moveUsesDraftAction}
            data-testid="move-status"
          >
            {moveVisibleActionError}
          </div>
        {/if}
      </div>
    {/if}

    <div class="move-steps">
      {#each moveStepList as step, index}
        <div class="move-step-row">
          <span class="move-step-index">{index + 1}</span>
          <span class="move-step-copy">{stripStepPrefix(step)}</span>
        </div>
      {/each}
    </div>
  </div>

  <div class="asset-action-row">
    <button
      class="btn-table-action deposit move-primary-cta"
      data-testid="move-confirm"
      on:click={async () => {
        try {
          await submitMovePrimaryAction();
        } catch (err) {
          toastMoveError(err);
        }
      }}
      disabled={movePrimaryActionDisabled}
    >
      {moveExecuting ? 'Working...' : movePrimaryActionLabel}
    </button>
  </div>
</div>

<style>
  .move-route-builder {
    --move-accent: var(--theme-accent, #fbbf24);
    --move-border: color-mix(in srgb, var(--theme-card-border, var(--theme-border, #27272a)) 86%, transparent);
    --move-surface: color-mix(in srgb, var(--theme-card-bg, var(--theme-surface, #18181b)) 98%, transparent);
    --move-surface-hover: color-mix(in srgb, var(--theme-surface-hover, var(--theme-card-bg, #1c1c20)) 96%, transparent);
    --move-input-bg: color-mix(in srgb, var(--theme-input-bg, var(--theme-card-bg, #09090b)) 98%, transparent);
    --move-text: var(--theme-text-primary, #e4e4e7);
    --move-text-secondary: var(--theme-text-secondary, #a1a1aa);
    --move-text-muted: var(--theme-text-muted, #71717a);
    --move-radius: 14px;
    --move-control-height: 52px;
    --move-card-height: 64px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    width: 100%;
    min-width: 0;
    max-width: 100%;
    box-sizing: border-box;
    isolation: isolate;
  }

  .move-route-builder,
  .move-route-builder * {
    box-sizing: border-box;
  }

  .move-topline {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 8px;
  }

  .move-hero-card {
    display: grid;
    grid-template-columns: minmax(0, 220px) minmax(0, 1fr);
    gap: 12px;
    align-items: end;
    padding: 0;
    border: none;
    background: transparent;
    box-shadow: none;
    min-width: 0;
  }

  .move-hero-copy {
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    gap: 6px;
    min-width: 0;
    padding: 2px 2px 0;
  }

  .move-kicker {
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--move-accent);
  }

  .move-hero-title {
    font-size: 15px;
    font-weight: 700;
    color: var(--move-text);
    letter-spacing: -0.015em;
    line-height: 1.15;
    max-width: 18ch;
  }

  .move-hero-caption {
    font-size: 11px;
    color: color-mix(in srgb, var(--move-text-secondary) 90%, var(--move-text-muted));
    line-height: 1.35;
  }

  .move-amount-shell {
    min-height: 56px;
    padding-right: 8px;
    border-radius: 16px;
    overflow: hidden;
  }

  .move-visual {
    position: relative;
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 14px;
    padding: 14px 16px 16px;
    border: 1px solid color-mix(in srgb, var(--move-border) 48%, transparent);
    border-radius: var(--move-radius);
    background:
      linear-gradient(180deg, color-mix(in srgb, var(--move-surface) 88%, transparent), color-mix(in srgb, var(--move-input-bg) 78%, transparent)),
      radial-gradient(circle at top, color-mix(in srgb, var(--move-accent) 4%, transparent), transparent 56%);
    overflow: visible;
    box-shadow: none;
    width: 100%;
    min-width: 0;
    max-width: 100%;
    z-index: 3;
  }

  .move-column {
    display: flex;
    flex-direction: column;
    gap: 8px;
    position: relative;
    z-index: 1;
    min-width: 0;
  }

  .move-column-head {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
    font-size: 9px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--move-text-muted);
    padding: 0 2px;
  }

  .move-column-copy {
    font-size: 10px;
    font-weight: 500;
    line-height: 1.25;
    letter-spacing: 0;
    text-transform: none;
    color: color-mix(in srgb, var(--move-text-muted) 84%, transparent);
  }

  .details-head {
    margin: 0;
  }

  .move-account-slot {
    min-width: 0;
    width: 100%;
    max-width: 100%;
  }

  .move-account-slot.source-detail {
    grid-column: 1;
  }

  .move-account-slot.target-detail {
    grid-column: 2;
  }

  .move-route-details {
    grid-column: 1 / -1;
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-width: 0;
    position: relative;
    z-index: 1;
    padding-top: 10px;
    border-top: 1px solid color-mix(in srgb, var(--move-border) 40%, transparent);
    width: 100%;
    max-width: 100%;
    overflow: visible;
  }

  .move-route-details-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
  }

  .move-route-details-copy {
    font-size: 10px;
    color: color-mix(in srgb, var(--move-text-muted) 82%, transparent);
  }

  .move-detail-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
    min-width: 0;
    width: 100%;
    max-width: 100%;
    align-items: start;
    overflow: visible;
  }

  .move-detail-field {
    min-width: 0;
    width: 100%;
    max-width: 100%;
  }

  .move-drag-layer {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    display: block;
    overflow: visible;
    pointer-events: none;
    z-index: 3;
  }

  .move-drag-layer path {
    stroke: color-mix(in srgb, var(--move-accent) 96%, transparent);
    stroke-width: 1.75;
    stroke-linecap: round;
    stroke-linejoin: round;
    fill: none;
    stroke-dasharray: 6 6;
    opacity: 0.78;
    filter: none;
  }

  .move-drag-layer.committed path {
    stroke: color-mix(in srgb, var(--move-accent) 78%, transparent);
    stroke-width: 1.75;
    stroke-dasharray: none;
    opacity: 0.72;
    filter: none;
  }

  .move-node {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
    min-height: 60px;
    width: 100%;
    min-width: 0;
    padding: 11px 12px 11px 14px;
    border-radius: 10px;
    border: 1px solid color-mix(in srgb, var(--move-border) 46%, transparent);
    background: color-mix(in srgb, var(--move-input-bg) 86%, transparent);
    color: var(--move-text);
    text-align: left;
    cursor: grab;
    box-sizing: border-box;
    transition: border-color 0.14s ease, background 0.14s ease;
    user-select: none;
    touch-action: none;
    position: relative;
    overflow: hidden;
  }

  .move-node::before {
    content: '';
    position: absolute;
    left: 0;
    top: 10px;
    bottom: 10px;
    width: 2px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--move-border) 100%, transparent);
    opacity: 0.34;
  }

  .move-node:hover,
  .move-node.hover-target {
    border-color: color-mix(in srgb, var(--move-accent) 34%, var(--move-border));
    background: color-mix(in srgb, var(--move-surface-hover) 78%, transparent);
  }

  .move-node.selected,
  .move-node.source-active,
  .move-node.target-active {
    box-shadow: none;
  }

  .move-node.source-active {
    border-color: color-mix(in srgb, var(--move-accent) 48%, transparent);
    background:
      linear-gradient(90deg, color-mix(in srgb, var(--move-accent) 10%, transparent), transparent 18%),
      color-mix(in srgb, var(--move-surface-hover) 82%, transparent);
  }

  .move-node.source-active::before {
    background: color-mix(in srgb, var(--move-accent) 90%, transparent);
    opacity: 0.92;
  }

  .move-node.target-active {
    border-color: color-mix(in srgb, var(--theme-credit, #4ade80) 36%, transparent);
    background:
      linear-gradient(90deg, color-mix(in srgb, var(--theme-credit, #4ade80) 10%, transparent), transparent 18%),
      color-mix(in srgb, var(--move-surface-hover) 82%, transparent);
  }

  .move-node.target-active::before {
    background: color-mix(in srgb, var(--theme-credit, #4ade80) 84%, transparent);
    opacity: 0.84;
  }

  .move-node.pending {
    border-color: color-mix(in srgb, var(--move-accent) 70%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--move-accent) 22%, transparent);
  }

  .move-node.dragging {
    cursor: grabbing;
    opacity: 0.92;
  }

  .move-node.blocked {
    opacity: 0.45;
  }

  .move-node-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    width: 100%;
    min-width: 0;
    overflow: hidden;
  }

  .move-node-label {
    font-size: 12px;
    font-weight: 700;
    color: var(--move-text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    letter-spacing: -0.01em;
  }

  .move-node-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 2px 7px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--move-accent) 9%, transparent);
    border: 1px solid color-mix(in srgb, var(--move-accent) 12%, transparent);
    color: var(--move-accent);
    font-size: 8px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    white-space: nowrap;
  }

  .move-node-badge.target {
    color: color-mix(in srgb, var(--theme-credit, #4ade80) 70%, white 30%);
    background: color-mix(in srgb, var(--theme-credit, #4ade80) 10%, transparent);
    border-color: color-mix(in srgb, var(--theme-credit, #4ade80) 18%, transparent);
  }

  .move-node-balance {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 15px;
    font-weight: 600;
    color: var(--move-accent);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .move-node-target-hint {
    font-size: 12px;
    font-weight: 600;
    color: var(--move-text-secondary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .move-node-subline {
    font-size: 10px;
    color: var(--move-text-muted);
    white-space: nowrap;
  }

  .move-summary {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 16px;
    border-radius: var(--move-radius);
    border: 1px solid color-mix(in srgb, var(--move-border) 46%, transparent);
    background: color-mix(in srgb, var(--move-surface) 88%, transparent);
    width: 100%;
    min-width: 0;
    max-width: 100%;
    box-shadow: none;
    overflow: hidden;
    position: relative;
    z-index: 1;
  }

  .move-summary-top {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    flex-wrap: wrap;
    min-width: 0;
  }

  .move-summary-copy {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }

  .move-summary-pill {
    align-self: flex-start;
    padding: 4px 8px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--move-accent) 10%, transparent);
    color: var(--move-accent);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .move-summary-title {
    font-size: 14px;
    font-weight: 700;
    color: var(--move-text);
  }

  .move-summary-meta {
    font-size: 11px;
    color: var(--move-text-secondary);
  }

  .move-summary-hero {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
    padding: 8px 10px;
    border-radius: 10px;
    background: color-mix(in srgb, var(--move-input-bg) 76%, transparent);
    border: 1px solid color-mix(in srgb, var(--move-border) 40%, transparent);
    max-width: 100%;
  }

  .move-summary-hero-label {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--move-text-muted);
  }

  .move-summary-hero-value {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 17px;
    line-height: 1.1;
    color: var(--move-text);
    overflow-wrap: anywhere;
  }

  .move-summary-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 10px 16px;
    padding-top: 8px;
    border-top: 1px solid color-mix(in srgb, var(--move-border) 34%, transparent);
    min-width: 0;
  }

  .move-summary-metric {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
    padding: 0;
    border: none;
    background: transparent;
  }

  .move-summary-metric-label {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--move-text-muted);
  }

  .move-summary-metric-value {
    font-size: 12px;
    font-weight: 600;
    line-height: 1.35;
    color: var(--move-text-secondary);
    overflow-wrap: anywhere;
  }

  .move-summary-metric-value.mono {
    font-family: 'IBM Plex Mono', monospace;
    color: var(--move-text);
  }

  .move-summary-statuses {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }

  .move-summary-status {
    padding: 8px 10px;
    border-radius: 10px;
    border: 1px solid color-mix(in srgb, var(--move-border) 42%, transparent);
    background: color-mix(in srgb, var(--move-input-bg) 78%, transparent);
    font-size: 11px;
    color: var(--move-text-secondary);
    overflow-wrap: anywhere;
  }

  .move-summary-status.accent {
    color: var(--move-accent);
    border-color: color-mix(in srgb, var(--move-accent) 22%, transparent);
    background: color-mix(in srgb, var(--move-accent) 8%, transparent);
  }

  .move-summary-status.neutral {
    color: var(--move-text-secondary);
  }

  .move-summary-status.warning {
    color: color-mix(in srgb, var(--theme-warning, #f59e0b) 74%, white 26%);
    border-color: color-mix(in srgb, var(--theme-warning, #f59e0b) 22%, transparent);
    background: color-mix(in srgb, var(--theme-warning, #f59e0b) 8%, transparent);
  }

  .move-summary-status.error {
    color: color-mix(in srgb, var(--theme-debit, #f43f5e) 68%, white 32%);
    border-color: color-mix(in srgb, var(--theme-debit, #f43f5e) 22%, transparent);
    background: color-mix(in srgb, var(--theme-debit, #f43f5e) 8%, transparent);
  }

  .move-steps {
    display: flex;
    flex-direction: column;
    gap: 0;
    padding-top: 8px;
    border-top: 1px solid color-mix(in srgb, var(--move-border) 34%, transparent);
  }

  .move-step-row {
    display: grid;
    grid-template-columns: 26px minmax(0, 1fr);
    gap: 10px;
    align-items: flex-start;
    padding: 10px 0;
    border-radius: 0;
    border: none;
    border-top: 1px solid color-mix(in srgb, var(--move-border) 24%, transparent);
    background: transparent;
    min-width: 0;
  }

  .move-step-row:first-child {
    border-top: none;
  }

  .move-step-index {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--move-accent) 12%, transparent);
    color: var(--move-accent);
    font-size: 10px;
    font-weight: 700;
    font-family: 'IBM Plex Mono', monospace;
  }

  .move-step-copy {
    display: block;
    padding-top: 1px;
    color: var(--move-text-secondary);
    font-size: 11.5px;
    line-height: 1.45;
    overflow-wrap: anywhere;
  }

  .asset-field {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
    width: 100%;
  }

  .asset-field-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-width: 0;
  }

  .asset-field span {
    font-size: 10px;
    color: var(--move-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .asset-amount-shell {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto;
    align-items: stretch;
    gap: 8px;
    min-height: var(--move-control-height);
    width: 100%;
    min-width: 0;
    max-width: 100%;
    padding: 0 8px 0 16px;
    border: 1px solid color-mix(in srgb, var(--move-border) 42%, transparent);
    border-radius: 16px;
    background: linear-gradient(
      180deg,
      color-mix(in srgb, var(--move-surface) 76%, transparent),
      color-mix(in srgb, var(--move-input-bg) 100%, transparent)
    );
    box-sizing: border-box;
    overflow: hidden;
  }

  .asset-amount-shell:focus-within {
    border-color: color-mix(in srgb, var(--move-accent) 70%, transparent);
    box-shadow:
      0 0 0 1px color-mix(in srgb, var(--move-accent) 18%, transparent),
      0 10px 24px color-mix(in srgb, var(--theme-background, #09090b) 8%, transparent);
  }

  .move-amount-input {
    min-width: 0;
    width: 100%;
    height: 100%;
    padding: 0;
    border: none;
    background: transparent;
    color: var(--move-text);
    font-family: 'IBM Plex Mono', monospace;
    font-size: 26px;
    font-weight: 600;
    line-height: 1;
    letter-spacing: -0.02em;
  }

  .move-amount-input:focus {
    outline: none;
  }

  .asset-inline-controls {
    display: inline-flex;
    align-items: stretch;
    gap: 8px;
    margin-left: auto;
    min-width: 0;
    flex: 0 0 auto;
    align-self: stretch;
    max-width: 100%;
  }

  .move-max-chip {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    min-height: 42px;
    padding: 0 12px !important;
    border-radius: 999px !important;
    border: 1px solid color-mix(in srgb, var(--move-border) 44%, transparent) !important;
    background: color-mix(in srgb, var(--move-surface-hover) 78%, transparent) !important;
    color: var(--move-accent) !important;
    font-size: 11px !important;
    font-weight: 700 !important;
    letter-spacing: 0.04em !important;
    text-transform: uppercase;
    cursor: pointer;
    white-space: nowrap;
  }

  .move-max-chip:hover:not(:disabled) {
    border-color: color-mix(in srgb, var(--move-accent) 30%, transparent) !important;
    background: color-mix(in srgb, var(--move-accent) 12%, transparent) !important;
  }

  .move-max-chip:disabled {
    opacity: 0.45;
    cursor: default;
  }

  .move-max-label {
    opacity: 0.58;
  }

  .move-max-value {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 10px;
    letter-spacing: 0;
    text-transform: none;
  }

  .asset-token-select-inline {
    min-height: 42px;
    min-width: 110px;
    width: 110px;
    max-width: 100%;
  }

  .asset-token-select-inline.compact {
    min-height: 42px;
    padding: 0 30px 0 14px !important;
    border-radius: 10px !important;
    background: color-mix(in srgb, var(--move-surface) 78%, transparent) !important;
    border: 1px solid color-mix(in srgb, var(--move-border) 44%, transparent) !important;
    color: var(--move-text) !important;
    align-self: stretch;
    font-weight: 600 !important;
  }

  .move-token-select {
    min-width: 110px;
    width: 110px;
    max-width: 100%;
  }

  .move-external-input {
    min-height: 54px;
    width: 100%;
    min-width: 0;
    max-width: 100%;
    box-sizing: border-box;
    padding: 14px 15px !important;
    border-radius: 12px !important;
    border: 1px solid color-mix(in srgb, var(--move-border) 58%, transparent) !important;
    background: linear-gradient(
      180deg,
      color-mix(in srgb, var(--move-surface) 94%, transparent),
      color-mix(in srgb, var(--move-input-bg) 100%, transparent)
    ) !important;
    color: var(--move-text) !important;
    font-size: 14px !important;
  }

  .move-external-input:focus {
    outline: none;
    border-color: color-mix(in srgb, var(--move-accent) 70%, transparent) !important;
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--move-accent) 18%, transparent);
  }

  .asset-action-row {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    justify-content: flex-end;
    margin-top: 0;
    min-width: 0;
    width: 100%;
    max-width: 100%;
  }

  .btn-table-action {
    padding: 5px 10px;
    border: none;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s;
    white-space: nowrap;
    max-width: 100%;
  }

  .btn-table-action.deposit {
    background: linear-gradient(135deg, #16a34a, #15803d);
    color: #f0fdf4;
  }

  .btn-table-action.deposit:hover:not(:disabled) {
    background: linear-gradient(135deg, #22c55e, #16a34a);
  }

  .move-primary-cta {
    min-height: 44px;
    min-width: 220px;
    max-width: 100%;
    padding: 0 20px;
    border-radius: 12px;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    box-shadow: none;
  }

  .btn-table-action:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  @media (max-width: 900px) {
    .move-hero-card {
      grid-template-columns: 1fr;
      align-items: stretch;
    }

    .move-visual,
    .move-detail-grid,
    .move-summary-grid {
      grid-template-columns: 1fr;
    }

    .move-account-slot.source-detail,
    .move-account-slot.target-detail {
      grid-column: 1;
    }
  }

  @media (max-width: 760px) {
    .move-visual {
      gap: 12px;
      padding: 14px;
    }

    .move-column {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 8px;
      align-items: stretch;
    }

    .move-column-head,
    .move-route-details,
    .move-account-slot {
      grid-column: 1 / -1;
    }

    .move-node {
      min-height: 74px;
      padding: 10px;
      border-radius: 10px;
    }

    .move-summary-top {
      flex-direction: column;
      align-items: stretch;
    }

    .move-node-label,
    .move-node-balance,
    .move-node-target-hint,
    .move-node-subline {
      white-space: normal;
      line-height: 1.12;
    }

    .move-drag-layer {
      display: none;
    }
  }

  @media (max-width: 640px) {
    .move-hero-card {
      gap: 12px;
    }

    .move-amount-shell {
      grid-template-columns: 1fr;
      gap: 10px;
      min-height: 0;
      padding: 12px;
    }

    .move-amount-input {
      width: 100%;
      min-height: 34px;
      font-size: 28px;
    }

    .move-max-chip {
      min-height: 36px;
      padding: 0 11px !important;
    }

    .asset-inline-controls {
      width: 100%;
      margin-left: 0;
    }

    .move-token-select {
      width: 100%;
      min-width: 0;
    }

    .move-column {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .move-node {
      min-height: 0;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 4px 10px;
      align-items: center;
      padding: 10px 12px;
    }

    .move-node-top {
      grid-column: 1 / 2;
      justify-content: flex-start;
      gap: 8px;
    }

    .move-node-balance,
    .move-node-target-hint {
      grid-column: 2 / 3;
      justify-self: end;
      text-align: right;
    }

    .move-node-subline {
      grid-column: 1 / -1;
      white-space: normal;
    }

    .move-summary {
      padding: 14px;
    }

    .move-summary-hero {
      width: 100%;
    }

    .move-step-row {
      grid-template-columns: 22px minmax(0, 1fr);
      gap: 8px;
      padding: 8px 10px;
    }

    .move-step-index {
      width: 22px;
      height: 22px;
      font-size: 11px;
    }
  }

  @media (max-width: 520px) {
    .move-max-chip {
      width: 100%;
      justify-content: space-between;
    }

    .asset-inline-controls {
      width: 100%;
      justify-content: space-between;
    }

    .asset-token-select-inline,
    .move-token-select {
      width: 100%;
      min-width: 0;
    }

    .move-primary-cta {
      width: 100%;
      min-width: 0;
    }
  }
</style>
