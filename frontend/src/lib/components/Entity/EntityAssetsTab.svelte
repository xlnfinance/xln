<script lang="ts">
  import type { Env, EnvSnapshot } from '@xln/runtime/xln-api';
  import type { Writable } from 'svelte/store';
  import type { EntityReplica, Tab } from '$lib/types/ui';
  import AssetFaucetCard from './AssetFaucetCard.svelte';
  import AssetLedgerTable from './AssetLedgerTable.svelte';
  import AssetWalletMeta from './AssetWalletMeta.svelte';
  import DebtPanel from './DebtPanel.svelte';
  import MoveWorkspace from './MoveWorkspace.svelte';
  import PendingBatchNotice from './PendingBatchNotice.svelte';
  import SettlementPanel from './SettlementPanel.svelte';
  import type { AssetLedgerRow, AssetLedgerTotals, ExternalWalletSnapshotSource } from './asset-ledger';
  import type { MoveEndpoint } from './move-routes';

  export let replica: EntityReplica;
  export let tab: Tab;
  export let activeEnv: Env | EnvSnapshot;
  export let activeLiveEnv: Env | null = null;
  export let activeIsLive = false;
  export let envRevision = '';
  export let liveEnvResolver: (() => Env | null) | null = null;
  export let liveEnvStore: Writable<Env | null> | null = null;
  export let currentSignerId = '';
  export let currentExternalEoaValue = '';
  export let copiedMetaField = '';
  export let externalWalletSnapshotSource: ExternalWalletSnapshotSource | null = null;
  export let externalTokensLoading = false;
  export let assetFaucetSubmitting = false;
  export let assetLedgerRows: AssetLedgerRow[] = [];
  export let assetLedgerTotals: AssetLedgerTotals | null = null;
  export let assetLedgerGrandTotal = 0;
  export let faucetAssetSymbol = 'USDC';
  export let faucetSupportsReserve = false;
  export let canShowAccountFaucet = false;
  export let openOutgoingDebtSummary: { count: number; usdTotal: number; byToken: Map<number, bigint> };
  export let pendingBatchCount = 0;
  export let pendingBatchMode: 'draft' | 'sent' | null = null;
  export let pendingBatchReserveIssueText: string | null = null;
  export let pendingBatchPreview: Array<{ key: string; title: string; subtitle: string }> = [];
  export let pendingBatchSubmitting = false;
  export let hasSentBatch = false;
  export let canBroadcastPendingBatch = false;
  export let assetWorkspaceTab: 'move' | 'history' = 'move';

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
  export let moveAllowanceRouteEnabled = false;
  export let moveAllowanceSatisfied = false;
  export let moveAllowanceLoading = false;
  export let moveAllowanceStatusLabel = '';
  export let moveAllowanceAmount = '';
  export let moveAllowanceSubmittingMode: 'amount' | 'max' | null = null;
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
  type MoveDisplayBalances = Record<MoveEndpoint, bigint>;
  type MoveNodeAction = (
    node: HTMLButtonElement,
    params: { side: 'from' | 'to'; endpoint: MoveEndpoint },
  ) => { update?: (next: { side: 'from' | 'to'; endpoint: MoveEndpoint }) => void; destroy?: () => void } | void;

  export let moveUiState: {
    displayBalances: MoveDisplayBalances;
    displayDecimals: number;
    sourceAvailableBalance: bigint;
  };
  export let setMoveSource: (endpoint: MoveEndpoint) => void;
  export let setMoveTarget: (endpoint: MoveEndpoint) => void;
  export let beginMoveDrag: (endpoint: MoveEndpoint, event: PointerEvent | MouseEvent) => void;
  export let getMoveNodeAnchor: (side: 'from' | 'to', endpoint: MoveEndpoint) => { x: number; y: number } | null;
  export let buildMoveArrowPath: (
    start: { x: number; y: number } | null,
    end: { x: number; y: number } | null,
  ) => string;
  export let moveRouteSteps: (from: MoveEndpoint, to: MoveEndpoint) => string[];
  export let canAddMoveToExistingBatch: () => boolean;
  export let submitMovePrimaryAction: () => Promise<void>;
  export let approveMoveExternalAllowance: (mode: 'amount' | 'max') => Promise<void>;
  export let handleMoveAllowanceAmountInput: (nextValue: string) => void;
  export let handleMoveSourceAccountChange: (event: CustomEvent<{ value?: string }>) => void;
  export let handleMoveReserveRecipientChange: (event: CustomEvent<{ value?: string }>) => void;
  export let handleMoveTargetEntityChange: (event: CustomEvent<{ value?: string }>) => void;
  export let handleMoveTargetHubChange: (event: CustomEvent<{ value?: string }>) => void;
  export let moveNodeAction: MoveNodeAction;
  export let moveEntityOptions: string[] = [];
  export let moveHubEntityOptions: string[] = [];
  export let moveSourceAccountOptions: string[] = [];
  export let resolveSelfEntityId: () => string;
  export let moveAssetOptions: Array<{ symbol: string; tokenId?: number; decimals?: number }> = [];
  export let moveEndpointLabels: Record<string, string>;
  export let moveEndpoints: MoveEndpoint[] = [];
  export let formatAmount: (amount: bigint, decimals?: number) => string;
  export let formatApproxUsd: (value: number) => string;
  export let getMovePrimaryActionLabel: () => string;
  export let setMoveVisualRoot: (node: HTMLDivElement | null) => void;
  export let handleMoveWorkspaceError: (error: unknown) => void;
  export let refreshBalances: () => void | Promise<void>;
  export let submitAssetFaucet: (target: 'account' | 'external' | 'reserve') => void | Promise<void>;
  export let copyMetaValue: (value: string, field: 'entity' | 'external') => void | Promise<void>;
  export let shortHash: (value: unknown) => string;
  export let enforceOutstandingDebt: (detail: any) => void | Promise<void>;
  export let openAssetMoveWorkspace: () => void;
  export let openAssetHistoryWorkspace: () => void;
  export let clearPendingBatch: () => void | Promise<void>;
  export let rebroadcastPendingBatch: () => void | Promise<void>;
  export let broadcastPendingBatch: () => void | Promise<void>;

  $: safeAssetLedgerTotals = assetLedgerTotals ?? { externalUsd: 0, reserveUsd: 0, accountUsd: 0 };
</script>

<div class="tab-header-row">
  <div class="asset-title-block">
    <h4 class="section-head">Assets</h4>
    <p class="muted asset-ledger-note">External, reserve, and account balances.</p>
  </div>
  <div class="header-actions">
    <button
      class="btn-refresh-small"
      data-testid="asset-ledger-refresh"
      on:click={() => refreshBalances()}
      disabled={externalTokensLoading || assetFaucetSubmitting}
    >
      {externalTokensLoading || assetFaucetSubmitting ? '...' : 'Refresh'}
    </button>
  </div>
</div>

<AssetFaucetCard
  rows={assetLedgerRows}
  bind:selectedSymbol={faucetAssetSymbol}
  supportsReserve={faucetSupportsReserve}
  {canShowAccountFaucet}
  submitting={assetFaucetSubmitting}
  submitFaucet={submitAssetFaucet}
/>
<AssetWalletMeta
  externalEoaValue={currentExternalEoaValue}
  copied={copiedMetaField === 'external'}
  snapshotSource={externalWalletSnapshotSource}
  copyExternal={() => copyMetaValue(currentExternalEoaValue, 'external')}
  {shortHash}
/>

<AssetLedgerTable
  rows={assetLedgerRows}
  totals={safeAssetLedgerTotals}
  grandTotal={assetLedgerGrandTotal}
  loading={externalTokensLoading}
  {formatAmount}
  {formatApproxUsd}
/>

<DebtPanel
  entityId={replica.state?.entityId || tab.entityId}
  signerId={currentSignerId}
  sourceEnv={activeLiveEnv ?? activeEnv}
  entityStateOverride={replica.state ?? null}
  sourceRevision={envRevision}
  sourceEnvResolver={liveEnvResolver}
  sourceEnvStore={liveEnvStore}
  canEnforce={activeIsLive}
  on:enforce={(event) => enforceOutstandingDebt(event.detail)}
/>

<section class="asset-action-card">
  <PendingBatchNotice
    debtCount={openOutgoingDebtSummary.count}
    debtUsdLabel={formatApproxUsd(openOutgoingDebtSummary.usdTotal)}
    debtNote="Reserve spends sweep debts first. Enforce or refill before broadcasting risky reserve moves."
    pendingCount={pendingBatchCount}
    pendingMode={pendingBatchMode}
    reserveIssueText={pendingBatchReserveIssueText}
    previewItems={pendingBatchPreview}
    submitting={pendingBatchSubmitting}
    {hasSentBatch}
    canBroadcast={canBroadcastPendingBatch}
    openHistory={openAssetHistoryWorkspace}
    clearBatch={clearPendingBatch}
    rebroadcastBatch={rebroadcastPendingBatch}
    broadcastBatch={broadcastPendingBatch}
  />

  <nav class="account-workspace-tabs asset-workspace-tabs" aria-label="Asset workspace">
    <button class="account-workspace-tab" data-testid="asset-tab-move" class:active={assetWorkspaceTab === 'move'} on:click={openAssetMoveWorkspace}>
      <span>Move</span>
    </button>
    <button class="account-workspace-tab" data-testid="asset-tab-history" class:active={assetWorkspaceTab === 'history'} on:click={openAssetHistoryWorkspace}>
      <span>History</span>
    </button>
  </nav>

  {#if assetWorkspaceTab === 'move'}
    <MoveWorkspace
      mode="assets"
      bind:moveAmount
      bind:moveAssetSymbol
      bind:moveFromEndpoint
      bind:moveToEndpoint
      bind:moveExternalRecipient
      bind:moveReserveRecipientEntityId
      bind:moveSourceAccountId
      bind:moveTargetEntityId
      bind:moveTargetHubEntityId
      {moveExecuting}
      {moveProgressLabel}
      {moveDraftError}
      {moveBroadcastError}
      moveRequiresExplicitAllowance={moveAllowanceRouteEnabled}
      {moveAllowanceSatisfied}
      {moveAllowanceLoading}
      {moveAllowanceStatusLabel}
      {moveAllowanceAmount}
      {moveAllowanceSubmittingMode}
      {moveSelectedSource}
      {moveSelectedTarget}
      {moveDragSource}
      {moveDragHoverTarget}
      {moveLineReady}
      {moveCommittedLineReady}
      {moveNodeLayoutVersion}
      {moveNeedsReserveRecipient}
      {moveNeedsExternalRecipient}
      {isMoveRouteSupported}
      moveDisplayBalances={moveUiState.displayBalances}
      moveDisplayDecimals={moveUiState.displayDecimals}
      moveSourceAvailableBalance={moveUiState.sourceAvailableBalance}
      {setMoveSource}
      {setMoveTarget}
      {beginMoveDrag}
      {getMoveNodeAnchor}
      {buildMoveArrowPath}
      {moveRouteSteps}
      {canAddMoveToExistingBatch}
      {submitMovePrimaryAction}
      approveMoveAllowanceAmount={() => approveMoveExternalAllowance('amount')}
      approveMoveAllowanceMax={() => approveMoveExternalAllowance('max')}
      {handleMoveAllowanceAmountInput}
      {handleMoveSourceAccountChange}
      {handleMoveReserveRecipientChange}
      {handleMoveTargetEntityChange}
      {handleMoveTargetHubChange}
      {moveNodeAction}
      {moveEntityOptions}
      {moveHubEntityOptions}
      {moveSourceAccountOptions}
      reserveRecipientPreferredId={resolveSelfEntityId()}
      targetEntityPreferredId={resolveSelfEntityId()}
      entityId={replica?.state?.entityId || tab.entityId}
      {moveAssetOptions}
      {moveEndpointLabels}
      {moveEndpoints}
      {formatAmount}
      movePrimaryActionLabel={getMovePrimaryActionLabel()}
      onMoveVisualRoot={setMoveVisualRoot}
      toastMoveError={handleMoveWorkspaceError}
    />
  {:else}
    <SettlementPanel
      entityId={replica.state?.entityId || tab.entityId}
      {replica}
      env={activeEnv}
      isLive={activeIsLive}
      historyOnly={true}
    />
  {/if}
</section>

<style>
  .tab-header-row {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    align-items: flex-start;
    margin-bottom: 14px;
  }

  .asset-title-block {
    min-width: 0;
  }

  .section-head {
    margin: 0 0 12px;
    color: #f5f5f5;
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 0.01em;
  }

  .muted {
    color: #52525b;
    line-height: 1.5;
    margin: 0 0 12px;
  }

  .asset-ledger-note {
    margin: 2px 0 0;
  }

  .header-actions {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .btn-refresh-small {
    min-height: 34px;
    padding: 0 12px;
    border-radius: 9px;
    border: 1px solid #303038;
    background: #151519;
    color: #e4e4e7;
    font-size: 12px;
    font-weight: 700;
    cursor: pointer;
  }

  .btn-refresh-small:disabled {
    opacity: 0.55;
    cursor: wait;
  }

  .asset-action-card {
    margin-top: 12px;
    padding: 14px;
    border-radius: 14px;
    border: 1px solid #27272a;
    background: #101114;
  }

  .account-workspace-tabs {
    display: flex;
    gap: 4px;
    margin-top: var(--space-3, 12px);
    padding: 0 0 2px;
    border: none;
    border-bottom: 1px solid color-mix(in srgb, var(--theme-card-border, var(--theme-border, #27272a)) 56%, transparent);
    border-radius: 0;
    background: transparent;
    overflow-x: auto;
  }

  .account-workspace-tab {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    min-height: 40px;
    padding: 8px 12px;
    border: 1px solid transparent;
    border-radius: 10px 10px 0 0;
    background: transparent;
    color: var(--theme-text-secondary, #a1a1aa);
    font-size: 12px;
    font-weight: 650;
    cursor: pointer;
  }

  .account-workspace-tab.active {
    color: var(--theme-text-primary, #e4e4e7);
    border-color: color-mix(in srgb, var(--theme-card-border, var(--theme-border, #27272a)) 50%, transparent);
    border-bottom-color: transparent;
    background: color-mix(in srgb, var(--theme-card-bg, var(--theme-surface, #18181b)) 94%, transparent);
  }

  .asset-workspace-tabs {
    margin: 0 0 12px;
  }

  @media (max-width: 760px) {
    .tab-header-row {
      flex-direction: column;
      align-items: stretch;
    }

    .header-actions,
    .btn-refresh-small {
      width: 100%;
    }

    .asset-action-card {
      padding: 12px;
    }
  }
</style>
