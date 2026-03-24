<script lang="ts">
  import { onDestroy } from 'svelte';
  import EntityInput from '../shared/EntityInput.svelte';

  type MoveEndpoint = 'external' | 'reserve' | 'account';
  type MoveEntityInputEvent = CustomEvent<{ value?: string }>;
  type MoveNodeAction = (
    node: HTMLButtonElement,
    params: { side: 'from' | 'to'; endpoint: MoveEndpoint },
  ) => { update?: (next: { side: 'from' | 'to'; endpoint: MoveEndpoint }) => void; destroy?: () => void } | void;

  export let mode: 'assets' | 'accounts' = 'assets';
  export let contacts: Array<{ name: string; entityId: string }> = [];
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
  export let getMoveDisplayBalance: (endpoint: MoveEndpoint) => bigint;
  export let getMoveDisplayDecimals: () => number;
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
  export let addMoveToExistingBatch: () => Promise<void>;
  export let submitMovePrimaryAction: () => Promise<void>;
  export let movePrimaryActionLabel = 'Add to Batch';
  export let handleMoveSourceAccountChange: (event: MoveEntityInputEvent) => void;
  export let handleMoveReserveRecipientChange: (event: MoveEntityInputEvent) => void;
  export let handleMoveTargetEntityChange: (event: MoveEntityInputEvent) => void;
  export let handleMoveTargetHubChange: (event: MoveEntityInputEvent) => void;
  export let moveNodeAction: MoveNodeAction;
  export let moveEntityOptions: string[] = [];
  export let moveHubEntityOptions: string[] = [];
  export let workspaceAccountIds: string[] = [];
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

  $: onMoveVisualRoot(moveVisualRoot);

  onDestroy(() => {
    onMoveVisualRoot(null);
  });
</script>

<div class="move-route-builder" data-testid={`move-workspace-${mode}`}>
  <div class="move-topline">
    <div class="asset-amount-shell move-amount-shell">
      <input type="text" bind:value={moveAmount} placeholder="0.00" data-testid="move-amount" />
      <div class="asset-inline-controls">
        <button
          type="button"
          class="asset-max-hint text-link"
          on:click={fillMoveMax}
          disabled={getMoveDisplayBalance(moveFromEndpoint) <= 0n}
        >
          {formatInlineFillAmount(getMoveDisplayBalance(moveFromEndpoint), getMoveDisplayDecimals())}
        </button>
        <select class="asset-token-select-inline compact move-token-select" bind:value={moveAssetSymbol} data-testid="move-asset-symbol">
          {#each moveAssetOptions as token}
            <option value={token.symbol}>{token.symbol}</option>
          {/each}
        </select>
      </div>
    </div>
  </div>

  <div class="move-visual" bind:this={moveVisualRoot}>
    <div class="move-column">
      <div class="move-column-head">From</div>
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
          <span class="move-node-balance">
            {formatAmount(getMoveDisplayBalance(endpoint), getMoveDisplayDecimals())}
          </span>
        </button>
      {/each}
      {#if moveFromEndpoint === 'account'}
        <div class="move-account-slot" data-testid="move-source-account-field">
          <EntityInput
            testId="move-source-account-picker"
            label="From account"
            value={moveSourceAccountId}
            entities={workspaceAccountIds}
            {contacts}
            excludeId={entityId}
            placeholder="Select source account..."
            disabled={workspaceAccountIds.length === 0}
            on:change={handleMoveSourceAccountChange}
          />
        </div>
      {/if}
    </div>

    <div class="move-column">
      <div class="move-column-head">To</div>
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
          <span class="move-node-target-hint">Drop here</span>
        </button>
      {/each}
      {#if moveNeedsReserveRecipient(moveFromEndpoint, moveToEndpoint)}
        <div class="move-account-slot" data-testid="move-reserve-recipient-field">
          <EntityInput
            testId="move-reserve-recipient-picker"
            label="To reserve entity"
            value={moveReserveRecipientEntityId}
            entities={moveEntityOptions}
            {contacts}
            placeholder="Recipient entity..."
            preferredId={reserveRecipientPreferredId}
            on:change={handleMoveReserveRecipientChange}
          />
        </div>
      {/if}
      {#if moveToEndpoint === 'account'}
        <div class="move-account-slot" data-testid="move-target-entity-field">
          <EntityInput
            testId="move-target-entity-picker"
            label="Recipient"
            value={moveTargetEntityId}
            entities={moveEntityOptions}
            {contacts}
            placeholder="Recipient entity..."
            preferredId={targetEntityPreferredId}
            on:change={handleMoveTargetEntityChange}
          />
        </div>
        <div class="move-account-slot" data-testid="move-target-counterparty-field">
          <EntityInput
            testId="move-target-counterparty-picker"
            label="Counterparty"
            value={moveTargetHubEntityId}
            entities={moveHubEntityOptions}
            {contacts}
            placeholder="Counterparty entity..."
            on:change={handleMoveTargetHubChange}
          />
        </div>
      {/if}
      {#if moveNeedsExternalRecipient(moveFromEndpoint, moveToEndpoint)}
        <label class="asset-field move-account-slot" data-testid="move-external-recipient-field">
          <span class="asset-field-head">
            <span>Recipient EOA</span>
          </span>
          <input type="text" bind:value={moveExternalRecipient} placeholder="0x..." data-testid="move-external-recipient" />
        </label>
      {/if}
    </div>

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
    <div class="move-summary-pill">
      {moveEndpointLabels[moveFromEndpoint]} → {moveEndpointLabels[moveToEndpoint]}
    </div>
    <div class="move-summary-title">{moveRouteExecutionLabel(moveFromEndpoint, moveToEndpoint)}</div>
    <div class="move-summary-meta">{moveRouteMeta(moveFromEndpoint, moveToEndpoint)}</div>
    {#if moveProgressLabel}
      <div class="move-summary-progress">{moveProgressLabel}</div>
    {/if}
    {#if canAddMoveToExistingBatch() && !moveDraftError}
      <div class="move-summary-batch">Uses existing draft batch</div>
    {/if}
    {#if moveBroadcastError}
      <div class="move-summary-progress error">{moveBroadcastError}</div>
    {/if}
    <div class="move-steps">
      {#each moveRouteSteps(moveFromEndpoint, moveToEndpoint) as step}
        <span class="move-step-chip">{step}</span>
      {/each}
    </div>
  </div>

  <div class="asset-action-row">
    <button
      class="btn-table-action deposit"
      data-testid="move-confirm"
      on:click={async () => {
        try {
          await submitMovePrimaryAction();
        } catch (err) {
          toastMoveError(err);
        }
      }}
      disabled={!!moveBroadcastError}
    >
      {moveExecuting ? 'Working...' : movePrimaryActionLabel}
    </button>
  </div>
</div>

<style>
  .move-route-builder {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .move-topline {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 10px;
  }

  .move-amount-shell {
    min-height: 52px;
    border-radius: 14px;
  }

  .move-token-select {
    min-width: 92px;
  }

  .move-visual {
    position: relative;
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 14px;
    padding: 14px;
    border: 1px solid rgba(251, 191, 36, 0.16);
    border-radius: 14px;
    background: radial-gradient(circle at top, rgba(251, 191, 36, 0.05), transparent 55%), rgba(12, 10, 9, 0.88);
    overflow: visible;
  }

  .move-column {
    display: flex;
    flex-direction: column;
    gap: 8px;
    position: relative;
    z-index: 1;
    min-width: 0;
  }

  .move-account-slot {
    margin-top: 2px;
    min-width: 0;
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
    stroke: rgba(251, 191, 36, 0.96);
    stroke-width: 2.5;
    stroke-linecap: round;
    stroke-linejoin: round;
    fill: none;
    stroke-dasharray: 8 6;
    filter: drop-shadow(0 0 4px rgba(251, 191, 36, 0.28));
  }

  .move-drag-layer.committed path {
    stroke: rgba(245, 158, 11, 0.78);
    stroke-width: 2.25;
    stroke-dasharray: none;
    filter: drop-shadow(0 0 3px rgba(245, 158, 11, 0.2));
  }

  .move-column-head {
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #78716c;
  }

  .move-node {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 3px;
    min-height: 76px;
    width: 100%;
    min-width: 0;
    padding: 12px;
    border-radius: 12px;
    border: 1px solid rgba(120, 113, 108, 0.34);
    background: linear-gradient(180deg, rgba(28, 25, 23, 0.95), rgba(17, 15, 13, 0.95));
    color: #fafaf9;
    text-align: left;
    cursor: grab;
    transition: transform 0.16s ease, border-color 0.16s ease, box-shadow 0.16s ease, background 0.16s ease;
    user-select: none;
    touch-action: none;
  }

  .move-node:hover,
  .move-node.hover-target {
    border-color: rgba(251, 191, 36, 0.55);
    box-shadow: 0 0 0 1px rgba(251, 191, 36, 0.18), 0 10px 24px rgba(0, 0, 0, 0.25);
    transform: translateY(-1px);
  }

  .move-node.selected,
  .move-node.source-active,
  .move-node.target-active {
    border-color: rgba(251, 191, 36, 0.92);
    box-shadow: 0 0 0 2px rgba(251, 191, 36, 0.32), 0 16px 36px rgba(0, 0, 0, 0.3);
    transform: translateY(-1px);
  }

  .move-node.source-active {
    background: linear-gradient(180deg, rgba(66, 32, 6, 0.96), rgba(28, 25, 23, 0.96));
  }

  .move-node.target-active {
    background: linear-gradient(180deg, rgba(39, 32, 18, 0.96), rgba(28, 25, 23, 0.96));
  }

  .move-node.pending {
    border-color: rgba(250, 204, 21, 0.7);
    box-shadow: inset 0 0 0 1px rgba(250, 204, 21, 0.35);
  }

  .move-node.dragging {
    cursor: grabbing;
    opacity: 0.92;
  }

  .move-node.blocked {
    opacity: 0.45;
  }

  .move-node-label {
    font-size: 13px;
    font-weight: 700;
    color: #f5f5f4;
    white-space: nowrap;
  }

  .move-node-balance {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 16px;
    color: #fbbf24;
    white-space: nowrap;
  }

  .move-node-target-hint {
    font-size: 11px;
    color: #78716c;
    white-space: nowrap;
  }

  .move-summary {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 14px;
    border-radius: 12px;
    border: 1px solid rgba(120, 113, 108, 0.2);
    background: rgba(12, 10, 9, 0.55);
  }

  .move-summary-pill {
    align-self: flex-start;
    padding: 4px 8px;
    border-radius: 999px;
    background: rgba(251, 191, 36, 0.08);
    color: #fbbf24;
    font-size: 11px;
    font-weight: 700;
  }

  .move-summary-title {
    font-size: 14px;
    font-weight: 700;
    color: #fafaf9;
  }

  .move-summary-meta {
    font-size: 12px;
    color: #a8a29e;
  }

  .move-summary-progress {
    font-size: 12px;
    color: #fbbf24;
  }

  .move-summary-progress.error {
    color: #fca5a5;
  }

  .move-summary-batch {
    font-size: 12px;
    color: #fbbf24;
  }

  .move-steps {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .move-step-chip {
    padding: 6px 10px;
    border-radius: 999px;
    border: 1px solid rgba(120, 113, 108, 0.22);
    background: rgba(28, 25, 23, 0.72);
    color: #d6d3d1;
    font-size: 12px;
  }

  .asset-field {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .asset-field-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .asset-field span {
    font-size: 10px;
    color: #78716c;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .asset-amount-shell {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 48px;
    padding: 0 8px 0 12px;
    border: 1px solid #322821;
    border-radius: 12px;
    background: #110d0b;
  }

  .asset-amount-shell:focus-within {
    border-color: #fbbf24;
    box-shadow: 0 0 0 1px rgba(251, 191, 36, 0.12);
  }

  .asset-amount-shell input {
    flex: 1;
    min-width: 0;
    padding: 0;
    border: none;
    background: transparent;
    color: #f5f5f4;
    font-size: 15px;
  }

  .asset-amount-shell input:focus {
    outline: none;
  }

  .asset-inline-controls {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-left: auto;
    min-width: 0;
    flex: 0 0 auto;
    padding-left: 8px;
    align-self: stretch;
  }

  .asset-max-hint {
    border: none;
    background: transparent;
    padding: 0 2px;
    color: #8d857d;
    font-size: 11px;
    font-weight: 600;
    text-transform: none;
    letter-spacing: 0;
    cursor: pointer;
    white-space: nowrap;
    text-align: right;
    max-width: 72px;
    overflow: hidden;
    text-overflow: ellipsis;
    display: inline-flex;
    align-items: center;
    min-height: 32px;
  }

  .asset-max-hint.text-link {
    min-width: 0;
  }

  .asset-max-hint:hover:not(:disabled) {
    color: #f5f5f4;
  }

  .asset-max-hint:disabled {
    color: #57534e;
    cursor: default;
  }

  .asset-token-select-inline {
    min-height: 36px;
    min-width: 94px;
  }

  .asset-token-select-inline.compact {
    min-height: 36px;
    padding: 0 18px 0 2px;
    border-radius: 0;
    background: transparent;
    border: none;
    color: #e7e5e4;
    align-self: stretch;
  }

  .asset-action-row {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    margin-top: 14px;
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
  }

  .btn-table-action.deposit {
    background: linear-gradient(135deg, #16a34a, #15803d);
    color: #f0fdf4;
  }

  .btn-table-action.deposit:hover:not(:disabled) {
    background: linear-gradient(135deg, #22c55e, #16a34a);
  }

  .btn-table-action:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  @media (max-width: 900px) {
    .move-visual {
      grid-template-columns: 1fr;
    }
  }

  @media (max-width: 760px) {
    .move-visual {
      gap: 12px;
      overflow: hidden;
    }

    .move-column {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 8px;
      align-items: stretch;
    }

    .move-column-head,
    .move-account-slot {
      grid-column: 1 / -1;
    }

    .move-node {
      min-height: 84px;
      padding: 10px;
      border-radius: 10px;
    }

    .move-node-label,
    .move-node-balance,
    .move-node-target-hint {
      white-space: normal;
      line-height: 1.12;
    }

    .move-drag-layer {
      display: none;
    }
  }
</style>
