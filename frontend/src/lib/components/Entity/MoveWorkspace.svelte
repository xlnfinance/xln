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
  $: moveStepList = moveRouteSteps(moveFromEndpoint, moveToEndpoint);
  $: onMoveVisualRoot(moveVisualRoot);

  onDestroy(() => {
    onMoveVisualRoot(null);
  });
</script>

<div class="move-route-builder" data-testid={`move-workspace-${mode}`}>
  <div class="move-visual" bind:this={moveVisualRoot}>
    <div class="move-column">
      <div class="move-column-head">
        <span>From</span>
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
          <span class="move-node-label">{moveEndpointLabels[endpoint]}</span>
          <span
            class="move-node-balance sr-only"
            data-testid={`move-source-balance-${endpoint}`}
            data-raw-amount={getSourceNodeBalance(endpoint).toString()}
          >{formatAmount(getSourceNodeBalance(endpoint), moveDisplayDecimals)}</span>
        </button>
      {/each}
    </div>

    <div class="move-column">
      <div class="move-column-head">
        <span>To</span>
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
          <span class="move-node-label">{moveEndpointLabels[endpoint]}</span>
        </button>
      {/each}
    </div>

    {#if moveRouteRequiresDetails}
      <section class="move-route-details" data-testid="move-route-details">
        <div class="move-route-details-head">
          <span class="move-column-head details-head">Details</span>
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
        <div class="move-summary-meta">
          Available {moveSourceBalanceLabel} {moveAssetSymbol}
        </div>
      </div>
      <div class="move-inline-composer">
        <input class="move-amount-input" type="text" bind:value={moveAmount} placeholder="0.00" data-testid="move-amount" />
        <select class="move-asset-select" bind:value={moveAssetSymbol} data-testid="move-asset-symbol">
          {#each moveAssetOptions as token}
            <option value={token.symbol}>{token.symbol}</option>
          {/each}
        </select>
      </div>
    </div>

    {#if moveProgressLabel || moveVisibleActionError}
      <div class="move-summary-statuses">
        {#if moveProgressLabel}
          <div class="move-summary-status accent" data-testid="move-status">{moveProgressLabel}</div>
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
    align-items: center;
    min-width: 0;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--move-text-muted);
    padding: 0 2px;
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
    align-items: center;
    gap: 12px;
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
    align-items: center;
    justify-content: center;
    gap: 0;
    min-height: 72px;
    width: 100%;
    min-width: 0;
    padding: 10px;
    border-radius: 10px;
    border: 1px solid color-mix(in srgb, var(--move-border) 46%, transparent);
    background: color-mix(in srgb, var(--move-input-bg) 86%, transparent);
    color: var(--move-text);
    text-align: center;
    cursor: grab;
    box-sizing: border-box;
    transition: border-color 0.14s ease, background 0.14s ease;
    user-select: none;
    touch-action: manipulation;
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

  .move-node-label {
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0;
    color: var(--move-text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
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
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-width: 0;
  }

  .move-summary-copy {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
    min-width: 0;
  }

  .move-summary-meta {
    font-size: 11px;
    color: color-mix(in srgb, var(--move-text-secondary) 90%, var(--move-text-muted));
    line-height: 1.2;
    font-variant-numeric: tabular-nums;
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

  .move-inline-composer {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: 8px;
    min-height: 58px;
    min-width: min(420px, 100%);
    padding: 6px;
    border: 1px solid color-mix(in srgb, var(--move-border) 46%, transparent);
    border-radius: 16px;
    background: linear-gradient(
      180deg,
      color-mix(in srgb, var(--move-surface) 88%, transparent),
      color-mix(in srgb, var(--move-input-bg) 98%, transparent)
    );
  }

  .move-inline-composer:focus-within {
    border-color: color-mix(in srgb, var(--move-accent) 70%, transparent);
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--move-accent) 18%, transparent);
  }

  .move-asset-select {
    min-height: 44px;
    min-width: 140px;
    padding: 0 12px;
    border-radius: 12px;
    border: 1px solid color-mix(in srgb, var(--move-border) 54%, transparent);
    background: color-mix(in srgb, var(--move-input-bg) 92%, transparent);
    color: var(--move-text);
    font-size: 13px;
    font-weight: 600;
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

  .move-amount-input {
    min-width: 0;
    width: 100%;
    height: 44px;
    padding: 0 14px;
    border: none;
    border-radius: 12px;
    background: color-mix(in srgb, var(--move-input-bg) 96%, transparent);
    color: var(--move-text);
    font-family: 'IBM Plex Mono', monospace;
    font-size: 28px;
    font-weight: 600;
    line-height: 1;
    letter-spacing: -0.02em;
  }

  .move-amount-input:focus {
    outline: none;
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
    min-height: 44px;
    padding: 10px 14px;
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
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
      padding: 14px;
    }

    .move-column {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .move-node {
      min-height: 70px;
      padding: 8px;
      border-radius: 10px;
    }

    .move-summary-top {
      flex-direction: column;
      align-items: stretch;
    }

    .move-inline-composer {
      min-width: 0;
    }
    .move-drag-layer {
      display: none;
    }
  }

  @media (max-width: 640px) {
    .move-inline-composer {
      grid-template-columns: 1fr;
    }

    .move-amount-input {
      width: 100%;
      min-height: 34px;
      font-size: 28px;
    }

    .move-column {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .move-summary {
      padding: 14px;
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

    .move-asset-select {
      width: 100%;
      min-width: 0;
    }

    .move-primary-cta {
      width: 100%;
      min-width: 0;
    }
  }
</style>
