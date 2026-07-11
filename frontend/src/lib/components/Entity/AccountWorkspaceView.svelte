<script lang="ts">
  import type { Env, EnvSnapshot, Profile as GossipProfile, RuntimeInput } from '@xln/runtime/xln-api';
  import type { ComponentType } from 'svelte';
  import { ArrowDownLeft, ArrowUpRight, Activity, Banknote, Landmark, PlusCircle, Repeat, Settings as SettingsIcon, SlidersHorizontal } from 'lucide-svelte';
  import type { EntityReplica, Tab } from '$lib/types/ui';
  import AccountAppearancePanel from './AccountAppearancePanel.svelte';
  import AccountConfigurePanel from './AccountConfigurePanel.svelte';
  import AccountDropdown from './AccountDropdown.svelte';
  import AccountList from './AccountList.svelte';
  import AccountOpenPanel from './AccountOpenPanel.svelte';
  import AccountWorkspaceRail from './AccountWorkspaceRail.svelte';
  import EntityActivityPanel from './EntityActivityPanel.svelte';
  import LendingPanel from './LendingPanel.svelte';
  import LiveRequiredState from './LiveRequiredState.svelte';
  import MoveWorkspace from './MoveWorkspace.svelte';
  import PaymentPanel from './PaymentPanel.svelte';
  import PendingBatchNotice from './PendingBatchNotice.svelte';
  import ReceivePanel from './ReceivePanel.svelte';
  import SettlementPanel from './SettlementPanel.svelte';
  import SwapPanel from './SwapPanel.svelte';
  import type { SwapPanelRuntimeView } from './swap-panel-helpers';
  import type { DisputedAccountView, CrossJTargetDisputeRisk } from './account-dispute-view';
  import type { EntityActivityAccountOption, EntityActivityRow } from './entity-activity';
  import type { AccountWorkspaceTab, ConfigureWorkspaceTab } from './entity-panel-routing';
  import {
    emptyHubDiscoveryProjection,
    type HubDiscoveryProjection,
  } from './hub-discovery-profile';
  import {
    emptyPaymentPanelView,
    type PaymentPanelView,
  } from './payment-panel-view';
  import type { MoveEndpoint } from './move-routes';

  type IconTabConfig<T extends string> = {
    id: T;
    icon: ComponentType;
    label: string;
  };

  type PendingBatchPreviewItem = {
    key: string;
    title: string;
    subtitle: string;
  };

  type OpenOutgoingDebtSummary = {
    count: number;
    usdTotal: number;
  };

  type MoveDisplayBalances = Record<MoveEndpoint, bigint>;

  type MoveNodeAction = (
    node: HTMLButtonElement,
    params: { side: 'from' | 'to'; endpoint: MoveEndpoint },
  ) => { update?: (next: { side: 'from' | 'to'; endpoint: MoveEndpoint }) => void; destroy?: () => void } | void;

  type MoveUiState = {
    displayBalances: MoveDisplayBalances;
    displayDecimals: number;
    sourceAvailableBalance: bigint;
  };

  type ConfigureTokenOption = {
    id: number;
    symbol: string;
  };

  export let replica: EntityReplica | null = null;
  export let tab: Tab;
  export let activeEnv: Env | EnvSnapshot | null = null;
  export let liveRuntimeEnv: Env | null = null;
  export let activeIsLive = false;
  export let actionRuntimeEnv: Env | null = null;
  export let runtimeHeight: number = 0;
  export let entityNames: Map<string, string> = new Map();
  export let profileByEntityId: Map<string, GossipProfile> = new Map();
  export let isDevnet = false;
  export let hubDiscoveryProjection: HubDiscoveryProjection = emptyHubDiscoveryProjection();
  export let canOpenAccounts = true;
  export let paymentView: PaymentPanelView = emptyPaymentPanelView();
  export let swapRuntimeView: SwapPanelRuntimeView | null = null;
  export let accountIds: string[] = [];
  export let workspaceAccountIds: string[] = [];
  export let workspaceAccountId = '';
  export let selectedAccountId: string | null = null;
  export let pendingOffchainFaucetKeys: Set<string> = new Set();
  export let accountWorkspaceTab: AccountWorkspaceTab = 'open';
  export let configureWorkspaceTab: ConfigureWorkspaceTab = 'extend-credit';
  export let configureTokenId = 1;
  export let configureTokenOptions: ConfigureTokenOption[] = [];
  export let unsafeCrossJTargetDisputeAccepted = false;
  export let openOutgoingDebtSummary: OpenOutgoingDebtSummary = { count: 0, usdTotal: 0 };
  export let pendingBatchCount = 0;
  export let pendingBatchMode: 'draft' | 'sent' | null = null;
  export let pendingBatchReserveIssueText: string | null = null;
  export let pendingBatchPreview: PendingBatchPreviewItem[] = [];
  export let pendingBatchSubmitting = false;
  export let hasSentBatch = false;
  export let canBroadcastPendingBatch = false;
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
  export let moveUiState: MoveUiState = {
    displayBalances: { external: 0n, reserve: 0n, account: 0n },
    displayDecimals: 18,
    sourceAvailableBalance: 0n,
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
  export let handleMoveAllowanceAmountInput: (value: string) => void;
  export let handleMoveSourceAccountChange: (event: CustomEvent<{ value?: string }>) => void;
  export let handleMoveReserveRecipientChange: (event: CustomEvent<{ value?: string }>) => void;
  export let handleMoveTargetEntityChange: (event: CustomEvent<{ value?: string }>) => void;
  export let handleMoveTargetHubChange: (event: CustomEvent<{ value?: string }>) => void;
  export let moveNodeAction: MoveNodeAction;
  export let moveEntityOptions: string[] = [];
  export let moveHubEntityOptions: string[] = [];
  export let moveSourceAccountOptions: string[] = [];
  export let moveAssetOptions: Array<{ symbol: string }> = [];
  export let moveEndpointLabels: Record<MoveEndpoint, string>;
  export let moveEndpoints: MoveEndpoint[] = [];
  export let openAccountEntityId = '';
  export let openAccountEntityOptions: string[] = [];
  export let disputedAccounts: DisputedAccountView[] = [];
  export let entityActivityRows: EntityActivityRow[] = [];
  export let filteredEntityActivityRows: EntityActivityRow[] = [];
  export let entityActivityAccounts: EntityActivityAccountOption[] = [];
  export let entityActivityAccountFilter = 'all';
  export let handleAccountSelect: (event: CustomEvent) => void;
  export let handleAccountFaucet: (event: CustomEvent) => void;
  export let handleQuickSettleApprove: (event: CustomEvent) => void;
  export let openAccountHistoryWorkspace: () => void;
  export let openAccountMoveWorkspace: () => void;
  export let clearPendingBatch: () => Promise<void>;
  export let rebroadcastPendingBatch: () => Promise<void>;
  export let broadcastPendingBatch: () => Promise<void>;
  export let handleWorkspaceAccountChange: (event: CustomEvent<{ value?: string }>) => void;

  $: profiles = Array.from(profileByEntityId.values());
  export let getCrossJTargetDisputeRisk: (counterpartyEntityId: string) => CrossJTargetDisputeRisk | null;
  export let formatCrossJTargetDisputeRisk: (risk: CrossJTargetDisputeRisk) => string;
  export let confirmAndQueueDisputeFinalize: (counterpartyEntityId: string, reason: string) => void | Promise<void>;
  export let confirmAndQueueDisputeStart: (
    counterpartyEntityId: string,
    reason: string,
    options?: Record<string, unknown>,
  ) => void | Promise<void>;
  export let confirmAndQueueDisputePrepare: (counterpartyEntityId: string, reason: string) => void | Promise<void>;
  export let addTokenToAccount: () => void | Promise<void>;
  export let handleOpenAccountTargetChange: (event: CustomEvent<{ value?: string }>) => void;
  export let openAccountWithFullId: (targetEntityId: string) => void | Promise<void>;
  export let submitRuntimeInput: (input: RuntimeInput) => Promise<unknown> | unknown;
  export let openDisputedAccount: (counterpartyEntityId: string) => void;
  export let reopenDisputedAccount: (counterpartyEntityId: string) => void | Promise<void>;
  export let resolveSelfEntityId: () => string;
  export let formatAmount: (amount: bigint, decimals?: number) => string;
  export let formatApproxUsd: (value: number) => string;
  export let getMovePrimaryActionLabel: () => string;
  export let onMoveVisualRoot: (node: HTMLDivElement | null) => void;
  export let handleMoveWorkspaceError: (error: unknown) => void;

  const accountWorkspaceTabs: IconTabConfig<AccountWorkspaceTab>[] = [
    { id: 'open', icon: PlusCircle, label: 'Open Account' },
    { id: 'send', icon: ArrowUpRight, label: 'Pay' },
    { id: 'receive', icon: ArrowDownLeft, label: 'Receive' },
    { id: 'swap', icon: Repeat, label: 'Swap' },
    { id: 'move', icon: Landmark, label: 'Move' },
    { id: 'lending', icon: Banknote, label: 'Lending' },
    { id: 'history', icon: Activity, label: 'History' },
    { id: 'configure', icon: SettingsIcon, label: 'Manage' },
    { id: 'activity', icon: Activity, label: 'Activity' },
    { id: 'appearance', icon: SlidersHorizontal, label: 'Appearance' },
  ];
  const accountWorkspacePrimaryTabIds: AccountWorkspaceTab[] = ['open', 'send', 'receive', 'swap', 'move', 'lending'];

  $: hasWorkspaceAccounts = workspaceAccountIds.length > 0;
  $: visibleAccountWorkspaceTabs = hasWorkspaceAccounts
    ? accountWorkspaceTabs
    : accountWorkspaceTabs.filter((tabConfig) => tabConfig.id === 'open');
  $: if (!hasWorkspaceAccounts && accountWorkspaceTab !== 'open') {
    accountWorkspaceTab = 'open';
  }

  function selectAccountWorkspaceTab(next: string): void {
    const target = next as AccountWorkspaceTab;
    if (target === 'move') {
      openAccountMoveWorkspace();
      return;
    }
    if (target === 'history') {
      openAccountHistoryWorkspace();
      return;
    }
    accountWorkspaceTab = target;
  }
</script>

{#if accountIds.length > 5}
  <div class="accounts-selector-row">
    <AccountDropdown
      {replica}
      {selectedAccountId}
      {entityNames}
      on:accountSelect={handleAccountSelect}
    />
  </div>
{/if}

<AccountList
  {replica}
  {selectedAccountId}
  pendingFaucetKeys={pendingOffchainFaucetKeys}
  {runtimeHeight}
  {entityNames}
  {profileByEntityId}
  {isDevnet}
  on:select={handleAccountSelect}
  on:faucet={handleAccountFaucet}
  on:settleApprove={handleQuickSettleApprove}
/>

<PendingBatchNotice
  debtCount={openOutgoingDebtSummary.count}
  debtUsdLabel={formatApproxUsd(openOutgoingDebtSummary.usdTotal)}
  debtNote="Reserve spends sweep debts first. Sign & Broadcast stays locked while the draft still overspends after debt collection."
  pendingCount={pendingBatchCount}
  pendingMode={pendingBatchMode}
  reserveIssueText={pendingBatchReserveIssueText}
  previewItems={pendingBatchPreview}
  submitting={pendingBatchSubmitting}
  {hasSentBatch}
  canBroadcast={canBroadcastPendingBatch}
  openHistory={openAccountHistoryWorkspace}
  clearBatch={clearPendingBatch}
  rebroadcastBatch={rebroadcastPendingBatch}
  broadcastBatch={broadcastPendingBatch}
/>

<AccountWorkspaceRail
  tabs={visibleAccountWorkspaceTabs}
  activeTab={accountWorkspaceTab}
  primaryTabIds={accountWorkspacePrimaryTabIds}
  ariaLabel="Account workspace"
  on:select={(event) => selectAccountWorkspaceTab(event.detail)}
/>

<section class="account-workspace-content">
  {#if accountWorkspaceTab === 'send'}
    {#if liveRuntimeEnv && activeIsLive}
      <PaymentPanel
        entityId={replica?.state?.entityId || tab.entityId}
        {paymentView}
        actionRuntimeEnv={liveRuntimeEnv}
        isLive={activeIsLive}
        signerId={tab.signerId || null}
        {submitRuntimeInput}
      />
    {:else}
      <LiveRequiredState message="Payments are only available in LIVE mode." />
    {/if}

  {:else if accountWorkspaceTab === 'receive'}
    <ReceivePanel entityId={replica?.state?.entityId || tab.entityId} />

  {:else if accountWorkspaceTab === 'swap'}
    {#if activeEnv || swapRuntimeView}
      <SwapPanel
        {replica}
        {tab}
        env={activeIsLive ? (liveRuntimeEnv ?? actionRuntimeEnv) : null}
        isLive={activeIsLive}
        runtimeView={swapRuntimeView}
      />
    {:else}
      <LiveRequiredState message="Swap projection is not available yet." />
    {/if}

  {:else if accountWorkspaceTab === 'move'}
    <MoveWorkspace
      mode="accounts"
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
      moveAllowanceSatisfied={moveAllowanceSatisfied}
      moveAllowanceLoading={moveAllowanceLoading}
      moveAllowanceStatusLabel={moveAllowanceStatusLabel}
      moveAllowanceAmount={moveAllowanceAmount}
      moveAllowanceSubmittingMode={moveAllowanceSubmittingMode}
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
      {profiles}
      reserveRecipientPreferredId={resolveSelfEntityId()}
      targetEntityPreferredId={resolveSelfEntityId()}
      entityId={replica?.state?.entityId || tab.entityId}
      {moveAssetOptions}
      {moveEndpointLabels}
      {moveEndpoints}
      {formatAmount}
      movePrimaryActionLabel={getMovePrimaryActionLabel()}
      {onMoveVisualRoot}
      toastMoveError={handleMoveWorkspaceError}
    />

  {:else if accountWorkspaceTab === 'lending'}
    <LendingPanel
      entityId={replica?.state?.entityId || tab.entityId}
      {replica}
      accountIds={workspaceAccountIds}
      {entityNames}
      isLive={activeIsLive}
      {submitRuntimeInput}
    />

  {:else if accountWorkspaceTab === 'history'}
    <SettlementPanel
      entityId={replica?.state?.entityId || tab.entityId}
      {replica}
      env={activeEnv}
      isLive={activeIsLive}
      historyOnly={true}
      {profiles}
    />

  {:else if accountWorkspaceTab === 'configure'}
    <AccountConfigurePanel
      {replica}
      {tab}
      {activeIsLive}
      {liveRuntimeEnv}
      {workspaceAccountId}
      {workspaceAccountIds}
      {entityNames}
      {profileByEntityId}
      bind:configureWorkspaceTab
      bind:configureTokenId
      {configureTokenOptions}
      bind:unsafeCrossJTargetDisputeAccepted
      {handleWorkspaceAccountChange}
      selectConfigureTab={(nextTab) => configureWorkspaceTab = nextTab}
      {getCrossJTargetDisputeRisk}
      {formatCrossJTargetDisputeRisk}
      {confirmAndQueueDisputeFinalize}
      {confirmAndQueueDisputeStart}
      {confirmAndQueueDisputePrepare}
      {addTokenToAccount}
      {submitRuntimeInput}
    />

  {:else if accountWorkspaceTab === 'appearance'}
    <AccountAppearancePanel />

  {:else if accountWorkspaceTab === 'open'}
    <AccountOpenPanel
      {replica}
      {tab}
      {activeIsLive}
      {actionRuntimeEnv}
      {hubDiscoveryProjection}
      {canOpenAccounts}
      bind:openAccountEntityId
      {openAccountEntityOptions}
      {profiles}
      {disputedAccounts}
      {handleOpenAccountTargetChange}
      {openAccountWithFullId}
      {submitRuntimeInput}
      {openDisputedAccount}
      {reopenDisputedAccount}
    />

  {:else if accountWorkspaceTab === 'activity'}
    <EntityActivityPanel
      rows={entityActivityRows}
      filteredRows={filteredEntityActivityRows}
      accountOptions={entityActivityAccounts}
      accountFilter={entityActivityAccountFilter}
      on:filterChange={(event) => entityActivityAccountFilter = event.detail.accountFilter}
    />
  {/if}
</section>

<style>
  .accounts-selector-row {
    margin-bottom: 10px;
    padding: 10px;
    border: 1px solid color-mix(in srgb, var(--theme-card-border, var(--theme-border, #27272a)) 64%, transparent);
    border-radius: 10px;
    background: color-mix(in srgb, var(--theme-card-bg, var(--theme-surface, #18181b)) 94%, transparent);
    box-shadow: 0 8px 18px color-mix(in srgb, var(--theme-background, #09090b) 4%, transparent);
  }

  .accounts-selector-row :global(.dropdown-trigger) {
    width: 100%;
    min-height: 42px;
    border: 1px solid color-mix(in srgb, var(--theme-input-border, var(--theme-card-border, #27272a)) 86%, transparent);
    border-radius: 8px;
    background: color-mix(in srgb, var(--theme-input-bg, #09090b) 96%, transparent);
    color: var(--theme-text-primary, #e4e4e7);
  }

  .accounts-selector-row :global(.trigger-text) {
    font-size: 13px;
  }

  .account-workspace-content {
    margin-top: var(--space-3);
  }

  @media (max-width: 900px) {
    .accounts-selector-row,
    .account-workspace-content {
      width: 100%;
      max-width: 100%;
      min-width: 0;
      box-sizing: border-box;
    }
  }
</style>
