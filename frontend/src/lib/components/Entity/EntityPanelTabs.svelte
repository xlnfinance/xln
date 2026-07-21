<script lang="ts">
  import { replaceState } from '$app/navigation';
  import { createEventDispatcher } from 'svelte';
  import { onDestroy, onMount } from 'svelte';
  import type { ComponentType } from 'svelte';
  import { MaxUint256, Wallet as EthersWallet, hexlify, isAddress, parseEther, ZeroAddress } from 'ethers';
  import type {
    AccountMachine,
    Env,
    EnvSnapshot,
    JAdapter,
    JBatch,
    XLNModule,
    Profile as GossipProfile,
    RoutedEntityInput,
    RuntimeInput,
    EntityTx,
    RuntimeAdapterViewFrame,
  } from '@xln/runtime/xln-api';
  import { buildDebtEnforcementRuntimeInputFromProjection } from '@xln/runtime/protocol/payments/debt-enforcement';
  import { getDraftBatchReserveDelta } from '@xln/runtime/jurisdiction/batch';
  import type { Tab, EntityReplica } from '$lib/types/ui';
  import { getXLN, resolveConfiguredApiBase } from '../../stores/xlnStore';
  import { settings } from '../../stores/settingsStore';
  import { runtimes as runtimeHandles } from '../../stores/runtimeStore';
  import { activeRuntime, vaultOperations } from '$lib/stores/vaultStore';
  import { xlnFunctions, entityPositions, submitEntityInputs, submitRuntimeInput as submitRuntimeCommandInput } from '../../stores/xlnStore';
import { recordRuntimeIngressReceipt } from '../../stores/runtimeCommandBus';
import { runtimeControllerHandle } from '../../stores/runtimeControllerStore';
import { toasts } from '../../stores/toastStore';
import { errorLog } from '../../stores/errorLogStore';
import { getOpenAccountRebalancePolicyData } from '$lib/utils/onboardingPreferences';
import { prewarmCounterpartyProfiles } from '$lib/utils/p2pPrefetch';
import { requireSignerIdForEntity } from '$lib/utils/entityReplica';
import { registerDebugSurface } from '$lib/utils/debugSurface';
import { getEntityDisplayName, resolveEntityName } from '$lib/utils/entityNaming';
  import { entityAvatar as resolveEntityAvatar } from '$lib/utils/avatar';
  import { getJurisdictionBadgeInfo } from '$lib/utils/jurisdictionBadge';
  import { formatEntityId } from '$lib/utils/format';
  import { resetEverything } from '$lib/utils/resetEverything';
  import { Landmark, Users, Settings as SettingsIcon } from 'lucide-svelte';
  import AccountWorkspaceView from './AccountWorkspaceView.svelte';
  import EntityAssetsTab from './EntityAssetsTab.svelte';
  import EntityFocusedAccountView from './EntityFocusedAccountView.svelte';
  import EntityPanelChrome from './EntityPanelChrome.svelte';
  import EntityPanelHeroTabs from './EntityPanelHeroTabs.svelte';
  import EntitySelectionEmptyState from './EntitySelectionEmptyState.svelte';
  import EntitySettingsProjectionPanel from './EntitySettingsProjectionPanel.svelte';
  import { buildEntityConsensusSettingsView } from './entity-consensus-settings';
  import {
    importJMachineViaRuntime,
    type JMachineCreateDetail,
  } from '$lib/components/Jurisdiction/import-jmachine-runtime';
  import ContextSwitcher from './ContextSwitcher.svelte';
  import {
    OFFCHAIN_FAUCET_REQUEST_TIMEOUT_MS,
    faucetPendingKey,
    type FaucetApiResult,
    type PendingReserveFaucet,
    readJsonResponse,
    reconcilePendingReserveFaucets,
  } from './account-faucet';
  import {
    buildMoveArrowPath,
    buildMoveRouteSteps,
    canAddMoveRouteToDraft,
    getMovePrimaryActionLabel as getMovePrimaryActionLabelForRoute,
    getMoveRouteKey,
    isImmediateMoveExecutionRoute,
    isMoveRouteSupported,
    moveNeedsExternalRecipient,
    moveNeedsReserveRecipient,
    routeRequiresExplicitExternalAllowance,
    MOVE_ENDPOINT_LABEL,
    MOVE_ENDPOINTS,
    type MoveEndpoint,
  } from './move-routes';
  import {
    buildMoveAllowanceContextSignature,
    buildMoveAllowanceStatusLabel,
    getMoveRequiredAllowanceAmount,
    isMoveAllowanceSatisfied,
  } from './move-allowance';
  import {
    choosePreferredMoveAssetSymbol as choosePreferredMoveAssetSymbolFromBalances,
    computeMoveSourceAvailableBalanceForEndpoint,
    getMoveMaxAmountForEndpoint,
    getPreferredMoveSourceAccountId as getPreferredMoveSourceAccountIdFromBalances,
  } from './move-balance';
  import { getMoveValidationErrorForContext, type MoveValidationMode } from './move-validation';
  import { createMoveVisualController } from './move-visual-controller';
  import type { AssetLedgerRow, AssetLedgerTotals } from './asset-ledger';
  import {
    buildEntityPanelView,
    findLocalAccountByCounterparty,
    getActiveJurisdictionName,
    getCurrentEntityJurisdictionName,
    getRuntimeEnv,
    getRuntimeId,
    isSameJurisdictionEntity,
    isSameJurisdictionEntityInReplicas,
    isAccountLeftPerspective,
    isHubProfile,
    materializeAccountView,
    requireRuntimeEnv,
  } from './entity-panel-model';
  import {
    formatAddress,
    isPlaceholderEntityName,
    shortHash,
  } from './entity-panel-display';
  import {
    buildConfigureTokenOptions,
    buildMoveEntityOptions,
    buildMoveHubEntityOptions,
    buildMoveSourceAccountOptions,
    buildOpenAccountEntityOptions,
    isFullEntityId,
    normalizeWorkspaceAccountId,
    resolveConfigureTokenId,
    resolveMoveTargetHubEntityId,
  } from './entity-panel-options';
  import {
    assertExternalSnapshotCount,
    normalizeOptionalTokenId,
    readExternalWalletSnapshotSource,
    requireExternalSnapshotBigInt,
    type ExternalAllowanceRead,
    type ExternalWalletReadResult,
    type ExternalWalletSnapshotResponse,
    type ExternalWalletSnapshotSource,
  } from './external-wallet-snapshot';
  import {
    buildEntityPanelHashRouteFromState,
    canonicalizeEntityPanelRoute,
    getLocationHashParams,
    getLocationHashRoute,
    resolveEntityPanelDeepLinkFromLocation,
    type AccountWorkspaceTab,
    type AssetWorkspaceTab,
    type ConfigureWorkspaceTab,
    type SettingsSubview,
    type ViewTab,
  } from './entity-panel-routing';
  import {
    openDisputedAccountNavigation,
    returnToAccountsWorkspace,
    selectAccountNavigation,
    selectTopLevelTabNavigation,
    type AccountWorkspaceNavigationPatch,
  } from './account-workspace-navigation';
  import {
    buildEntityActivityAccounts,
    buildEntityActivityRows,
    filterEntityActivityRows,
  } from './entity-activity';
  import {
    emptyEntityWorkspaceRuntimeFrameContext,
    type EntityWorkspaceRuntimeFrameContext,
  } from './runtime-frame-context';
  import {
    emptyEntityWorkspaceEmbeddedRuntimeContext,
    type EntityWorkspaceEmbeddedRuntimeContext,
  } from './embedded-runtime-context';
  import {
    buildHubDiscoveryProjection,
    buildHubDiscoveryRemoteHubsFromRuntimes,
    buildDirectOpenAccountRuntimeInput,
    canSubmitHubOpenAccount,
    emptyHubDiscoveryProjection,
    getHubOpenAccountPermissionError,
    type HubDiscoveryProjection,
  } from './hub-discovery-profile';
  import {
    buildPaymentPanelView,
    buildPaymentPanelViewFromRuntimeView,
    emptyPaymentPanelView,
    type PaymentPanelView,
  } from './payment-panel-view';
  import {
    buildSwapPanelRuntimeView,
    type SwapPanelRuntimeView,
  } from './swap-panel-helpers';
  import {
    buildAccountPortfolioData,
    createEntityAssetValueFormatters,
    formatTokenInputAmount,
    parsePositiveAssetAmount,
    parseTokenAmountInput,
  } from './entity-asset-values';
  import {
    choosePreferredAssetSymbol,
    compareTokenSymbols,
    findAssetLedgerRowBySymbol as findAssetLedgerRowBySymbolInList,
    findExternalTokenBySymbol as findExternalTokenBySymbolInList,
    getExternalTokenIdentityKey,
    getFaucetReserveTokenMeta as getFaucetReserveTokenMetaFromRows,
    isReserveTransferToken,
    requireExternalTokenBySymbol as requireExternalTokenBySymbolInList,
    resolveReserveTokenMetaFromCatalog,
    resolveReserveTransferTokenBySymbol,
    sortExternalTokens,
    type ExternalToken,
    type ReserveTransferAsset,
  } from './entity-asset-catalog';
  import { requireTokenDecimals } from './token-metadata';
  import {
    buildOpenOutgoingDebtTotals,
    buildPendingBatchPreview,
    buildPendingBatchState,
    canBroadcastPendingBatch as canBroadcastPendingBatchState,
    formatBatchReserveIssue,
    getPendingBatchReserveIssue,
    pendingBatchEntityLabel,
  } from './pending-batch-preview';
  import {
    createPendingBatchActionRunner,
    enqueuePendingBatchAction,
  } from './pending-batch-actions';
  import {
    buildAddTokenToAccountTx,
    buildBroadcastTx,
    buildDisputeFinalizeTx,
    buildDisputeStartTx,
    buildExternalToReserveTx,
    buildMovePostSettleTxs,
    buildPrepareDisputeTx,
    buildReopenDisputedAccountTx,
    buildReserveToCollateralTx,
    buildReserveToExternalEoaTx,
    buildReserveToReserveTx,
    buildSettlementApproveTx,
    encodeExternalEoaAsEntity,
    type DisputeStartOptions,
    type MovePostSettleOp,
    type PendingAssetAutoC2R,
  } from './entity-action-txs';
  import {
    buildDisputedAccountViews,
    formatCrossJTargetDisputeRiskLabel,
    getCrossJTargetDisputeRiskForState,
    type CrossJTargetDisputeRisk,
  } from './account-dispute-view';
  export let tab: Tab;
  export let hideHeader: boolean = false;
  export let showJurisdiction: boolean = true;
  export let userModeHeader: boolean = false;
  export let selectedJurisdiction: string | null = null;
  export let allowHeaderAddRuntime: boolean = false;
  export let headerRuntimeAddLabel: string = '+ Add Runtime';
  import type { EntityOpenAction } from '$lib/view/utils/panelBridge';
  export let initialAction: EntityOpenAction | undefined = undefined;
  export let runtimeFrameContext: EntityWorkspaceRuntimeFrameContext = emptyEntityWorkspaceRuntimeFrameContext;
  export let embeddedRuntimeContext: EntityWorkspaceEmbeddedRuntimeContext = emptyEntityWorkspaceEmbeddedRuntimeContext;
  export let runtimeProjectionFrame: RuntimeAdapterViewFrame | null = null;
  const dispatch = createEventDispatcher();
  let env: Env | EnvSnapshot | null = null;
  let liveEnv: Env | null = null;
  let liveEnvResolver: (() => Env | null) | null = null;
  let envRevision = '';
  let history: EnvSnapshot[] = [];
  let timeIndex = -1;
  let isLive = true;
  $: env = embeddedRuntimeContext.env;
  $: liveEnv = embeddedRuntimeContext.liveEnv;
  $: liveEnvResolver = embeddedRuntimeContext.liveEnvResolver;
  $: envRevision = runtimeFrameContext.envRevision;
  $: history = embeddedRuntimeContext.history;
  $: timeIndex = runtimeFrameContext.timeIndex;
  $: isLive = runtimeFrameContext.isLive;
  type DebtDrainRequest = {
    tokenId: number;
    symbol: string;
    maxIterations: number;
    openCount: number;
    outstandingAmount: bigint;
    reserveAmount: bigint;
    payableAmount: bigint;
    nextDebtIndex: number | null;
  };
  type EntitySettingsProfileDraft = {
    name: string;
    avatar: string;
    bio: string;
    website: string;
  };
  // Set initial tab based on action
  function getInitialTab(): ViewTab {
    return 'accounts';
  }
  function getInitialAccountWorkspaceTab(): AccountWorkspaceTab {
    if (initialAction === 'r2r' || initialAction === 'pay') return 'send';
    if (initialAction === 'r2c') return 'move';
    if (initialAction === 'swap') return 'swap';
    if (initialAction === 'dispute') return 'configure';
    return 'open';
  }
  let activeTab: ViewTab = getInitialTab();
  let settingsSubview: SettingsSubview = 'wallet';
  let accountWorkspaceTab: AccountWorkspaceTab = getInitialAccountWorkspaceTab();
  let assetWorkspaceTab: AssetWorkspaceTab = 'move';
  let configureWorkspaceTab: ConfigureWorkspaceTab = 'extend-credit';
  let workspaceAccountId = '';
  let configureTokenId = 1;
  let pendingBatchSubmitting = false;
  let debtEnforcingTokenId: number | null = null;
  let pendingBatchMode: 'draft' | 'sent' | null = null;
  let pendingBatchState = buildPendingBatchState(null);
  let hubDiscoveryProjection: HubDiscoveryProjection = emptyHubDiscoveryProjection();
  let paymentView: PaymentPanelView = emptyPaymentPanelView();
  // State
  let replica: EntityReplica | null = null;
  let selectedAccountId: string | null = null;
  let selectedJurisdictionName: string | null = null;
  let copiedMetaField = '';
  let resettingEverything = false;
  let openAccountEntityId = '';
  let currentEntityValue = '';
  let currentExternalEoaValue = '';
  let entityActivityAccountFilter = 'all';
  let firstFaucetAccountId = '';
  let hasAnyAccounts = false;
  $: if (userModeHeader) {
    selectedJurisdictionName = selectedJurisdiction;
  }
  function resolveApiBase(): string {
    if (typeof window === 'undefined') return 'https://xln.finance';
    return resolveConfiguredApiBase(window.location.origin);
  }
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  function buildHashRouteFromState(): string {
    return buildEntityPanelHashRouteFromState({
      activeTab,
      assetWorkspaceTab,
      settingsSubview,
      accountWorkspaceTab,
    });
  }
  function applyDeepLinkViewFromUrl(): void {
    if (typeof window === 'undefined') return;
    const next = resolveEntityPanelDeepLinkFromLocation(
      window.location,
      availableJurisdictions.map((candidate) => candidate?.name),
    );
    if (next.activeTab) activeTab = next.activeTab;
    if (next.assetWorkspaceTab) assetWorkspaceTab = next.assetWorkspaceTab;
    if (next.settingsSubview) settingsSubview = next.settingsSubview;
    if (next.accountWorkspaceTab) accountWorkspaceTab = next.accountWorkspaceTab;
    if (next.configureWorkspaceTab) configureWorkspaceTab = next.configureWorkspaceTab;
    if ('selectedJurisdictionName' in next) selectedJurisdictionName = next.selectedJurisdictionName ?? null;
  }
  function syncHashToCurrentView(): void {
    if (typeof window === 'undefined') return;
    const nextRoute = buildHashRouteFromState();
    const currentRoute = getLocationHashRoute(window.location);
    const currentCanonical = canonicalizeEntityPanelRoute(currentRoute);
    if (typeof currentRoute === 'string' && currentRoute.toLowerCase().startsWith('pay/') && nextRoute === 'accounts/send') {
      return;
    }
    const params = getLocationHashParams(window.location);
    const preserveParams = currentCanonical === nextRoute && params && params.toString().length > 0;
    const nextHash = preserveParams ? `${nextRoute}?${params.toString()}` : nextRoute;
    const currentHash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash;
    if (currentHash === nextHash) return;
    replaceState(`${window.location.pathname}${window.location.search}#${nextHash}`, window.history.state ?? {});
  }
  type TokenCatalogItem = {
    symbol: string;
    address: string;
    decimals?: number;
    tokenId?: number;
  };
  type TokenCatalogResponse = {
    tokens?: TokenCatalogItem[];
  };
  type IconTabConfig<T extends string> = {
    id: T;
    icon: ComponentType;
    label: string;
  };
  type IconBadgeTabConfig<T extends string> = IconTabConfig<T> & {
    showBadge?: boolean;
    badgeType?: 'pending';
  };
  type IndexedDbWithDatabases = IDBFactory & {
    databases?: () => Promise<IDBDatabaseInfo[]>;
  };
  type JTokenRegistryItem = Awaited<ReturnType<JAdapter['getTokenRegistry']>>[number];
  function getCurrentEntityJAdapter(xln: XLNModule, env: Env, context: string): JAdapter {
    const entityId = String(replica?.state?.entityId || tab.entityId || '').trim();
    const signerId = String(currentSignerId || tab.signerId || '').trim();
    const jadapter = entityId && xln.getEntityJAdapter
      ? xln.getEntityJAdapter(env, entityId, signerId || undefined)
      : xln.getActiveJAdapter?.(env);
    if (!jadapter) throw new Error(`J-adapter not available for ${context}`);
    return jadapter;
  }
  function buildEntityInput(entityId: string, signerId: string, entityTxs: EntityTx[]): RoutedEntityInput {
    return { entityId, signerId, entityTxs };
  }
  let moveNodeLayoutVersion = 0;
  let moveLineReady = false;
  let moveCommittedLineReady = false;
  let moveHubEntityOptions: string[] = [];
  let moveValidationSignature = '';
  function resetMoveLineMeasurement(): void {
    moveVisualController.resetMeasurement();
  }
  function scheduleMoveCommittedLineReady(): void {
    moveVisualController.scheduleCommittedLineReady();
  }
  function bumpMoveNodeLayout(): void {
    moveVisualController.bumpNodeLayout();
  }
  function moveNodeAction(
    node: HTMLButtonElement,
    params: { side: 'from' | 'to'; endpoint: MoveEndpoint },
  ): { update: (next: { side: 'from' | 'to'; endpoint: MoveEndpoint }) => void; destroy: () => void } {
    return moveVisualController.nodeAction(node, params);
  }
  function getMoveNodeAnchor(side: 'from' | 'to', endpoint: MoveEndpoint): { x: number; y: number } | null {
    return moveVisualController.getNodeAnchor(side, endpoint);
  }
  function beginMoveDrag(endpoint: MoveEndpoint, event: PointerEvent | MouseEvent): void {
    event.preventDefault();
    moveDragSource = endpoint;
    moveDragHoverTarget = null;
    moveSelectedSource = endpoint;
    moveVisualController.beginDrag();
  }
  function applyMoveRoute(from: MoveEndpoint, to: MoveEndpoint): void {
    const selfEntityId = resolveSelfEntityId();
    const selfEoa = resolveSelfEoaAddress();
    moveFromEndpoint = from;
    moveToEndpoint = to;
    if (to === 'reserve' && !moveReserveRecipientEntityId.trim()) {
      moveReserveRecipientEntityId = selfEntityId;
    }
    if (to === 'account' && !moveTargetEntityId.trim()) {
      moveTargetEntityId = selfEntityId;
    }
    if (to === 'external' && !moveExternalRecipient.trim() && selfEoa) {
      moveExternalRecipient = selfEoa;
    }
    moveSelectedSource = null;
    moveSelectedTarget = null;
    clearMoveDrag();
    bumpMoveNodeLayout();
  }
  function setMoveSource(endpoint: MoveEndpoint): void {
    if (moveSelectedTarget) {
      if (isMoveRouteSupported(endpoint, moveSelectedTarget)) {
        applyMoveRoute(endpoint, moveSelectedTarget);
        return;
      }
      moveToEndpoint = moveSelectedTarget;
    }
    moveFromEndpoint = endpoint;
    moveSelectedSource = endpoint;
  }
  function completeMoveSelection(target: MoveEndpoint): void {
    const source = moveDragSource ?? moveSelectedSource;
    if (!source) return;
    moveToEndpoint = target;
    if (isMoveRouteSupported(source, target)) {
      applyMoveRoute(source, target);
      return;
    }
    moveSelectedSource = source;
    moveSelectedTarget = target;
    clearMoveDrag();
  }
  function setMoveTarget(endpoint: MoveEndpoint): void {
    if (moveDragSource) {
      completeMoveSelection(endpoint);
      return;
    }
    if (moveSelectedSource && isMoveRouteSupported(moveSelectedSource, endpoint)) {
      applyMoveRoute(moveSelectedSource, endpoint);
      return;
    }
    moveToEndpoint = endpoint;
    moveSelectedTarget = endpoint;
  }
  function clearMoveDrag(): void {
    moveDragSource = null;
    moveDragHoverTarget = null;
    moveVisualController.clearDrag();
  }
  function moveRouteSteps(from: MoveEndpoint, to: MoveEndpoint): string[] {
    const targetEntity = getCurrentMoveTargetEntityId();
    const targetHub = getCurrentMoveTargetHubId();
    const targetEntityLabel = targetEntity ? formatAddress(targetEntity) : 'recipient';
    const targetHubLabel = targetHub ? formatAddress(targetHub) : 'hub';
    const reserveRecipientLabel = moveReserveRecipientEntityId
      ? formatAddress(moveReserveRecipientEntityId)
      : 'recipient reserve';
    return buildMoveRouteSteps(from, to, {
      targetEntityLabel,
      targetHubLabel,
      reserveRecipientLabel,
      hasRemoteReserveRecipient: Boolean(
        moveReserveRecipientEntityId && moveReserveRecipientEntityId !== resolveSelfEntityId(),
      ),
    });
  }
  function isMoveAwaitingCounterparty(): boolean {
    return pendingAssetAutoC2Rs.length > 0 || resolvingAssetAutoC2R;
  }
  function refreshPendingCollateralFundingToken(): void {
    collateralFundingToken = pendingAssetAutoC2Rs[0]?.symbol ?? null;
  }
  function getMoveDraftReserveDelta(tokenId: number): bigint {
    const entityId = String(replica?.state?.entityId || tab.entityId || '').trim().toLowerCase();
    const batch = replica?.state?.jBatchState?.batch;
    if (!entityId || !batch) return 0n;
    return getDraftBatchReserveDelta(entityId, batch, tokenId);
  }
  function getOpenOutgoingDebtForToken(tokenId: number): bigint {
    const bucket = replica?.state?.outDebtsByToken?.get?.(tokenId);
    if (!bucket) return 0n;
    let total = 0n;
    for (const debt of bucket.values()) {
      if (debt.status === 'open') {
        total += BigInt(debt.remainingAmount || 0);
      }
    }
    return total;
  }
  function getMoveMaxAmount(
    from: MoveEndpoint,
    reserveToken: ReserveTransferAsset | null,
    externalToken: ExternalToken | null,
    sourceAccountId: string,
  ): bigint | null {
    return getMoveMaxAmountForEndpoint({
      from,
      reserveToken,
      externalToken,
      sourceAccountId,
      reserveBalance: (tokenId) => onchainReserves.get(tokenId) ?? 0n,
      draftReserveDelta: getMoveDraftReserveDelta,
      outgoingDebt: getOpenOutgoingDebtForToken,
      accountSpendable: getAccountSpendableCapacity,
    });
  }
  function getMoveValidationError(mode: MoveValidationMode): string | null {
    return getMoveValidationErrorForContext({
      mode,
      from: moveFromEndpoint,
      to: moveToEndpoint,
      amountInput: moveAmount,
      executing: moveExecuting,
      activeIsLive,
      awaitingCounterparty: isMoveAwaitingCounterparty(),
      hasSentBatch,
      sourceAccountId: getCurrentMoveSourceAccountId(),
      targetEntityId: getCurrentMoveTargetEntityId(),
      targetHubId: getCurrentMoveTargetHubId(),
      selfEntityId: resolveSelfEntityId(),
      selfExternalAddress: resolveSelfEoaAddress(),
      reserveRecipientEntityId: moveReserveRecipientEntityId,
      externalRecipient: moveExternalRecipient,
      reserveToken: selectedMoveTransferToken,
      externalToken: selectedMoveExternalToken,
      sourceAvailableBalance: moveUiState.sourceAvailableBalance,
      allowanceRequired: routeRequiresExplicitExternalAllowance(moveFromEndpoint, moveToEndpoint),
      allowanceLoading: moveAllowanceLoading,
      allowanceError: moveAllowanceError,
      allowanceRaw: moveAllowanceRaw,
    });
  }
  let moveAllowanceToken: ExternalToken | null = null;
  let moveAllowanceAssetIdentity = '';
  let moveAllowanceMetadataLoading = false;
  $: moveAllowanceRouteEnabled = assetWorkspaceTab === 'move'
    && activeIsLive
    && routeRequiresExplicitExternalAllowance(moveFromEndpoint, moveToEndpoint);
  $: moveAllowanceContextSignature = buildMoveAllowanceContextSignature({
    enabled: moveAllowanceRouteEnabled,
    from: moveFromEndpoint,
    to: moveToEndpoint,
    assetSymbol: moveAssetSymbol,
    signerId: currentSignerId,
    runtimeId: panelView.runtimeId,
  });
  $: if (moveAllowanceContextSignature !== moveAllowanceContextKey) {
    moveAllowanceContextKey = moveAllowanceContextSignature;
    moveAllowanceAmountDirty = false;
    if (moveAllowanceRouteEnabled && typeof window !== 'undefined' && String(currentSignerId || '').trim()) {
      void fetchExternalTokens();
    }
  }
  $: if (moveAllowanceRouteEnabled && !moveAllowanceAmountDirty) {
    moveAllowanceAmount = moveAmount;
  }
  $: if (!moveAllowanceRouteEnabled) {
    moveAllowanceAmount = '';
    moveAllowanceError = null;
    moveAllowanceRaw = null;
    moveAllowanceLoading = false;
    moveAllowanceSubmittingMode = null;
  }
  $: moveAllowanceAssetIdentity = String(moveAssetSymbol || '').trim().toUpperCase();
  $: moveAllowanceToken = moveAllowanceAssetIdentity
    ? findExternalTokenBySymbol(moveAllowanceAssetIdentity)
    : null;
  $: moveAllowanceMetadataLoading = moveAllowanceRouteEnabled
    && Boolean(moveAllowanceAssetIdentity)
    && externalTokensLoading
    && !moveAllowanceToken;
  $: moveRequiredAllowanceAmount = getMoveRequiredAllowanceAmount({
    enabled: moveAllowanceRouteEnabled,
    token: moveAllowanceToken,
    amountInput: moveAmount,
    sourceAvailableBalance: moveUiState.sourceAvailableBalance,
  });
  $: moveAllowanceSatisfied = isMoveAllowanceSatisfied(moveRequiredAllowanceAmount, moveAllowanceRaw);
  $: moveAllowanceStatusLabel = buildMoveAllowanceStatusLabel({
    enabled: moveAllowanceRouteEnabled && Boolean(moveAllowanceAssetIdentity),
    tokenSymbol: moveAllowanceAssetIdentity,
    tokenDecimals: moveAllowanceToken
      ? requireTokenDecimals(moveAllowanceToken.decimals, `asset:${moveAllowanceAssetIdentity}`)
      : null,
    metadataLoading: moveAllowanceMetadataLoading,
    raw: moveAllowanceRaw,
    loading: moveAllowanceLoading,
    error: moveAllowanceError,
    required: moveRequiredAllowanceAmount,
    formatAmount,
  });
  $: moveValidationSignature = [
    moveFromEndpoint,
    moveToEndpoint,
    moveAmount,
    moveAssetSymbol,
    moveExternalRecipient,
    moveReserveRecipientEntityId,
    moveSourceAccountId,
    moveTargetEntityId,
    moveTargetHubEntityId,
    moveExecuting ? '1' : '0',
    pendingAssetAutoC2Rs.length > 0 ? String(pendingAssetAutoC2Rs.length) : '0',
    resolvingAssetAutoC2R ? '1' : '0',
    workspaceAccountId,
    selectedAccountId || '',
    selectedMoveTransferToken ? String(selectedMoveTransferToken.tokenId) : '',
    selectedMoveExternalToken ? selectedMoveExternalToken.address : '',
    moveUiState.ledgerRow ? moveUiState.ledgerRow.externalBalance.toString() : '0',
    moveUiState.ledgerRow ? moveUiState.ledgerRow.reserveBalance.toString() : '0',
    moveUiState.ledgerRow ? moveUiState.ledgerRow.accountBalance.toString() : '0',
    moveUiState.sourceAvailableBalance.toString(),
    typeof moveAllowanceRaw === 'bigint' ? moveAllowanceRaw.toString() : 'null',
    moveAllowanceLoading ? '1' : '0',
    moveAllowanceError || '',
  ].join('|');
  $: {
    void moveValidationSignature;
    moveDraftError = getMoveValidationError('draft');
    moveBroadcastError = getMoveValidationError('broadcast');
  }
  function resolveSelfEoaAddress(): string {
    const signerId = String(currentSignerId || '').trim();
    if (isAddress(signerId)) return signerId;
    const vaultId = String($activeRuntime?.id || '').trim();
    if (isAddress(vaultId)) return vaultId;
    return '';
  }
  function resolveSelfEntityId(): string {
    return String(replica?.state?.entityId || tab.entityId || '').trim().toLowerCase();
  }
  function handleMoveReserveRecipientChange(event: CustomEvent<{ value?: string }>) {
    moveReserveRecipientEntityId = String(event.detail?.value || '').trim().toLowerCase();
  }
  function handleMoveSourceAccountChange(event: CustomEvent<{ value?: string }>) {
    moveSourceAccountId = normalizeWorkspaceAccountId(String(event.detail?.value || ''), workspaceAccountIds);
  }
  function handleMoveTargetEntityChange(event: CustomEvent<{ value?: string }>) {
    const next = String(event.detail?.value || '').trim().toLowerCase();
    if (next !== moveTargetEntityId) {
      moveTargetCounterpartyManualOverride = false;
      moveTargetHubEntityId = '';
    }
    moveTargetEntityId = next;
  }
  function handleMoveTargetHubChange(event: CustomEvent<{ value?: string }>) {
    const next = String(event.detail?.value || '').trim().toLowerCase();
    if (!next) {
      moveTargetHubEntityId = '';
      moveTargetCounterpartyManualOverride = false;
      return;
    }
    const supported = moveHubEntityOptions.map((id) => String(id).trim().toLowerCase());
    if (!supported.includes(next)) {
      const confirmed = typeof window === 'undefined'
        ? true
        : window.confirm('This counterparty is not listed in the recipient profile. Funds may be lost if they do not support this account. Continue?');
      if (!confirmed) return;
      moveTargetCounterpartyManualOverride = true;
    } else {
      moveTargetCounterpartyManualOverride = false;
    }
    moveTargetHubEntityId = next;
  }
  function getCurrentMoveSourceAccountId(): string {
    const current = String(moveSourceAccountId || workspaceAccountId || selectedAccountId || '').trim();
    if (moveFromEndpoint !== 'account') return current;
    const token = selectedMoveTransferToken;
    if (!token) return current;
    return getPreferredMoveSourceAccountId(token.tokenId, getRequestedMoveAmount(token));
  }
  function getCurrentMoveTargetEntityId(): string {
    return String(moveTargetEntityId || resolveSelfEntityId() || '').trim().toLowerCase();
  }
  function getCurrentMoveTargetHubId(): string {
    return String(moveTargetHubEntityId || workspaceAccountId || selectedAccountId || '').trim().toLowerCase();
  }
  function getRequestedMoveAmount(token: { decimals: number }): bigint {
    try {
      return moveAmount.trim() ? parsePositiveAssetAmount(moveAmount, token) : 0n;
    } catch {
      return 0n;
    }
  }
  function getPreferredMoveSourceAccountId(tokenId: number, requestedAmount: bigint): string {
    return getPreferredMoveSourceAccountIdFromBalances({
      current: String(moveSourceAccountId || workspaceAccountId || selectedAccountId || '').trim(),
      workspaceAccountIds,
      tokenId,
      requestedAmount,
      accountSpendable: getAccountSpendableCapacity,
    });
  }
  function computeMoveSourceAvailableBalance(
    row: AssetLedgerRow | null,
    liveTransferToken: ReserveTransferAsset | null,
  ): bigint {
    return computeMoveSourceAvailableBalanceForEndpoint({
      from: moveFromEndpoint,
      row,
      liveTransferToken,
      externalToken: findExternalTokenBySymbol(moveAssetSymbol),
      reserveBalance: (tokenId) => onchainReserves.get(tokenId) ?? 0n,
      draftReserveDelta: getMoveDraftReserveDelta,
      outgoingDebt: getOpenOutgoingDebtForToken,
      sourceAccountId: getCurrentMoveSourceAccountId(),
      accountSpendable: getAccountSpendableCapacity,
    });
  }
  function choosePreferredMoveAssetSymbol(): string {
    const sourceAccountId = getCurrentMoveSourceAccountId();
    return choosePreferredMoveAssetSymbolFromBalances({
      candidates: moveAssetOptions,
      availableBalance: (symbol) => {
        const externalToken = findExternalTokenBySymbol(symbol);
        const reserveToken = findReserveTransferTokenBySymbol(symbol);
        return (
          getMoveMaxAmount(
            moveFromEndpoint,
            reserveToken,
            externalToken,
            sourceAccountId,
          ) ?? 0n
        );
      },
    });
  }
  function toErrorMessage(error: unknown, fallback: string): string {
    if (error instanceof Error && error.message) return error.message;
    return fallback;
  }
  function logEntityPanelDiagnostic(message: string, details?: unknown): void {
    errorLog.log(message, 'Entity Panel', details);
  }
  function recordServerIngressReceipt(result: Pick<FaucetApiResult, 'receipt' | 'statusUrl'> & { runtimeId?: string | null }): void {
    if (!result.receipt) return;
    recordRuntimeIngressReceipt({
      runtimeId: result.runtimeId || $runtimeControllerHandle.runtimeId || $runtimeControllerHandle.id || 'remote',
      mode: 'remote',
      receipt: result.receipt,
      statusUrl: result.statusUrl ?? null,
    });
  }
  function notifyUserActionError(context: string, message: string): void {
    logEntityPanelDiagnostic(message, { context });
    toasts.error(message);
  }
  function formatHubDiscoveryRawProfile(profile: unknown): string {
    if (activeXlnFunctions?.safeStringify) return activeXlnFunctions.safeStringify(profile, 2);
    try {
      return JSON.stringify(profile, null, 2);
    } catch {
      return '[unserializable profile]';
    }
  }
  function resolveHubDiscoveryAvatar(entityId: string): string {
    return resolveEntityAvatar(activeXlnFunctions, entityId);
  }
  async function copyMetaValue(value: string, field: 'entity' | 'external'): Promise<void> {
    const normalizedValue = String(value || '').trim();
    if (!normalizedValue) return;
    try {
      await navigator.clipboard.writeText(normalizedValue);
      copiedMetaField = field;
      setTimeout(() => {
        if (copiedMetaField === field) copiedMetaField = '';
      }, 2000);
    } catch (err) {
      logEntityPanelDiagnostic('Failed to copy entity metadata', { field, error: toErrorMessage(err, 'Copy failed') });
    }
  }
  // Get avatar URL without tripping early boot fail-fast guards.
  $: avatar = resolveEntityAvatar(activeXlnFunctions, tab.entityId);
  $: activeEnv = env;
  $: activeLiveEnv = liveEnv;
  $: activeIsLive = isLive;
  $: fallbackRuntimeEnv = getRuntimeEnv(activeEnv);
  $: actionRuntimeEnv = activeLiveEnv ?? (typeof liveEnvResolver === 'function' ? liveEnvResolver() : null) ?? fallbackRuntimeEnv;
  $: displayEnv = activeIsLive ? (actionRuntimeEnv ?? activeEnv) : activeEnv;
  $: displayProjectionFrame = activeIsLive && actionRuntimeEnv ? null : runtimeProjectionFrame;
  $: panelView = buildEntityPanelView(displayEnv, tab.entityId, tab.signerId, envRevision, displayProjectionFrame);
  $: directoryPanelView = runtimeProjectionFrame
    ? buildEntityPanelView(activeEnv, tab.entityId, tab.signerId, envRevision, runtimeProjectionFrame)
    : panelView;
  $: activeReplicas = panelView.replicas;
  $: panelProfiles = panelView.profiles;
  $: replica = panelView.replica;
  $: remoteHubCandidates = buildHubDiscoveryRemoteHubsFromRuntimes($runtimeHandles.values());
  $: hubDiscoveryProjection = buildHubDiscoveryProjection({
    entityId: currentEntityValue || tab.entityId,
    runtimeId: panelView.runtimeId,
    replicas: directoryPanelView.replicas ?? activeReplicas,
    profiles: directoryPanelView.profiles?.length ? directoryPanelView.profiles : panelProfiles,
    remoteHubs: remoteHubCandidates,
    formatRawProfile: formatHubDiscoveryRawProfile,
    avatarForEntity: resolveHubDiscoveryAvatar,
  });
  $: registerDebugSurface('hubDiscovery', () => ({
    entityId: currentEntityValue || tab.entityId,
    runtimeId: panelView.runtimeId,
    remoteHubCandidates: remoteHubCandidates.map((hub) => ({
      entityId: hub.entityId,
      name: hub.name,
      runtimeId: hub.runtimeId,
      jurisdiction: hub.jurisdiction,
    })),
    discoveryKey: hubDiscoveryProjection.discoveryKey,
    entityJurisdictionKey: hubDiscoveryProjection.entityJurisdictionKey,
    localHubCount: hubDiscoveryProjection.localHubs.length,
  }));
  $: paymentView = displayProjectionFrame
    ? buildPaymentPanelViewFromRuntimeView({
        entityId: currentEntityValue || tab.entityId,
        frame: displayProjectionFrame,
      })
    : buildPaymentPanelView({
        entityId: currentEntityValue || tab.entityId,
        replicas: activeReplicas,
        profiles: panelProfiles,
        networkGraph: actionRuntimeEnv?.gossip?.getNetworkGraph?.() ?? null,
      });
  $: swapRuntimeView = buildSwapPanelRuntimeView({
    profiles: panelProfiles,
    entityNames: panelView.entityNames,
    replicas: activeReplicas,
  }) as SwapPanelRuntimeView;
  $: currentEntityValue = String(replica && replica.state ? (replica.state.entityId || tab.entityId || '') : (tab.entityId || '')).trim();
  $: currentSignerId = (() => {
    const tabSignerId = String(tab.signerId || '').trim();
    if (tabSignerId) return tabSignerId;
    return String(replica?.signerId || '').trim();
  })();
  $: currentEntityJurisdictionName = getCurrentEntityJurisdictionName(null, replica)
    ?? panelView.activeJurisdictionName
    ?? tab.jurisdiction
    ?? null;
  $: currentExternalEoaValue = String(currentSignerId || '').trim();
  // Resolve entity name from gossip profiles
  $: gossipName = (() => {
    const entityId = (replica?.state?.entityId || tab.entityId || '').toLowerCase();
    if (!entityId) return '';
    const profile = panelProfiles.find((p: GossipProfile) => p.entityId.toLowerCase() === entityId);
    return profile?.name || '';
  })();
  $: heroDisplayName = (() => {
    const fallbackId = replica?.state?.entityId || tab.entityId || '';
    const gossip = (gossipName ?? '').trim();
    return gossip && !isPlaceholderEntityName(gossip) ? gossip : fallbackId;
  })();
  $: entityJurisdictionBadge = getJurisdictionBadgeInfo(
    replica?.state?.config?.jurisdiction?.name || selectedJurisdictionName || tab.jurisdiction || null,
    replica?.state?.config?.jurisdiction?.chainId ?? null,
  );
  $: activeXlnFunctions = $xlnFunctions;
  $: activeHistory = history;
  $: activeTimeIndex = timeIndex;
  $: liveRuntimeEnv = getRuntimeEnv(actionRuntimeEnv);
  $: canOpenAccounts = canSubmitHubOpenAccount({
    adapterMode: $runtimeControllerHandle.mode,
    authLevel: $runtimeControllerHandle.authLevel,
  });
  $: openAccountPermissionError = getHubOpenAccountPermissionError({
    adapterMode: $runtimeControllerHandle.mode,
    authLevel: $runtimeControllerHandle.authLevel,
  });
  async function submitRuntimeInput(input: RuntimeInput): Promise<Env | null> {
    if (!getRuntimeEnv(actionRuntimeEnv) && $runtimeControllerHandle.mode !== 'remote') {
      requireRuntimeEnv(actionRuntimeEnv, 'runtime-input-submit');
    }
    return submitRuntimeCommandInput(input);
  }
  function resolveEntitySigner(entityId: string, reason: string): string {
    const env = getRuntimeEnv(actionRuntimeEnv);
    if (env && activeXlnFunctions?.resolveEntityProposerId) {
      return activeXlnFunctions.resolveEntityProposerId(env, entityId, reason);
    }
    const normalizedEntityId = String(entityId || '').trim().toLowerCase();
    const projectionEntityId = String(replica?.state?.entityId || replica?.entityId || tab.entityId || '').trim().toLowerCase();
    const projectionSignerId = String(replica?.signerId || tab.signerId || '').trim();
    if (!env && normalizedEntityId && normalizedEntityId === projectionEntityId && projectionSignerId) {
      return projectionSignerId;
    }
    return requireSignerIdForEntity(requireRuntimeEnv(actionRuntimeEnv, reason), entityId, reason);
  }
  async function saveSettingsProjectionProfile(draft: EntitySettingsProfileDraft): Promise<void> {
    const entityId = String(currentEntityValue || replica?.state?.entityId || tab.entityId || '').trim().toLowerCase();
    if (!entityId) throw new Error('Entity is required for profile update');
    if (!activeIsLive) throw new Error('Profile updates require LIVE mode');
    const signerId = resolveEntitySigner(entityId, 'settings-profile-update');
    if (!signerId) throw new Error('Signer is required for profile update');
    await submitEntityInputs([buildEntityInput(entityId, signerId, [{
      type: 'profile-update' as const,
      data: {
        profile: {
          entityId,
          name: draft.name.trim(),
          avatar: draft.avatar.trim(),
          bio: draft.bio.trim(),
          website: draft.website.trim(),
        },
      },
    }])]);
    toasts.success('Entity profile update submitted');
  }

  function requirePanelRuntimeTimestamp(context: string): number {
    const timestamp = Math.floor(Number(panelView.timestamp));
    if (!Number.isFinite(timestamp) || timestamp < 0) {
      throw new Error(`${context}: runtime timestamp unavailable`);
    }
    return timestamp;
  }

  async function importSettingsJMachine(detail: JMachineCreateDetail): Promise<void> {
    if (!activeIsLive) throw new Error('Jurisdiction imports require LIVE mode');
    const env = requireRuntimeEnv(actionRuntimeEnv, 'settings-import-jmachine');
    await importJMachineViaRuntime(env, detail);
    toasts.success('Imported into active runtime');
  }

  function findLiveReplicaForEntity(entityId: string, signerId: string): EntityReplica | null {
    const env = getRuntimeEnv(actionRuntimeEnv);
    return env ? buildEntityPanelView(env, entityId, signerId).replica : null;
  }
  function getCurrentLiveEntityReplica(): EntityReplica | null {
    const entityId = String(replica?.state?.entityId || tab.entityId || '').trim();
    const signerId = String(currentSignerId || tab.signerId || '').trim();
    return (entityId ? findLiveReplicaForEntity(entityId, signerId) : null) ?? replica;
  }
  // Navigation
  $: isAccountFocused = selectedAccountId !== null;
  $: selectedAccount = isAccountFocused && replica?.state?.accounts && selectedAccountId
    ? materializeAccountView(replica.state.accounts.get(selectedAccountId)) : null;
  $: accountIds = replica?.state?.accounts
    ? Array.from(replica.state.accounts.keys()).map((id) => String(id))
    : [];
  $: workspaceAccountIds = accountIds.filter((id) => {
    const account = replica?.state?.accounts?.get?.(id) as AccountMachine | undefined;
    if (!account) return false;
    return String(account.status || '') !== 'disputed';
  });
  let lastAccountReplicaSignature = '';
  $: {
    const signature = [
      String(tab.entityId || ''),
      String(tab.signerId || ''),
      String(panelView.runtimeId || ''),
      String(replica?.state?.entityId || ''),
      String(accountIds.length),
      String(workspaceAccountIds.length),
      accountIds.join(','),
    ].join('|');
    if (signature !== lastAccountReplicaSignature) {
      lastAccountReplicaSignature = signature;
    }
  }
  $: if (!workspaceAccountId || !workspaceAccountIds.includes(workspaceAccountId)) {
    workspaceAccountId = workspaceAccountIds[0] || '';
  }
  $: firstFaucetAccountId = workspaceAccountIds[0] || accountIds[0] || '';
  $: if (assetWorkspaceTab === 'move' && workspaceAccountIds.length > 0) {
    const token = selectedMoveTransferToken;
    if (moveFromEndpoint === 'account' && token) {
      const preferred = getPreferredMoveSourceAccountId(token.tokenId, getRequestedMoveAmount(token));
      if (preferred && moveSourceAccountId !== preferred) {
        moveSourceAccountId = preferred;
      }
    }
  }
  $: if (assetWorkspaceTab === 'move' && moveNeedsExternalRecipient(moveFromEndpoint, moveToEndpoint) && !moveExternalRecipient.trim()) {
    moveExternalRecipient = resolveSelfEoaAddress();
  }
  $: if (assetWorkspaceTab === 'move' && moveNeedsReserveRecipient(moveFromEndpoint, moveToEndpoint) && !moveReserveRecipientEntityId.trim()) {
    moveReserveRecipientEntityId = resolveSelfEntityId();
  }
  $: if (assetWorkspaceTab === 'move' && moveToEndpoint === 'account' && !moveTargetEntityId.trim()) {
    moveTargetEntityId = resolveSelfEntityId();
  }
  $: moveHubEntityOptions = buildMoveHubEntityOptions({
    targetEntityId: moveTargetEntityId,
    selfEntityId: resolveSelfEntityId(),
    workspaceAccountIds,
    profiles: panelProfiles,
  });
  $: if (assetWorkspaceTab === 'move' && moveToEndpoint === 'account') {
    moveTargetHubEntityId = resolveMoveTargetHubEntityId({
      currentTargetHubId: moveTargetHubEntityId,
      workspaceAccountId,
      options: moveHubEntityOptions,
      manualOverride: moveTargetCounterpartyManualOverride,
    });
  }
  $: configureTokenOptions = buildConfigureTokenOptions({
    reserveTokenIds: replica?.state?.reserves?.keys?.() || [],
    getTokenInfo,
    compareSymbols: compareTokenSymbols,
  });
  $: configureTokenId = resolveConfigureTokenId(configureTokenId, configureTokenOptions);
  // Jurisdictions
  $: availableJurisdictions = panelView.jurisdictions;
  $: {
    if (showJurisdiction && availableJurisdictions.length > 0 && !selectedJurisdictionName) {
      selectedJurisdictionName = currentEntityJurisdictionName ?? availableJurisdictions[0]?.name ?? null;
    }
  }
  let openAccountEntityOptions: string[] = [];
  let moveEntityOptions: string[] = [];
  let moveSourceAccountOptions: string[] = [];
  function handleOpenAccountTargetChange(event: CustomEvent<{ value?: string }>) {
    openAccountEntityId = String(event.detail?.value || '').trim();
  }
  function handleWorkspaceAccountChange(event: CustomEvent<{ value?: string }>) {
    workspaceAccountId = normalizeWorkspaceAccountId(String(event.detail?.value || ''), workspaceAccountIds);
  }
  $: openAccountEntityOptions = (() => {
    return buildOpenAccountEntityOptions({
      replica,
      tabEntityId: tab.entityId,
      accountIds,
      activeReplicas,
      profiles: panelProfiles,
    });
  })();
  $: moveEntityOptions = (() => {
    return buildMoveEntityOptions({
      replica,
      tabEntityId: tab.entityId,
      accountIds,
      openAccountEntityOptions,
      activeReplicas,
      profiles: panelProfiles,
    });
  })();
  $: moveSourceAccountOptions = (() => {
    return buildMoveSourceAccountOptions({ workspaceAccountIds, accountIds });
  })();
  // On-chain reserves are derived directly from replica.state.reserves.
  let onchainReserves: Map<number, bigint> = new Map();
  let pendingReserveFaucets: PendingReserveFaucet[] = [];
  let pendingOffchainFaucetKeys = new Set<string>();
  let assetFaucetSubmitting = false;
  // External tokens (ERC20 balances held by signer EOA)
  let externalTokens: ExternalToken[] = [];
  let externalTokensLoading = true;
  let externalWalletSnapshotSource: ExternalWalletSnapshotSource | null = null;
  let depositingToken: string | null = null; // symbol of token being deposited
  let withdrawingExternalToken: string | null = null; // symbol of token being withdrawn back to EOA
  let collateralFundingToken: string | null = null; // symbol of token being moved to collateral
  let faucetAssetSymbol = 'USDC';
  let externalToReserveSymbol = 'USDC';
  let reserveToCollateralSymbol = 'USDC';
  let collateralToReserveSymbol = 'USDC';
  let reserveToExternalSymbol = 'USDC';
  let sendAssetSymbol = 'USDC';
  let sendAssetAmount = '';
  let sendAssetRecipient = '';
  let moveFromEndpoint: MoveEndpoint = 'external';
  let moveToEndpoint: MoveEndpoint = 'reserve';
  let moveAssetSymbol = 'USDC';
  let moveAmount = '';
  let moveExternalRecipient = '';
  let moveReserveRecipientEntityId = '';
  let moveSourceAccountId = '';
  let moveTargetEntityId = '';
  let moveTargetHubEntityId = '';
  let moveTargetCounterpartyManualOverride = false;
  let moveExecuting = false;
  let moveProgressLabel = '';
  let moveLayoutSignature = '';
  let moveDraftError: string | null = null;
  let moveBroadcastError: string | null = null;
  let moveAllowanceAmount = '';
  let moveAllowanceAmountDirty = false;
  let moveAllowanceLoading = false;
  let moveAllowanceError: string | null = null;
  let moveAllowanceRaw: bigint | null = null;
  let moveAllowanceSubmittingMode: 'amount' | 'max' | null = null;
  let moveAllowanceContextKey = '';
  let moveSelectedSource: MoveEndpoint | null = null;
  let moveSelectedTarget: MoveEndpoint | null = null;
  let moveDragSource: MoveEndpoint | null = null;
  let moveDragHoverTarget: MoveEndpoint | null = null;
  const moveVisualController = createMoveVisualController({
    getFromEndpoint: () => moveFromEndpoint,
    getToEndpoint: () => moveToEndpoint,
    getDragSource: () => moveDragSource,
    isLineReady: () => moveLineReady,
    setLineReady: (ready) => moveLineReady = ready,
    setCommittedLineReady: (ready) => moveCommittedLineReady = ready,
    bumpLayoutVersion: () => moveNodeLayoutVersion += 1,
  });
  let collateralToReserveAmount = '';
  let reserveToExternalAmount = '';
  let sendingExternalToken: string | null = null;
  let transferableAssetOptions: ReserveTransferAsset[] = [];
  let assetLedgerRows: AssetLedgerRow[] = [];
  let moveUiState: MoveUiState = {
    ledgerRow: null,
    displayBalances: { external: 0n, reserve: 0n, account: 0n },
    displayDecimals: 0,
    sourceAvailableBalance: 0n,
  };
  let lastMoveAmountContextKey = '';
  let accountSpendableByToken = new Map<number, bigint>();
  let pendingAssetBridgeSync: {
    tokenId: number;
    symbol: string;
    direction: 'deposit' | 'withdraw';
    baselineReserve: bigint;
  } | null = null;
  let resolvingAssetBridgeSync = false;
  let pendingAssetAutoC2Rs: PendingAssetAutoC2R[] = [];
  let resolvingAssetAutoC2R = false;
  let externalFetchInFlight: Promise<void> | null = null;
  let externalWalletStateSyncKey = '';
  let externalTokenCatalogCacheKey = '';
  let externalTokenCatalogCache: ExternalToken[] | null = null;
  let selectedExternalToReserveToken: ReserveTransferAsset | null = null;
  let selectedReserveToCollateralToken: ReserveTransferAsset | null = null;
  let selectedCollateralToReserveToken: ReserveTransferAsset | null = null;
  let selectedReserveToExternalToken: ReserveTransferAsset | null = null;
  let selectedSendAssetToken: ExternalToken | null = null;
  let moveAssetOptions: Array<{ symbol: string }> = [];
  let selectedMoveExternalToken: ExternalToken | null = null;
  let selectedMoveTransferToken: ReserveTransferAsset | null = null;
  $: moveLayoutSignature = [
    assetWorkspaceTab,
    moveFromEndpoint,
    moveToEndpoint,
    moveSelectedSource || '',
    moveSelectedTarget || '',
    moveNeedsReserveRecipient(moveFromEndpoint, moveToEndpoint) ? 'reserve-recipient' : '',
    moveNeedsExternalRecipient(moveFromEndpoint, moveToEndpoint) ? 'external-recipient' : '',
    moveToEndpoint === 'account' ? 'target-account' : '',
  ].join('|');
  $: if (assetWorkspaceTab === 'move') {
    void moveLayoutSignature;
    bumpMoveNodeLayout();
  }
  type MoveUiState = {
    ledgerRow: AssetLedgerRow | null;
    displayBalances: Record<MoveEndpoint, bigint>;
    displayDecimals: number;
    sourceAvailableBalance: bigint;
  };
  function nullOnAmbiguousAsset<T>(read: () => T): T | null {
    try {
      return read();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith('ASSET_SYMBOL_AMBIGUOUS:')) return null;
      throw error;
    }
  }
  function findExternalTokenBySymbol(symbol: string): ExternalToken | null {
    return nullOnAmbiguousAsset(() => findExternalTokenBySymbolInList(externalTokens, symbol));
  }
  function findAssetLedgerRowBySymbol(symbol: string): AssetLedgerRow | null {
    return nullOnAmbiguousAsset(() => findAssetLedgerRowBySymbolInList(assetLedgerRows, symbol));
  }
  function findReserveTransferTokenBySymbol(symbol: string): ReserveTransferAsset | null {
    return nullOnAmbiguousAsset(() => resolveReserveTransferTokenBySymbol({
      symbol,
      externalTokens,
      assetLedgerRows,
      resolveReserveTokenMeta,
    }));
  }
  function getFaucetReserveTokenMeta(symbol: string): { tokenId: number; symbol: string } | null {
    return nullOnAmbiguousAsset(() => getFaucetReserveTokenMetaFromRows(assetLedgerRows, symbol));
  }
  function requireExternalTokenBySymbol(symbol: string): ExternalToken {
    return requireExternalTokenBySymbolInList(externalTokens, symbol);
  }
  function getMoveAllowanceToken(): ExternalToken {
    const token = requireExternalTokenBySymbol(moveAssetSymbol);
    if (!isAddress(token.address) || token.address === ZeroAddress) {
      throw new Error('Select ERC20 asset first');
    }
    return token;
  }
  async function getMoveAllowanceContext(context: string): Promise<{
    env: Env;
    jadapter: JAdapter;
    token: ExternalToken;
    owner: string;
    spender: string;
  }> {
    const env = requireRuntimeEnv(actionRuntimeEnv, context);
    const xln = await getXLN();
    const jadapter = getCurrentEntityJAdapter(xln, env, context);
    const owner = resolveSelfEoaAddress();
    if (!isAddress(owner)) throw new Error('Active signer EOA missing');
    const spender = String(jadapter.addresses.depository || '').trim();
    if (!isAddress(spender) || spender === ZeroAddress) {
      throw new Error('Depository address unavailable');
    }
    return {
      env,
      jadapter,
      token: getMoveAllowanceToken(),
      owner,
      spender,
    };
  }
  async function requestExternalGasFaucet(owner: string, amount = '0.1'): Promise<void> {
    const requestApiBase = resolveApiBase();
    const response = await fetch(`${requestApiBase}/api/faucet/gas`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userAddress: owner, amount }),
    });
    const result = await readJsonResponse<FaucetApiResult>(response);
    if (!response.ok || !result?.success) {
      throw new Error(result?.error || `Gas faucet failed (${response.status})`);
    }
  }
  async function ensureMoveAllowanceOwnerGas(jadapter: JAdapter, owner: string): Promise<void> {
    if (!jadapter.provider || typeof jadapter.provider.getBalance !== 'function') return;
    const minNativeBalance = parseEther('0.01');
    const currentBalance = await jadapter.provider.getBalance(owner);
    if (currentBalance >= minNativeBalance) return;
    logEntityPanelDiagnostic('Move external allowance gas low', {
      owner,
      nativeBalance: currentBalance.toString(),
      minNativeBalance: minNativeBalance.toString(),
    });
    moveProgressLabel = 'Topping up external gas for approval';
    await requestExternalGasFaucet(owner);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const nextBalance = await jadapter.provider.getBalance(owner);
      if (nextBalance >= minNativeBalance) {
        logEntityPanelDiagnostic('Move external allowance gas topped up', {
          owner,
          nativeBalance: nextBalance.toString(),
        });
        return;
      }
      await sleep(200);
    }
    const nextBalance = await jadapter.provider.getBalance(owner);
    throw new Error(`External wallet lacks gas for approve owner=${owner} nativeBalance=${nextBalance}`);
  }
  async function approveMoveExternalAllowance(mode: 'amount' | 'max'): Promise<void> {
    const { jadapter, token, owner, spender } = await getMoveAllowanceContext('move-erc20-allowance-approve');
    const privKey = await getActiveSignerPrivateKey();
    const approvalAmount = mode === 'max'
      ? MaxUint256
      : parsePositiveAssetAmount(moveAllowanceAmount, token);
    const entityId = String(replica?.state?.entityId || tab.entityId || '').trim().toLowerCase();
    if (!entityId) throw new Error('Active entity missing for allowance approval');
    if (typeof token.tokenId !== 'number') throw new Error(`Token id missing for ${token.symbol} allowance approval`);
    moveExecuting = true;
    moveAllowanceSubmittingMode = mode;
    moveProgressLabel = `Approving ${token.symbol} allowance`;
    try {
      await ensureMoveAllowanceOwnerGas(jadapter, owner);
      moveProgressLabel = `Approving ${token.symbol} allowance`;
      await jadapter.approveErc20(privKey, token.address, spender, approvalAmount, {
        entityId,
        tokenId: token.tokenId,
      });
      await fetchExternalTokens(true);
      let confirmedAllowance = readObservedExternalAllowance(owner, token.address, spender) ?? moveAllowanceRaw;
      const confirmationDeadline = Date.now() + 5_000;
      while ((confirmedAllowance === null || confirmedAllowance < approvalAmount) && Date.now() < confirmationDeadline) {
        await sleep(200);
        await fetchExternalTokens(true);
        confirmedAllowance = readObservedExternalAllowance(owner, token.address, spender) ?? moveAllowanceRaw;
      }
      if (confirmedAllowance === null) {
        throw new Error(
          `approveErc20 postcondition missing observed allowance owner=${owner} token=${token.address} spender=${spender}`,
        );
      }
      if (confirmedAllowance < approvalAmount) {
        throw new Error(
          `approveErc20 postcondition failed owner=${owner} token=${token.address} spender=${spender} ` +
          `allowance=${confirmedAllowance} requested=${approvalAmount}`,
        );
      }
      moveAllowanceRaw = confirmedAllowance;
      moveAllowanceError = null;
      moveAllowanceLoading = false;
      toasts.success(
        mode === 'max'
          ? `Approved MAX ${token.symbol}`
          : `Approved ${formatAmount(approvalAmount, token.decimals)} ${token.symbol}`,
      );
    } catch (error) {
      logEntityPanelDiagnostic('Move approve allowance failed', {
        owner,
        token: token.address,
        spender,
        requested: approvalAmount.toString(),
        error: toErrorMessage(error, 'Unknown error'),
      });
      throw error;
    } finally {
      moveProgressLabel = '';
      moveAllowanceSubmittingMode = null;
      moveExecuting = false;
    }
  }
  function getDerivedDeltaForAccount(counterpartyEntityId: string, tokenId: number) {
    const account = counterpartyEntityId ? findLocalAccountByCounterparty(String(replica?.state?.entityId || tab.entityId || ''), replica?.state?.accounts, counterpartyEntityId) : null;
    const entityId = String(replica?.state?.entityId || tab.entityId || '').trim().toLowerCase();
    const counterpartyId = String(counterpartyEntityId || '').trim().toLowerCase();
    if (!account || !entityId || !counterpartyId || !activeXlnFunctions?.deriveDelta) return null;
    const delta = account.deltas?.get?.(tokenId);
    if (!delta) return null;
    return activeXlnFunctions.deriveDelta(delta, isAccountLeftPerspective(entityId, account));
  }
  function getAccountSpendableCapacity(counterpartyEntityId: string, tokenId: number): bigint {
    const derived = getDerivedDeltaForAccount(counterpartyEntityId, tokenId);
    if (!derived) return 0n;
    return derived.outCapacity;
  }
  function isLocalExecutorForWorkspace(counterpartyEntityId: string, account: AccountMachine | null): boolean {
    const workspace = account?.settlementWorkspace;
    const entityId = String(replica?.state?.entityId || tab.entityId || '').trim().toLowerCase();
    const counterparty = String(counterpartyEntityId || '').trim().toLowerCase();
    if (!workspace || workspace.status !== 'ready_to_submit' || !entityId || !counterparty) return false;
    return workspace.executorIsLeft === isAccountLeftPerspective(entityId, account);
  }
  // Faucet: fund entity reserves with test tokens
  function resolveReserveTokenMeta(tokenId: number, symbolHint?: string): { tokenId: number; symbol: string; decimals: number } {
    return resolveReserveTokenMetaFromCatalog({
      tokenId,
      ...(symbolHint === undefined ? {} : { symbolHint }),
      externalTokens,
      getTokenInfo,
    });
  }
  async function resolveCurrentExternalAddress(): Promise<string> {
    const signerId = String(currentSignerId || '').trim();
    if (isAddress(signerId)) return signerId;
    const xln = await getXLN();
    const getCachedSignerPrivateKey = xln.getCachedSignerPrivateKey;
    if (!getCachedSignerPrivateKey) throw new Error('Cached signer key reader unavailable');
    const runtimeEnv = requireRuntimeEnv(actionRuntimeEnv, 'resolve-current-external-address');
    const privKey = getCachedSignerPrivateKey(runtimeEnv, signerId);
    if (!privKey) throw new Error(`No registered signer key for ${signerId}`);
    return new EthersWallet(hexlify(privKey)).address;
  }
  async function withdrawReserveToExternal(tokenId: number, amountOverride?: bigint, recipientEoaOverride?: string): Promise<void> {
    const entityId = replica?.state?.entityId || tab.entityId;
    if (!entityId) {
      notifyUserActionError('reserve-to-external', 'Active entity missing for reserve withdrawal');
      return;
    }
    if (!activeIsLive) {
      toasts.error('Withdraw requires LIVE mode');
      return;
    }
    const info = resolveReserveTokenMeta(tokenId);
    withdrawingExternalToken = info.symbol;
    try {
      const signerId = resolveEntitySigner(entityId, 'reserve-to-external');
      const amount = amountOverride ?? parsePositiveAssetAmount(
        reserveToExternalAmount,
        info,
        onchainReserves.get(tokenId) ?? 0n,
      );
      const externalAddress = recipientEoaOverride || await resolveCurrentExternalAddress();
      await submitEntityInputs([{
        entityId,
        signerId,
        entityTxs: [
          buildReserveToExternalEoaTx(externalAddress, tokenId, amount),
          buildBroadcastTx(),
        ],
      }]);
      pendingAssetBridgeSync = {
        tokenId,
        symbol: info.symbol,
        direction: 'withdraw',
        baselineReserve: onchainReserves.get(tokenId) ?? 0n,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logEntityPanelDiagnostic('Reserve withdraw failed', {
        tokenId,
        amountOverride: amountOverride?.toString() ?? null,
        amountInput: reserveToExternalAmount,
        error: message,
      });
      toasts.error(`Reserve withdraw failed: ${message}`);
      withdrawingExternalToken = null;
    } finally {
    }
  }
  async function reserveToReserve(tokenId: number, amount: bigint, recipientEntityIdOverride?: string): Promise<void> {
    const entityId = String(replica?.state?.entityId || tab.entityId || '').trim().toLowerCase();
    if (!entityId) throw new Error('Active entity missing for reserve transfer');
    if (!activeIsLive) throw new Error('Reserve transfer requires LIVE mode');
    const recipientEntityId = String(recipientEntityIdOverride || moveReserveRecipientEntityId || '').trim().toLowerCase();
    if (!recipientEntityId) throw new Error('Select recipient entity');
    if (recipientEntityId === entityId) throw new Error('Recipient entity must be different from self');
    const signerId = resolveEntitySigner(entityId, 'reserve-to-reserve');
    await submitEntityInputs([{
      entityId,
      signerId,
      entityTxs: [
        buildReserveToReserveTx(recipientEntityId, tokenId, amount),
        buildBroadcastTx(),
      ],
    }]);
  }
  async function faucetReserves(tokenId: number = 1, symbolHint?: string) {
    const entityId = replica?.state?.entityId || tab.entityId;
    if (!entityId) {
      notifyUserActionError('reserve-faucet', 'Active entity missing for reserve faucet');
      return;
    }
    try {
      const requestApiBase = resolveApiBase();
      const tokenMeta = resolveReserveTokenMeta(tokenId, symbolHint);
      const amountStr = tokenMeta.symbol === 'WETH' || tokenMeta.symbol === 'ETH' ? '0.1' : '100';
      const amountWei = parseTokenAmountInput(amountStr, tokenMeta.decimals);
      const currentBalance = onchainReserves.get(tokenMeta.tokenId) ?? 0n;
      const existingForToken = pendingReserveFaucets
        .filter((req) => req.tokenId === tokenMeta.tokenId)
        .sort((a, b) => b.startedAt - a.startedAt)[0];
      const baseExpected = existingForToken ? existingForToken.expectedBalance : currentBalance;
      const expectedBalance = baseExpected + amountWei;
      // Faucet B: Reserve transfer (ALWAYS use prod API, no BrowserVM fake)
      const response = await fetch(`${requestApiBase}/api/faucet/reserve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userEntityId: entityId,
          tokenId: tokenMeta.tokenId,
          tokenSymbol: tokenMeta.symbol,
          amount: amountStr
        })
      });
      const result = await readJsonResponse<FaucetApiResult>(response);
      if (!response.ok || !result?.success) {
        throw new Error(result?.error || `Faucet failed (${response.status})`);
      }
      recordServerIngressReceipt(result);
      // The HTTP response is an acknowledgement, not trusted J-chain evidence.
      // The locally configured watcher observes the reserve log from its bound
      // stack and is the only path allowed to advance Entity J-history.
      pendingReserveFaucets = [...pendingReserveFaucets, {
        tokenId: tokenMeta.tokenId,
        amount: amountWei,
        expectedBalance,
        startedAt: Date.now(),
        symbol: tokenMeta.symbol,
      }];
      toasts.info(`Reserve faucet requested for ${tokenMeta.symbol}. Waiting for on-chain update...`);
    } catch (err) {
      logEntityPanelDiagnostic('Reserve faucet failed', {
        tokenId,
        symbol: symbolHint,
        error: toErrorMessage(err, 'Reserve faucet failed'),
      });
      toasts.error(`Reserve faucet failed: ${(err as Error).message}`);
    }
  }
  async function faucetOffchain(hubEntityId: string, tokenId: number = 1) {
    const entityId = replica?.state?.entityId || tab.entityId;
    if (!entityId) {
      notifyUserActionError('offchain-faucet', 'Active entity missing for offchain faucet');
      return;
    }
    if (!isSameJurisdictionEntityInReplicas(activeReplicas, replica, tab.entityId, entityId, hubEntityId)) {
      toasts.error('Switch to the matching jurisdiction entity before funding that account.');
      return;
    }
    const tokenMeta = resolveReserveTokenMeta(tokenId);
    const pendingKey = faucetPendingKey(hubEntityId, tokenMeta.tokenId);
    if (pendingOffchainFaucetKeys.has(pendingKey)) return;
    pendingOffchainFaucetKeys = new Set([...pendingOffchainFaucetKeys, pendingKey]);
    try {
      const requestApiBase = resolveApiBase();
      const amountStr = tokenMeta.symbol === 'WETH' || tokenMeta.symbol === 'ETH' ? '0.2' : '100';
      const runtimeId = getRuntimeId(actionRuntimeEnv);
      if (!runtimeId) {
        throw new Error('Runtime is not ready yet (missing runtimeId). Re-open runtime and retry.');
      }
      if (!hubEntityId) {
        throw new Error('Offchain faucet requires a target hub account.');
      }
      toasts.info(`Funding ${tokenMeta.symbol} account...`);
      const requestTimeoutMs = OFFCHAIN_FAUCET_REQUEST_TIMEOUT_MS;
      let response: Response | null = null;
      let result: FaucetApiResult | null = null;
      let timeout: ReturnType<typeof setTimeout> | null = null;
      try {
        const controller = new AbortController();
        timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
        response = await fetch(`${requestApiBase}/api/faucet/offchain`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            userEntityId: entityId,
            userRuntimeId: runtimeId,
            hubEntityId,
            tokenId,
            amount: amountStr,
          })
        });
        result = await readJsonResponse<FaucetApiResult>(response);
      } catch (error: unknown) {
        const aborted = error instanceof DOMException && error.name === 'AbortError';
        const message = aborted
          ? `Faucet request timed out after ${requestTimeoutMs}ms`
          : toErrorMessage(error, 'Faucet request failed');
        throw new Error(message);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
      if (!response?.ok || !result?.success) {
        const status = response ? response.status : 'fetch-error';
        const code = typeof result?.code === 'string' ? result.code : '';
        logEntityPanelDiagnostic('Offchain faucet rejected', {
          status,
          code,
          error: result?.error || null,
          details: result?.details || null,
        });
        throw new Error(result?.error || `Faucet failed (${status})`);
      }
      toasts.success(`Faucet accepted: ${amountStr} ${tokenMeta.symbol}.`);
    } catch (err) {
      logEntityPanelDiagnostic('Offchain faucet failed', {
        hubEntityId,
        tokenId,
        error: toErrorMessage(err, 'Offchain faucet failed'),
      });
      toasts.error(`Offchain faucet failed: ${(err as Error).message}`);
    } finally {
      const next = new Set(pendingOffchainFaucetKeys);
      next.delete(pendingKey);
      pendingOffchainFaucetKeys = next;
    }
  }
  function handleAccountFaucet(event: CustomEvent<{ counterpartyId: string; tokenId: number }>) {
    faucetOffchain(event.detail.counterpartyId, event.detail.tokenId);
  }
  async function handleQuickSettleApprove(event: CustomEvent<{ counterpartyId: string; workspaceHash: string }>) {
    const entityId = replica?.state?.entityId || tab.entityId;
    if (!entityId) {
      notifyUserActionError('quick-settle-approve', 'Active entity missing for settlement approval');
      return;
    }
    if (!activeIsLive) {
      toasts.error('Settlement signature requires LIVE mode');
      return;
    }
    try {
      const signerId = resolveEntitySigner(entityId, 'quick-settle-approve');
      if (!signerId) throw new Error('No signer available');
      await submitEntityInputs([buildEntityInput(entityId, signerId, [
        buildSettlementApproveTx(event.detail.counterpartyId, event.detail.workspaceHash),
      ])]);
      toasts.info('Withdrawal signature sent');
    } catch (err) {
      logEntityPanelDiagnostic('Quick settle approve failed', {
        counterpartyId: event.detail.counterpartyId,
        error: toErrorMessage(err, 'Settlement signature failed'),
      });
      toasts.error(`Settlement signature failed: ${(err as Error).message}`);
    }
  }
  function cloneExternalTokenCatalog(tokens: ExternalToken[] | null): ExternalToken[] {
    if (!tokens) return [];
    return tokens.map((token) => ({ ...token, balance: 0n }));
  }
  async function getTokenList(
    jadapter: JAdapter | null | undefined,
    runtimeId: string,
    jurisdiction: string,
  ): Promise<ExternalToken[]> {
    const cacheKey = `${runtimeId}|${jurisdiction}`;
    if (cacheKey === externalTokenCatalogCacheKey && externalTokenCatalogCache !== null) {
      return cloneExternalTokenCatalog(externalTokenCatalogCache);
    }
    let tokens: ExternalToken[] = [];
    let apiError: unknown = null;
    try {
      tokens = await fetchTokenCatalog();
    } catch (error) {
      apiError = error;
    }
    if (tokens.length === 0 && jadapter?.getTokenRegistry) {
      const registry = await jadapter.getTokenRegistry();
      if (registry?.length) {
        tokens = registry.map((t: JTokenRegistryItem) => {
          const decimals = Number(t.decimals);
          if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 255) {
            throw new Error(`TOKEN_CATALOG_DECIMALS_INVALID:${String(t.tokenId)}:${String(t.decimals)}`);
          }
          return {
            symbol: t.symbol,
            address: t.address,
            balance: 0n,
            decimals,
            tokenId: normalizeOptionalTokenId(t.tokenId),
          };
        });
      }
    }
    if (tokens.length === 0) {
      const reason = apiError instanceof Error ? apiError.message : String(apiError || 'empty catalog');
      throw new Error(`TOKEN_CATALOG_UNAVAILABLE:${reason}`, { cause: apiError ?? undefined });
    }
    externalTokenCatalogCacheKey = cacheKey;
    externalTokenCatalogCache = tokens.map((token) => ({ ...token, balance: 0n }));
    return cloneExternalTokenCatalog(externalTokenCatalogCache);
  }
  function resolveExternalWalletSpender(
    jadapter: JAdapter | null | undefined,
    jurisdictionName: string,
  ): string {
    const adapterDepository = String(jadapter?.addresses?.depository || '').trim();
    if (isAddress(adapterDepository) && adapterDepository !== ZeroAddress) return adapterDepository;
    const normalizedName = String(jurisdictionName || '').trim().toLowerCase();
    for (const jurisdiction of panelView.jurisdictions ?? []) {
      const name = String((jurisdiction as { name?: unknown })?.name || '').trim().toLowerCase();
      if (normalizedName && name && name !== normalizedName) continue;
      const depository = String((jurisdiction as { depositoryAddress?: unknown })?.depositoryAddress || '').trim();
      if (isAddress(depository) && depository !== ZeroAddress) return depository;
    }
    return '';
  }
  function buildOnchainReserves(
    reserves: Map<number | string, bigint> | undefined,
    tokens: ExternalToken[],
  ): Map<number, bigint> {
    const next = new Map<number, bigint>();
    const catalogTokenIds = tokens
      .map(t => t.tokenId)
      .filter((id): id is number => typeof id === 'number' && id > 0);
    const defaultTokenIds = catalogTokenIds.length > 0 ? catalogTokenIds : [1, 2, 3];
    for (const tokenId of defaultTokenIds) {
      next.set(tokenId, 0n);
    }
    if (reserves && typeof reserves.entries === 'function') {
      for (const [tokenId, amount] of reserves.entries()) {
        const numericId = Number(tokenId);
        if (!Number.isNaN(numericId)) next.set(numericId, amount);
      }
    }
    return next;
  }
  $: {
    activeEnv;
    envRevision;
    replica;
    currentSignerId;
    tab.entityId;
    tab.signerId;
    onchainReserves = buildOnchainReserves(getCurrentLiveEntityReplica()?.state?.reserves, externalTokens);
  }
  $: {
    if (pendingAssetBridgeSync && !resolvingAssetBridgeSync) {
      const currentReserve = onchainReserves.get(pendingAssetBridgeSync.tokenId) ?? 0n;
      const reserveMoved = pendingAssetBridgeSync.direction === 'deposit'
        ? currentReserve > pendingAssetBridgeSync.baselineReserve
        : currentReserve < pendingAssetBridgeSync.baselineReserve;
      if (reserveMoved) {
        resolvingAssetBridgeSync = true;
        const sync = pendingAssetBridgeSync;
        void (async () => {
          try {
            await fetchExternalTokens();
          } finally {
            if (sync.direction === 'deposit' && depositingToken === sync.symbol) depositingToken = null;
            if (sync.direction === 'withdraw' && withdrawingExternalToken === sync.symbol) withdrawingExternalToken = null;
            pendingAssetBridgeSync = null;
            resolvingAssetBridgeSync = false;
          }
        })();
      }
    }
  }
  $: {
    const pending = pendingAssetAutoC2Rs[0];
    if (pending && !resolvingAssetAutoC2R) {
      const currentAccount =
        workspaceAccountId &&
        workspaceAccountId.toLowerCase() === pending.counterpartyEntityId.toLowerCase()
          ? workspaceAccount
          : findLocalAccountByCounterparty(
              String(replica?.state?.entityId || tab.entityId || ''),
              replica?.state?.accounts,
              pending.counterpartyEntityId,
            );
      const sentBatchPending = !!replica?.state?.jBatchState?.sentBatch;
      if (currentAccount?.settlementWorkspace?.status === 'submitted') {
        pendingAssetAutoC2Rs = pendingAssetAutoC2Rs.filter((entry) => entry !== pending);
        resolvingAssetAutoC2R = false;
        refreshPendingCollateralFundingToken();
      } else if (activeIsLive && !sentBatchPending && isLocalExecutorForWorkspace(pending.counterpartyEntityId, currentAccount)) {
        resolvingAssetAutoC2R = true;
        void (async () => {
          try {
            const entityId = replica?.state?.entityId || tab.entityId;
            if (!entityId) throw new Error('Active entity missing for collateral-to-reserve auto execution');
            const signerId = resolveEntitySigner(entityId, 'asset-c2r-auto-execute');
            await submitEntityInputs([
              buildEntityInput(entityId, signerId, buildMovePostSettleTxs(entityId, pending)),
            ]);
            collateralToReserveAmount = '';
            toasts.info(
              pending.broadcast
                ? `Collateral → Reserve pending on-chain confirmation for ${pending.symbol}.`
                : `Collateral → Reserve added to draft batch for ${pending.symbol}.`,
            );
          } catch (err) {
            logEntityPanelDiagnostic('Asset C→R auto-execute failed', {
              tokenId: pending.tokenId,
              counterpartyEntityId: pending.counterpartyEntityId,
              error: toErrorMessage(err, 'Unknown error'),
            });
            toasts.error(`Collateral → Reserve failed: ${toErrorMessage(err, 'Unknown error')}`);
          } finally {
            pendingAssetAutoC2Rs = pendingAssetAutoC2Rs.filter((entry) => entry !== pending);
            resolvingAssetAutoC2R = false;
            refreshPendingCollateralFundingToken();
          }
        })();
      }
    }
  }
  $: transferableAssetOptions = externalTokens.filter(isReserveTransferToken);
  $: selectedExternalToReserveToken = findReserveTransferTokenBySymbol(externalToReserveSymbol);
  $: selectedReserveToCollateralToken = findReserveTransferTokenBySymbol(reserveToCollateralSymbol);
  $: selectedCollateralToReserveToken = findReserveTransferTokenBySymbol(collateralToReserveSymbol);
  $: selectedReserveToExternalToken = findReserveTransferTokenBySymbol(reserveToExternalSymbol);
  $: selectedSendAssetToken = findExternalTokenBySymbol(sendAssetSymbol);
  $: moveAssetOptions = assetLedgerRows
    .filter((row) => {
      const symbol = String(row.symbol || '').trim();
      if (!symbol) return false;
      const externalToken = findExternalTokenBySymbol(symbol);
      const reserveToken = findReserveTransferTokenBySymbol(symbol);
      if (moveFromEndpoint === 'external') {
        if (!externalToken) return false;
        if (moveToEndpoint === 'external') return true;
        return !!reserveToken;
      }
      return !!reserveToken;
    })
    .map((row) => ({ symbol: row.symbol }));
  $: selectedMoveExternalToken = findExternalTokenBySymbol(moveAssetSymbol);
  $: selectedMoveTransferToken = findReserveTransferTokenBySymbol(moveAssetSymbol);
  $: workspaceAccount = (() => {
    const entityId = String(replica?.state?.entityId || tab.entityId || '').trim();
    if (!entityId || !workspaceAccountId || !replica?.state?.accounts) return null;
    return findLocalAccountByCounterparty(entityId, replica.state.accounts, workspaceAccountId);
  })();
  $: accountSpendableByToken = (() => {
    activeEnv;
    envRevision;
    const totals = new Map<number, bigint>();
    const currentReplica = getCurrentLiveEntityReplica();
    const accounts = currentReplica?.state?.accounts;
    const entityId = String(currentReplica?.state?.entityId || tab.entityId || '').toLowerCase();
    if (!accounts || !entityId || !activeXlnFunctions?.deriveDelta) return totals;
    for (const [counterpartyId, account] of accounts.entries()) {
      if (!(account?.deltas instanceof Map)) continue;
      const isLeftEntity = entityId < String(counterpartyId || '').toLowerCase();
      for (const [tokenId, delta] of account.deltas.entries()) {
        const numericTokenId = Number(tokenId);
        if (!Number.isFinite(numericTokenId) || numericTokenId <= 0) continue;
        const derived = activeXlnFunctions.deriveDelta(delta, isLeftEntity);
        const spendable = derived?.outCapacity ?? 0n;
        if (spendable <= 0n) continue;
        totals.set(numericTokenId, (totals.get(numericTokenId) ?? 0n) + spendable);
      }
    }
    return totals;
  })();
  $: assetLedgerRows = (() => {
    const rows = new Map<string, AssetLedgerRow>();
    for (const token of externalTokens) {
      const reserveBalance = isReserveTransferToken(token)
        ? (onchainReserves.get(token.tokenId) ?? 0n)
        : 0n;
      const accountBalance = isReserveTransferToken(token)
        ? (accountSpendableByToken.get(token.tokenId) ?? 0n)
        : 0n;
      const externalUsd = getExternalValue(token);
      const reserveUsd = isReserveTransferToken(token)
        ? getAssetValue(token.tokenId, reserveBalance, token.symbol)
        : 0;
      const accountUsd = isReserveTransferToken(token)
        ? getAssetValue(token.tokenId, accountBalance, token.symbol)
        : 0;
      rows.set(getExternalTokenIdentityKey(token), {
        symbol: token.symbol,
        address: token.address,
        decimals: token.decimals,
        tokenId: token.tokenId,
        isNative: token.symbol === 'ETH' || token.address === ZeroAddress,
        externalBalance: token.balance,
        reserveBalance,
        accountBalance,
        externalUsd,
        reserveUsd,
        accountUsd,
        totalUsd: externalUsd + reserveUsd + accountUsd,
        ...(token.readError ? { externalError: token.readError } : {}),
      });
    }
    for (const [tokenId, reserveBalance] of onchainReserves.entries()) {
      const numericId = Number(tokenId);
      if (!Number.isFinite(numericId) || numericId <= 0) continue;
      const existing = Array.from(rows.values()).find((row) => row.tokenId === numericId);
      if (existing) continue;
      const info = resolveReserveTokenMeta(numericId);
      const reserveUsd = getAssetValue(numericId, reserveBalance, info.symbol);
      rows.set(`token:${numericId}`, {
        symbol: info.symbol,
        address: '',
        decimals: info.decimals,
        tokenId: numericId,
        isNative: false,
        externalBalance: 0n,
        reserveBalance,
        accountBalance: accountSpendableByToken.get(numericId) ?? 0n,
        externalUsd: 0,
        reserveUsd,
        accountUsd: getAssetValue(numericId, accountSpendableByToken.get(numericId) ?? 0n, info.symbol),
        totalUsd: reserveUsd + getAssetValue(numericId, accountSpendableByToken.get(numericId) ?? 0n, info.symbol),
      });
    }
    for (const [tokenId, accountBalance] of accountSpendableByToken.entries()) {
      const numericId = Number(tokenId);
      if (!Number.isFinite(numericId) || numericId <= 0) continue;
      const existing = Array.from(rows.values()).find((row) => row.tokenId === numericId);
      if (existing) continue;
      const info = resolveReserveTokenMeta(numericId);
      const accountUsd = getAssetValue(numericId, accountBalance, info.symbol);
      rows.set(`token:${numericId}`, {
        symbol: info.symbol,
        address: '',
        decimals: info.decimals,
        tokenId: numericId,
        isNative: false,
        externalBalance: 0n,
        reserveBalance: 0n,
        accountBalance,
        externalUsd: 0,
        reserveUsd: 0,
        accountUsd,
        totalUsd: accountUsd,
      });
    }
    const nativeAssetKey = `address:${ZeroAddress.toLowerCase()}`;
    if (!rows.has(nativeAssetKey)) {
      rows.set(nativeAssetKey, {
        symbol: 'ETH',
        address: ZeroAddress,
        decimals: 18,
        tokenId: undefined,
        isNative: true,
        externalBalance: 0n,
        reserveBalance: 0n,
        accountBalance: 0n,
        externalUsd: 0,
        reserveUsd: 0,
        accountUsd: 0,
        totalUsd: 0,
      });
    }
    return Array.from(rows.values()).sort((left, right) => compareTokenSymbols(left.symbol, right.symbol));
  })();
  $: assetLedgerTotals = assetLedgerRows.reduce<AssetLedgerTotals>(
    (totals, row) => {
      totals.externalUsd += row.externalUsd;
      totals.reserveUsd += row.reserveUsd;
      totals.accountUsd += row.accountUsd;
      return totals;
    },
    { externalUsd: 0, reserveUsd: 0, accountUsd: 0 },
  );
  $: assetLedgerGrandTotal = assetLedgerTotals.externalUsd + assetLedgerTotals.reserveUsd + assetLedgerTotals.accountUsd;
  $: {
    envRevision;
    const symbol = String(moveAssetSymbol || '').trim().toUpperCase();
    const row = symbol ? findAssetLedgerRowBySymbol(moveAssetSymbol) : null;
    const selectedDecimals = row?.decimals
      ?? selectedMoveExternalToken?.decimals
      ?? selectedMoveTransferToken?.decimals;
    const nextState: MoveUiState = {
      ledgerRow: row,
      displayBalances: row
        ? {
            external: row.externalBalance,
            reserve: row.reserveBalance,
            account: row.accountBalance,
          }
        : { external: 0n, reserve: 0n, account: 0n },
      displayDecimals: selectedDecimals === undefined
        ? 0
        : requireTokenDecimals(selectedDecimals, `asset:${moveAssetSymbol}`),
      sourceAvailableBalance: computeMoveSourceAvailableBalance(row, selectedMoveTransferToken),
    };
    moveUiState = nextState;
  }
  $: {
    const preferred = choosePreferredAssetSymbol(externalTokens);
    const preferredFaucetSymbol =
      assetLedgerRows.find((row) => !row.isNative && typeof row.tokenId === 'number' && row.tokenId > 0)?.symbol
      ?? preferred;
    if (!findAssetLedgerRowBySymbol(faucetAssetSymbol)) faucetAssetSymbol = preferredFaucetSymbol;
    if (!findExternalTokenBySymbol(sendAssetSymbol)) sendAssetSymbol = preferred;
    if (!findReserveTransferTokenBySymbol(externalToReserveSymbol)) externalToReserveSymbol = choosePreferredAssetSymbol(transferableAssetOptions);
    if (!findReserveTransferTokenBySymbol(reserveToCollateralSymbol)) reserveToCollateralSymbol = choosePreferredAssetSymbol(transferableAssetOptions);
    if (!findReserveTransferTokenBySymbol(collateralToReserveSymbol)) collateralToReserveSymbol = choosePreferredAssetSymbol(transferableAssetOptions);
    if (!findReserveTransferTokenBySymbol(reserveToExternalSymbol)) reserveToExternalSymbol = choosePreferredAssetSymbol(transferableAssetOptions);
    const movePreferred = choosePreferredMoveAssetSymbol();
    if (
      !moveAssetOptions.some((token) => token.symbol.toUpperCase() === String(moveAssetSymbol || '').trim().toUpperCase())
    ) {
      moveAssetSymbol = movePreferred;
    }
  }
  $: {
    const moveAmountContextKey = [
      assetWorkspaceTab,
      accountWorkspaceTab,
      moveFromEndpoint,
      moveToEndpoint,
      moveAssetSymbol,
      getCurrentMoveSourceAccountId(),
    ].join('|');
    if (moveAmountContextKey !== lastMoveAmountContextKey) {
      lastMoveAmountContextKey = moveAmountContextKey;
    }
  }
  $: if (pendingReserveFaucets.length > 0) {
    const now = Date.now();
    const { remaining, received, timedOut } = reconcilePendingReserveFaucets(
      pendingReserveFaucets,
      now,
      (tokenId) => onchainReserves.get(tokenId) ?? 0n,
    );
    for (const { req } of received) {
      toasts.success(`Received ${formatAmount(req.amount, getTokenInfo(req.tokenId).decimals)} ${req.symbol} in reserves!`);
    }
    for (const req of timedOut) {
      toasts.error(`Reserve faucet timed out for ${req.symbol}. Check server logs.`);
    }
    if (remaining.length !== pendingReserveFaucets.length) {
      pendingReserveFaucets = remaining;
    }
  }
  const EXTERNAL_WALLET_REQUEST_TIMEOUT_MS = 5_000;
  // Known token addresses for RPC mode (from deploy-tokens.cjs on anvil)
  async function fetchTokenCatalog(): Promise<ExternalToken[]> {
    const requestApiBase = resolveApiBase();
    const response = await fetch(`${requestApiBase}/api/tokens`, {
      signal: AbortSignal.timeout(EXTERNAL_WALLET_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`TOKEN_CATALOG_HTTP_FAILED:${response.status}`);
    const data = await readJsonResponse<TokenCatalogResponse>(response);
    const tokens = Array.isArray(data?.tokens) ? data.tokens : [];
    return tokens.map((t: TokenCatalogItem) => {
      const decimals = Number(t.decimals);
      if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 255) {
        throw new Error(`TOKEN_CATALOG_DECIMALS_INVALID:${String(t.tokenId)}:${String(t.decimals)}`);
      }
      return {
        symbol: t.symbol,
        address: t.address,
        balance: 0n,
        decimals,
        tokenId: normalizeOptionalTokenId(t.tokenId),
      };
    });
  }
  function readExternalWalletState(
    tokenList: ExternalToken[],
    owner: string,
    allowanceReads: ExternalAllowanceRead[],
  ): ExternalWalletReadResult | null {
    const externalWallet = getCurrentLiveEntityReplica()?.state?.externalWallet;
    if (!externalWallet) return null;
    const ownerKey = String(owner || '').trim().toLowerCase();
    const balancesByToken = externalWallet.balances?.get?.(ownerKey);
    if (!balancesByToken) return null;
    const nativeRecord = balancesByToken.get(ZeroAddress.toLowerCase());
    if (!nativeRecord) return null;
    const balances = tokenList.map((token) => {
      const tokenKey = String(token.address || '').trim().toLowerCase();
      const record = balancesByToken.get(tokenKey);
      if (!record) return null;
      return record.balance;
    });
    if (balances.some((balance) => balance === null)) return null;
    const allowancesBySpender = externalWallet.allowances?.get?.(ownerKey);
    const allowanceValues = allowanceReads.map((read) => {
      const key = `${String(read.tokenAddress || '').trim().toLowerCase()}:${String(read.spender || '').trim().toLowerCase()}`;
      const record = allowancesBySpender?.get(key);
      if (!record) return null;
      return record.allowance;
    });
    if (allowanceValues.some((allowance) => allowance === null)) return null;
    const sourceHeights = [
      Number(nativeRecord?.jHeight ?? 0),
      ...[...balancesByToken.values()].map((record) => Number(record?.jHeight ?? 0)),
      ...[...(allowancesBySpender?.values?.() ?? [])].map((record) => Number(record?.jHeight ?? 0)),
    ].filter((height) => Number.isFinite(height) && height > 0);
    const sourceHeight = sourceHeights.length > 0 ? Math.max(...sourceHeights) : undefined;
    return {
      nativeBalance: nativeRecord?.balance ?? 0n,
      balances: balances as bigint[],
      allowanceValues: allowanceValues as bigint[],
      ...(sourceHeight !== undefined ? { sourceHeight } : {}),
    };
  }
  function readObservedExternalAllowance(owner: string, tokenAddress: string, spender: string): bigint | null {
    const externalWallet = getCurrentLiveEntityReplica()?.state?.externalWallet;
    const ownerKey = String(owner || '').trim().toLowerCase();
    const tokenKey = String(tokenAddress || '').trim().toLowerCase();
    const spenderKey = String(spender || '').trim().toLowerCase();
    if (!externalWallet || !ownerKey || !tokenKey || !spenderKey) return null;
    return externalWallet.allowances
      ?.get?.(ownerKey)
      ?.get?.(`${tokenKey}:${spenderKey}`)
      ?.allowance ?? null;
  }
  function isExternalWalletSnapshotTransportFailure(message: string): boolean {
    const normalized = message.toLowerCase();
    return normalized.includes('failed to fetch')
      || normalized.includes('load failed')
      || normalized.includes('networkerror')
      || normalized.includes('network error')
      || normalized.includes('timeout');
  }
  async function requestExternalWalletSnapshot(
    entityId: string,
    owner: string,
    tokenList: ExternalToken[],
    allowanceReads: ExternalAllowanceRead[],
    jadapter?: JAdapter | null,
  ): Promise<ExternalWalletReadResult | null> {
    const tokenAddresses = tokenList.map((token) => token.address).filter((address) => isAddress(address));
    if (jadapter?.readWalletSnapshot && jadapter?.provider) {
      const source = await readExternalWalletSnapshotSource(jadapter);
      const snapshot = await jadapter.readWalletSnapshot({
        owner,
        tokenAddresses,
        allowances: allowanceReads,
        includeNativeBalance: true,
        blockTag: source.sourceHeight,
      });
      assertExternalSnapshotCount(snapshot.tokenBalances, tokenAddresses.length, 'tokenBalances');
      assertExternalSnapshotCount(snapshot.allowances, allowanceReads.length, 'allowances');
      const nativeBalance = requireExternalSnapshotBigInt(snapshot.nativeBalance, 'nativeBalance');
      const tokenErrorByAddress = new Map(
        (snapshot.tokenErrors ?? []).map((entry) => [
          String(entry.tokenAddress || '').trim().toLowerCase(),
          String(entry.error || 'EXTERNAL_WALLET_SNAPSHOT_TOKEN_READ_FAILED'),
        ]),
      );
      const allowanceErrorByKey = new Map(
        (snapshot.allowanceErrors ?? []).map((entry) => [
          `${String(entry.tokenAddress || '').trim().toLowerCase()}:${String(entry.spender || '').trim().toLowerCase()}`,
          String(entry.error || 'EXTERNAL_WALLET_SNAPSHOT_ALLOWANCE_READ_FAILED'),
        ]),
      );
      const tokenBalances = tokenAddresses.map((tokenAddress, index) => {
        const normalizedTokenAddress = String(tokenAddress || '').trim().toLowerCase();
        const token = tokenList.find((candidate) =>
          String(candidate.address || '').trim().toLowerCase() === normalizedTokenAddress
        );
        const tokenError = tokenErrorByAddress.get(normalizedTokenAddress);
        return {
          tokenAddress: normalizedTokenAddress,
          ...(typeof token?.tokenId === 'number' ? { tokenId: token.tokenId } : {}),
          balance: requireExternalSnapshotBigInt(snapshot.tokenBalances[index], `tokenBalance:${tokenAddress}`).toString(),
          ...(tokenError ? { error: tokenError } : {}),
        };
      });
      const allowances = allowanceReads.map((entry, index) => {
        const tokenAddress = String(entry.tokenAddress || '').trim().toLowerCase();
        const spender = String(entry.spender || '').trim().toLowerCase();
        const allowanceError = allowanceErrorByKey.get(`${tokenAddress}:${spender}`);
        return {
          tokenAddress,
          spender,
          allowance: requireExternalSnapshotBigInt(snapshot.allowances[index], `allowance:${entry.tokenAddress}:${entry.spender}`).toString(),
          ...(allowanceError ? { error: allowanceError } : {}),
        };
      });
      const balanceByToken = new Map(tokenBalances.map((entry) => [entry.tokenAddress, BigInt(entry.balance)]));
      const allowanceByKey = new Map(allowances.map((entry) => [
        `${entry.tokenAddress}:${entry.spender}`,
        BigInt(entry.allowance),
      ]));
      return {
        nativeBalance,
        balances: tokenList.map((token) => balanceByToken.get(String(token.address || '').trim().toLowerCase()) ?? 0n),
        allowanceValues: allowanceReads.map((read) =>
          allowanceByKey.get(`${String(read.tokenAddress || '').trim().toLowerCase()}:${String(read.spender || '').trim().toLowerCase()}`) ?? 0n
        ),
        ...source,
        ...(snapshot.tokenErrors?.length ? { tokenErrors: snapshot.tokenErrors } : {}),
        ...(snapshot.allowanceErrors?.length ? { allowanceErrors: snapshot.allowanceErrors } : {}),
      };
    }
    const requestApiBase = resolveApiBase();
    const response = await fetch(`${requestApiBase}/api/external-wallet/snapshot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(EXTERNAL_WALLET_REQUEST_TIMEOUT_MS),
      body: JSON.stringify({
        entityId,
        owner,
        tokenAddresses,
        allowances: allowanceReads,
      }),
    });
    const data = await readJsonResponse<ExternalWalletSnapshotResponse>(response);
    if (!response.ok || !data?.success) {
      throw new Error(data?.error || `External wallet snapshot failed (${response.status})`);
    }
    // Snapshot JSON is display data only. A point-in-time state read does not
    // prove the complete log set for its block, so it must never close a
    // consensus J-prefix. Canonical state changes arrive through the watcher.
    const balanceByToken = new Map(
      (data.tokenBalances ?? []).filter((entry) => !entry.error).map((entry) => [
        String(entry.tokenAddress || '').trim().toLowerCase(),
        BigInt(String(entry.balance ?? '0')),
      ]),
    );
    const allowanceByKey = new Map(
      (data.allowances ?? []).filter((entry) => !entry.error).map((entry) => [
        `${String(entry.tokenAddress || '').trim().toLowerCase()}:${String(entry.spender || '').trim().toLowerCase()}`,
        BigInt(String(entry.allowance ?? '0')),
      ]),
    );
    return {
      nativeBalance: BigInt(String(data.nativeBalance ?? '0')),
      balances: tokenList.map((token) => balanceByToken.get(String(token.address || '').trim().toLowerCase()) ?? 0n),
      allowanceValues: allowanceReads.map((read) =>
        allowanceByKey.get(`${String(read.tokenAddress || '').trim().toLowerCase()}:${String(read.spender || '').trim().toLowerCase()}`) ?? 0n
      ),
      ...(data.sourceHeight !== undefined || data.blockNumber !== undefined
        ? { sourceHeight: Number(data.sourceHeight ?? data.blockNumber) }
        : {}),
      ...(data.sourceHash ?? data.blockHash ? { sourceHash: String(data.sourceHash ?? data.blockHash) } : {}),
      ...(data.finalityDepth !== undefined ? { finalityDepth: Number(data.finalityDepth) } : {}),
      ...(data.headBlockNumber !== undefined ? { headBlockNumber: Number(data.headBlockNumber) } : {}),
      ...(data.tokenErrors?.length
        ? { tokenErrors: data.tokenErrors.map((entry) => ({
            tokenAddress: String(entry.tokenAddress || '').trim().toLowerCase(),
            error: String(entry.error || 'EXTERNAL_WALLET_SNAPSHOT_TOKEN_READ_FAILED'),
          })) }
        : {}),
      ...(data.allowanceErrors?.length
        ? { allowanceErrors: data.allowanceErrors.map((entry) => ({
            tokenAddress: String(entry.tokenAddress || '').trim().toLowerCase(),
            spender: String(entry.spender || '').trim().toLowerCase(),
            error: String(entry.error || 'EXTERNAL_WALLET_SNAPSHOT_ALLOWANCE_READ_FAILED'),
          })) }
        : {}),
    };
  }
  function buildExternalWalletStateSyncSignature(): string {
    const ownerKey = String(resolveSelfEoaAddress() || '').trim().toLowerCase();
    const externalWallet = getCurrentLiveEntityReplica()?.state?.externalWallet;
    if (!ownerKey || !externalWallet) return '';
    const balancesByToken = externalWallet.balances?.get?.(ownerKey);
    const allowancesBySpender = externalWallet.allowances?.get?.(ownerKey);
    if (!balancesByToken && !allowancesBySpender) return '';
    const balances = balancesByToken
      ? [...balancesByToken.entries()]
          .map(([token, record]) => `${token}:${record.balance.toString()}:${record.jHeight}:${record.transactionHash}`)
          .sort()
          .join(',')
      : '';
    const allowances = allowancesBySpender
      ? [...allowancesBySpender.entries()]
          .map(([key, record]) => `${key}:${record.allowance.toString()}:${record.jHeight}:${record.transactionHash}`)
          .sort()
          .join(',')
      : '';
    return `${ownerKey}|${balances}|${allowances}`;
  }
  // Fetch external tokens (ERC20 balances for signer) - works for both BrowserVM and RPC modes
  async function fetchExternalTokens(forceSnapshot = false) {
    if (externalFetchInFlight) {
      return await externalFetchInFlight;
    }
    externalFetchInFlight = (async () => {
      const signerId = String(currentSignerId || '').trim();
      const owner = resolveSelfEoaAddress();
      const runtimeId = String(panelView.runtimeId || '').trim();
      const jurisdiction = String(currentEntityJurisdictionName || '').trim();
      const fetchKey = `${owner}|${runtimeId}|${jurisdiction}`;
      externalTokensLoading = true;
      if (!signerId || !isAddress(owner)) {
        externalTokens = [];
        externalWalletSnapshotSource = null;
        if (moveAllowanceRouteEnabled) {
          moveAllowanceRaw = null;
          moveAllowanceError = 'Active signer EOA missing';
          moveAllowanceLoading = false;
        }
        externalTokensLoading = false;
        return;
      }
      try {
        const envAtStart = getRuntimeEnv(actionRuntimeEnv);
        const xln = envAtStart ? await getXLN() : null;
        const jadapter = envAtStart && xln ? getCurrentEntityJAdapter(xln, envAtStart, 'fetch-external-tokens') : null;
        const tokenList = await getTokenList(jadapter, runtimeId, jurisdiction);
        const entityId = resolveSelfEntityId();
        const spender = resolveExternalWalletSpender(jadapter, jurisdiction);
        const allowanceReads = moveAllowanceRouteEnabled && isAddress(spender) && spender !== ZeroAddress
          ? tokenList
              .filter((token) => isAddress(token.address) && token.address !== ZeroAddress)
              .map((token) => ({ tokenAddress: token.address, spender }))
          : [];
        const selectedAllowanceIndex = allowanceReads.findIndex((read) => {
          const selected = tokenList.find((token) =>
            String(token.symbol || '').trim().toUpperCase() === String(moveAssetSymbol || '').trim().toUpperCase() &&
            String(token.address || '').trim().toLowerCase() === String(read.tokenAddress || '').trim().toLowerCase()
          );
          return Boolean(selected);
        });
        if (moveAllowanceRouteEnabled) {
          moveAllowanceLoading = allowanceReads.length > 0 && moveAllowanceRaw === null;
          moveAllowanceError = null;
        }
        let nativeBalance = 0n;
        let balances: bigint[] = tokenList.map(() => 0n);
        let allowanceValues: bigint[] = [];
        let snapshotSource: ExternalWalletSnapshotSource | null = null;
        let tokenErrors: ExternalWalletReadResult['tokenErrors'] = [];
        const observed = !forceSnapshot
          ? readExternalWalletState(tokenList, owner, allowanceReads)
          : null;
        if (observed) {
          nativeBalance = observed.nativeBalance;
          balances = observed.balances;
          allowanceValues = observed.allowanceValues;
          if (observed.sourceHeight !== undefined) {
            snapshotSource = {
              sourceHeight: observed.sourceHeight,
              ...(externalWalletSnapshotSource?.sourceHeight === observed.sourceHeight && externalWalletSnapshotSource.sourceHash
                ? { sourceHash: externalWalletSnapshotSource.sourceHash }
                : {}),
              ...(externalWalletSnapshotSource?.sourceHeight === observed.sourceHeight && externalWalletSnapshotSource.finalityDepth !== undefined
                ? { finalityDepth: externalWalletSnapshotSource.finalityDepth }
                : {}),
              ...(externalWalletSnapshotSource?.sourceHeight === observed.sourceHeight && externalWalletSnapshotSource.headBlockNumber !== undefined
                ? { headBlockNumber: externalWalletSnapshotSource.headBlockNumber }
                : {}),
            };
          }
        } else if (entityId) {
          const snapshot = await requestExternalWalletSnapshot(
            entityId,
            owner,
            tokenList,
            allowanceReads,
            jadapter,
          );
          if (!snapshot) {
            externalTokensLoading = false;
            if (moveAllowanceRouteEnabled) moveAllowanceLoading = false;
            return;
          }
          nativeBalance = snapshot.nativeBalance;
          balances = snapshot.balances;
          allowanceValues = snapshot.allowanceValues;
          tokenErrors = snapshot.tokenErrors ?? [];
          if (snapshot.sourceHeight !== undefined) {
            snapshotSource = {
              sourceHeight: snapshot.sourceHeight,
              ...(snapshot.sourceHash ? { sourceHash: snapshot.sourceHash } : {}),
              ...(snapshot.finalityDepth !== undefined ? { finalityDepth: snapshot.finalityDepth } : {}),
              ...(snapshot.headBlockNumber !== undefined ? { headBlockNumber: snapshot.headBlockNumber } : {}),
            };
          }
        } else {
          throw new Error('Active entity missing for external wallet snapshot');
        }
        balances.forEach((balance: bigint, idx: number) => {
          if (tokenList[idx]) tokenList[idx].balance = balance;
        });
        const tokenErrorByAddress = new Map(
          (tokenErrors ?? []).map((entry) => [
            String(entry.tokenAddress || '').trim().toLowerCase(),
            String(entry.error || 'EXTERNAL_WALLET_SNAPSHOT_TOKEN_READ_FAILED'),
          ]),
        );
        tokenList.forEach((token) => {
          const error = tokenErrorByAddress.get(String(token.address || '').trim().toLowerCase());
          if (error) {
            token.readError = error;
          } else {
            delete token.readError;
          }
        });
        const runtimeIdNow = panelView.runtimeId;
        const jurisdictionNow = String(currentEntityJurisdictionName || '');
        const currentKey = `${resolveSelfEoaAddress()}|${String(runtimeIdNow || '').trim()}|${jurisdictionNow.trim()}`;
        if (currentKey === fetchKey) {
          externalWalletSnapshotSource = snapshotSource;
          externalTokens = sortExternalTokens([
            {
              symbol: 'ETH',
              address: ZeroAddress,
              balance: nativeBalance,
              decimals: 18,
              tokenId: 0,
            },
            ...tokenList,
          ]);
          if (moveAllowanceRouteEnabled) {
            moveAllowanceRaw = selectedAllowanceIndex >= 0 ? (allowanceValues[selectedAllowanceIndex] ?? 0n) : null;
            moveAllowanceError = null;
            moveAllowanceLoading = false;
          }
          externalTokensLoading = false;
        }
      } catch (err) {
        const message = toErrorMessage(err, '');
        if (
          message.includes('ENTITY_JURISDICTION_MISSING') ||
          message.includes('ENTITY_JURISDICTION_UNAVAILABLE') ||
          message.includes('J-adapter not available')
        ) {
          externalTokens = [];
          externalWalletSnapshotSource = null;
          if (moveAllowanceRouteEnabled) {
            moveAllowanceRaw = null;
            moveAllowanceError = null;
            moveAllowanceLoading = false;
          }
          externalTokensLoading = false;
          return;
        }
        if (isExternalWalletSnapshotTransportFailure(message)) {
          logEntityPanelDiagnostic('External token snapshot unavailable', { error: message });
        } else {
          logEntityPanelDiagnostic('Failed to fetch external tokens', { error: message });
        }
        externalWalletSnapshotSource = null;
        if (moveAllowanceRouteEnabled) {
          moveAllowanceRaw = null;
          moveAllowanceError = toErrorMessage(err, 'Failed to read wallet snapshot');
          moveAllowanceLoading = false;
        }
        externalTokensLoading = false;
      }
    })().finally(() => {
      externalFetchInFlight = null;
    });
    return await externalFetchInFlight;
  }
  async function getActiveSignerPrivateKey(): Promise<Uint8Array> {
    const signerId = String(currentSignerId || '').trim();
    if (!signerId) throw new Error('No active signer selected');
    const xln = await getXLN();
    const getCachedSignerPrivateKey = xln.getCachedSignerPrivateKey;
    if (!getCachedSignerPrivateKey) throw new Error('Cached signer key reader unavailable');
    const runtimeEnv = requireRuntimeEnv(actionRuntimeEnv, 'active-signer-private-key');
    const privKey = getCachedSignerPrivateKey(runtimeEnv, signerId);
    if (!privKey) throw new Error(`No registered signer key for ${signerId}`);
    return privKey;
  }
  async function sendExternalAsset(): Promise<void> {
    const token = requireExternalTokenBySymbol(sendAssetSymbol);
    const recipient = sendAssetRecipient.trim();
    if (!isAddress(recipient)) throw new Error('Recipient must be a valid EOA address');
    const amount = parsePositiveAssetAmount(sendAssetAmount, token, token.balance);
    const xln = await getXLN();
    const jadapter = getCurrentEntityJAdapter(xln, requireRuntimeEnv(actionRuntimeEnv, 'send-external-asset'), 'send-external-asset');
    const privKey = await getActiveSignerPrivateKey();
    sendingExternalToken = token.symbol;
    try {
      if (token.address === ZeroAddress) {
        await jadapter.transferNative(privKey, recipient, amount);
      } else {
        await jadapter.transferErc20(privKey, token.address, recipient, amount);
      }
      sendAssetAmount = '';
      toasts.success(`Sent ${token.symbol}`);
      if (token.address === ZeroAddress) {
        void fetchExternalTokens(true);
      }
    } finally {
      sendingExternalToken = null;
    }
  }
  async function collateralToReserve(
    tokenId: number,
    amount: bigint,
    counterpartyEntityIdOverride?: string,
    postSettleOp: MovePostSettleOp = { type: 'none' },
    broadcast = true,
  ): Promise<void> {
    const entityId = replica?.state?.entityId || tab.entityId;
    const counterpartyEntityId = String(counterpartyEntityIdOverride || workspaceAccountId || '').trim();
    if (!entityId) {
      notifyUserActionError('collateral-to-reserve', 'Active entity missing for account withdrawal');
      return;
    }
    if (!counterpartyEntityId) {
      toasts.error('Select an account first');
      return;
    }
    if (!activeIsLive) {
      toasts.error('Collateral → Reserve requires LIVE mode');
      return;
    }
    try {
      const signerId = resolveEntitySigner(entityId, 'collateral-to-reserve');
      const info = getTokenInfo(tokenId);
      await submitEntityInputs([buildEntityInput(entityId, signerId, [
        {
          type: 'settle_propose' as const,
          data: {
            counterpartyEntityId,
            executorIsLeft: String(entityId).trim().toLowerCase() < counterpartyEntityId.toLowerCase(),
            memo: 'asset-c2r',
            ops: [
              {
                type: 'c2r',
                tokenId,
                amount,
              },
            ],
          },
        },
      ])]);
      pendingAssetAutoC2Rs = [...pendingAssetAutoC2Rs, {
        counterpartyEntityId,
        tokenId,
        symbol: info.symbol,
        amount,
        postSettleOp,
        broadcast,
        phase: 'awaiting_settlement_execute',
      }];
      refreshPendingCollateralFundingToken();
      toasts.info(`Collateral → Reserve proposed for ${info.symbol}. Waiting for counterparty signature...`);
    } catch (err) {
      logEntityPanelDiagnostic('Collateral → Reserve failed', {
        tokenId,
        counterpartyEntityId,
        error: toErrorMessage(err, 'Collateral to reserve failed'),
      });
      toasts.error(`Collateral → Reserve failed: ${(err as Error).message}`);
    }
  }
  function openAssetMoveWorkspace(): void {
    assetWorkspaceTab = 'move';
    moveFromEndpoint = 'external';
    moveToEndpoint = 'reserve';
    if (!moveExternalRecipient.trim()) moveExternalRecipient = resolveSelfEoaAddress();
    if (!moveReserveRecipientEntityId.trim()) moveReserveRecipientEntityId = resolveSelfEntityId();
    moveAssetSymbol = choosePreferredMoveAssetSymbol();
    resetMoveLineMeasurement();
    bumpMoveNodeLayout();
  }
  function openAccountMoveWorkspace(): void {
    accountWorkspaceTab = 'move';
    moveFromEndpoint = 'account';
    moveToEndpoint = 'account';
    if (!moveSourceAccountId || !workspaceAccountIds.includes(moveSourceAccountId)) {
      moveSourceAccountId = workspaceAccountId || workspaceAccountIds[0] || '';
    }
    if (!moveTargetEntityId.trim()) moveTargetEntityId = resolveSelfEntityId();
    if (!moveTargetCounterpartyManualOverride || !moveTargetHubEntityId.trim()) {
      moveTargetHubEntityId = workspaceAccountId || moveHubEntityOptions[0] || '';
    }
    moveAssetSymbol = choosePreferredMoveAssetSymbol();
    resetMoveLineMeasurement();
    bumpMoveNodeLayout();
  }
  function openAssetHistoryWorkspace(): void {
    assetWorkspaceTab = 'history';
  }
  function openAccountHistoryWorkspace(): void {
    accountWorkspaceTab = 'history';
  }
  function handleMoveWorkspaceError(err: unknown): void {
    toasts.error(`Move failed: ${toErrorMessage(err, 'Unknown error')}`);
  }
  function setMoveProgress(label: string): void {
    moveProgressLabel = label;
  }
  async function waitForMoveCondition(
    predicate: () => boolean,
    label: string,
    timeoutMs = 20_000,
    pollMs = 100,
  ): Promise<void> {
    setMoveProgress(label);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await sleep(pollMs);
    }
    throw new Error(`${label} did not complete in time`);
  }
  function canAddMoveToExistingBatch(): boolean {
    return canAddMoveRouteToDraft(moveFromEndpoint, moveToEndpoint);
  }
  async function queueReserveToReserveDraft(
    tokenId: number,
    amount: bigint,
    recipientEntityIdOverride?: string,
  ): Promise<void> {
    const entityId = String(replica?.state?.entityId || tab.entityId || '').trim().toLowerCase();
    if (!entityId) throw new Error('Active entity missing for reserve batch');
    if (!activeIsLive) throw new Error('Add to batch requires LIVE mode');
    const recipientEntityId = String(recipientEntityIdOverride || moveReserveRecipientEntityId || '').trim().toLowerCase();
    if (!recipientEntityId) throw new Error('Select recipient entity');
    if (recipientEntityId === entityId) throw new Error('Recipient entity must be different from self');
    const signerId = resolveEntitySigner(entityId, 'move-reserve-to-reserve-draft');
    await submitEntityInputs([{
      entityId,
      signerId,
      entityTxs: [buildReserveToReserveTx(recipientEntityId, tokenId, amount)],
    }]);
  }
  async function queueReserveToExternalDraft(
    tokenId: number,
    amount: bigint,
    recipientEoaOverride?: string,
  ): Promise<void> {
    const entityId = String(replica?.state?.entityId || tab.entityId || '').trim().toLowerCase();
    if (!entityId) throw new Error('Active entity missing for reserve withdrawal');
    if (!activeIsLive) throw new Error('Add to batch requires LIVE mode');
    const signerId = resolveEntitySigner(entityId, 'move-reserve-to-external-draft');
    const externalAddress = recipientEoaOverride || await resolveCurrentExternalAddress();
    if (!isAddress(externalAddress)) throw new Error('Recipient must be a valid EOA address');
    const receivingEntity = encodeExternalEoaAsEntity(externalAddress);
    await submitEntityInputs([{
      entityId,
      signerId,
      entityTxs: [buildReserveToExternalEoaTx(externalAddress, tokenId, amount)],
    }]);
    if (getRuntimeEnv(actionRuntimeEnv)) {
      await waitForMoveCondition(
        () => {
          const batch = findLiveReplicaForEntity(entityId, signerId)?.state?.jBatchState?.batch;
          return Array.isArray(batch?.reserveToExternalToken)
            && batch.reserveToExternalToken.some((op) =>
              Number(op?.tokenId) === tokenId
              && BigInt(op?.amount || 0n) === amount
              && String(op?.receivingEntity || '').toLowerCase() === receivingEntity,
            );
        },
        'Waiting for reserve withdrawal to appear in draft batch',
      );
    }
  }
  async function queueReserveToCollateralDraft(
    tokenId: number,
    amount: bigint,
    counterpartyEntityIdOverride?: string,
    receivingEntityIdOverride?: string,
  ): Promise<void> {
    const entityId = String(replica?.state?.entityId || tab.entityId || '').trim().toLowerCase();
    const signerId = resolveEntitySigner(entityId, 'move-reserve-to-account-draft');
    const counterpartyEntityId = String(counterpartyEntityIdOverride || getCurrentMoveTargetHubId() || workspaceAccountId || selectedAccountId || '').trim();
    const receivingEntityId = String(receivingEntityIdOverride || entityId || '').trim().toLowerCase();
    if (!entityId) throw new Error('Active entity missing for account funding');
    if (!signerId) throw new Error('Active signer missing for account funding');
    if (!counterpartyEntityId) throw new Error('Select account first');
    if (!activeIsLive) throw new Error('Add to batch requires LIVE mode');
    const accounts = replica?.state?.accounts;
    if (receivingEntityId === String(entityId).trim().toLowerCase() && (!accounts || !findLocalAccountByCounterparty(entityId, accounts, counterpartyEntityId))) {
      throw new Error('No account found for selected counterparty');
    }
    await submitEntityInputs([buildEntityInput(entityId, signerId, [
      buildReserveToCollateralTx({
        counterpartyEntityId,
        selfEntityId: entityId,
        receivingEntityId,
        tokenId,
        amount,
      }),
    ])]);
  }
  async function queueExternalToReserveDraft(
    tokenAddress: string,
    amount: bigint,
    internalTokenId?: number,
  ): Promise<void> {
    const entityId = String(replica?.state?.entityId || tab.entityId || '').trim().toLowerCase();
    if (!entityId) throw new Error('Active entity missing for external deposit');
    if (!activeIsLive) throw new Error('Add to batch requires LIVE mode');
    if (!isAddress(tokenAddress) || tokenAddress === ZeroAddress) {
      throw new Error('Select ERC20 asset first');
    }
    setMoveProgress('Queuing external deposit into draft batch');
    const signerId = resolveEntitySigner(entityId, 'move-external-to-reserve-draft');
    await submitEntityInputs([{
      entityId,
      signerId,
      entityTxs: [buildExternalToReserveTx({
        contractAddress: tokenAddress,
        amount,
        ...(typeof internalTokenId === 'number' ? { internalTokenId } : {}),
      })],
    }]);
  }
  async function addMoveToExistingBatch(skipValidation = false): Promise<void> {
    if (!skipValidation) {
      const validationError = getMoveValidationError('draft');
      if (validationError) throw new Error(validationError);
    }
    if (hasSentBatch) {
      throw new Error('Wait for current batch confirmation or clear it before adding a new move');
    }
    const moveSourceAccount = getCurrentMoveSourceAccountId();
    const moveTargetAccount = getCurrentMoveTargetHubId();
    const moveTargetEntity = getCurrentMoveTargetEntityId();
    const routeKey = getMoveRouteKey(moveFromEndpoint, moveToEndpoint);
    const externalToken = findExternalTokenBySymbol(moveAssetSymbol);
    const reserveToken = findReserveTransferTokenBySymbol(moveAssetSymbol);
    const maxSourceAmount = moveUiState.sourceAvailableBalance;
    if (routeKey === 'external->reserve') {
      if (!externalToken || !isAddress(externalToken.address) || externalToken.address === ZeroAddress) {
        throw new Error('Select ERC20 asset first');
      }
      const amount = parsePositiveAssetAmount(moveAmount, externalToken, maxSourceAmount);
      await queueExternalToReserveDraft(externalToken.address, amount, externalToken.tokenId);
      moveAmount = '';
      toasts.success('Added to existing draft batch');
      return;
    }
    if (routeKey === 'external->account') {
      if (!externalToken || !isAddress(externalToken.address) || externalToken.address === ZeroAddress) {
        throw new Error('Select ERC20 asset first');
      }
      if (!reserveToken) throw new Error('Select reserve-compatible asset first');
      const amount = parsePositiveAssetAmount(moveAmount, externalToken, maxSourceAmount);
      await queueExternalToReserveDraft(externalToken.address, amount, reserveToken.tokenId);
      await queueReserveToCollateralDraft(reserveToken.tokenId, amount, moveTargetAccount, moveTargetEntity);
      moveAmount = '';
      toasts.success('Added to existing draft batch');
      return;
    }
    const token = reserveToken;
    if (!token) throw new Error('Select reserve-compatible asset first');
    if (routeKey === 'reserve->reserve') {
      const amount = parsePositiveAssetAmount(moveAmount, token, maxSourceAmount);
      await queueReserveToReserveDraft(token.tokenId, amount, moveReserveRecipientEntityId);
      moveAmount = '';
      toasts.success('Added to existing draft batch');
      return;
    }
    if (routeKey === 'reserve->external') {
      const amount = parsePositiveAssetAmount(moveAmount, token, maxSourceAmount);
      const recipient = moveExternalRecipient.trim();
      if (!isAddress(recipient)) throw new Error('Recipient must be a valid EOA address');
      await queueReserveToExternalDraft(token.tokenId, amount, recipient);
      moveAmount = '';
      toasts.success('Added to existing draft batch');
      return;
    }
    if (routeKey === 'reserve->account') {
      const amount = parsePositiveAssetAmount(moveAmount, token, maxSourceAmount);
      await queueReserveToCollateralDraft(token.tokenId, amount, moveTargetAccount, moveTargetEntity);
      moveAmount = '';
      toasts.success('Added to existing draft batch');
      return;
    }
    if (routeKey === 'account->reserve') {
      const amount = parsePositiveAssetAmount(moveAmount, token, maxSourceAmount);
      await collateralToReserve(token.tokenId, amount, moveSourceAccount, { type: 'none' }, false);
      moveAmount = '';
      toasts.info('Queued for counterparty signature, then added to draft batch');
      return;
    }
    if (routeKey === 'account->external') {
      const amount = parsePositiveAssetAmount(moveAmount, token, maxSourceAmount);
      const recipient = moveExternalRecipient.trim();
      if (!isAddress(recipient)) throw new Error('Recipient must be a valid EOA address');
      await collateralToReserve(
        token.tokenId,
        amount,
        moveSourceAccount,
        { type: 'r2e', recipientEoa: recipient },
        false,
      );
      moveAmount = '';
      toasts.info('Queued for counterparty signature, then added to draft batch');
      return;
    }
    if (routeKey === 'account->account') {
      const amount = parsePositiveAssetAmount(moveAmount, token, maxSourceAmount);
      await collateralToReserve(
        token.tokenId,
        amount,
        moveSourceAccount,
        {
          type: 'reserve_to_collateral',
          targetEntityId: moveTargetEntity,
          counterpartyEntityId: moveTargetAccount,
        },
        false,
      );
      moveAmount = '';
      toasts.info('Queued for counterparty signature, then added to draft batch');
      return;
    }
  }
  function getMovePrimaryActionLabel(): string {
    return getMovePrimaryActionLabelForRoute(moveFromEndpoint, moveToEndpoint);
  }
  function handleMoveAllowanceAmountInput(nextValue: string): void {
    moveAllowanceAmountDirty = true;
    moveAllowanceAmount = nextValue;
  }
  async function submitMovePrimaryAction(): Promise<void> {
    if (isImmediateMoveExecutionRoute(moveFromEndpoint, moveToEndpoint)) {
      await executeMovePlan();
      return;
    }
    const validationError = getMoveValidationError('draft');
    if (validationError) throw new Error(validationError);
    moveExecuting = true;
    moveProgressLabel = '';
    try {
      await addMoveToExistingBatch(true);
      moveProgressLabel = '';
    } catch (err) {
      moveProgressLabel = '';
      throw err;
    } finally {
      moveExecuting = false;
    }
  }
  async function executeMovePlan(): Promise<void> {
    const validationError = getMoveValidationError('broadcast');
    if (validationError) throw new Error(validationError);
    const moveSourceAccount = getCurrentMoveSourceAccountId();
    const moveTargetAccount = getCurrentMoveTargetHubId();
    const moveTargetEntity = getCurrentMoveTargetEntityId();
    const moveReserveRecipient = String(moveReserveRecipientEntityId || '').trim().toLowerCase();
    moveExecuting = true;
    moveProgressLabel = '';
    try {
      const routeKey = getMoveRouteKey(moveFromEndpoint, moveToEndpoint);
      if (routeKey === 'external->external') {
        const token = requireExternalTokenBySymbol(moveAssetSymbol);
        const recipient = moveExternalRecipient.trim();
        if (!isAddress(recipient)) throw new Error('Recipient must be a valid EOA address');
        setMoveProgress('Signing external transfer');
        sendAssetSymbol = moveAssetSymbol;
        sendAssetAmount = moveAmount;
        sendAssetRecipient = recipient;
        await sendExternalAsset();
        moveAmount = '';
        return;
      }
      const token = findReserveTransferTokenBySymbol(moveAssetSymbol);
      if (!token) {
        throw new Error('Select reserve-compatible asset first');
      }
      const maxAmount = moveUiState.sourceAvailableBalance;
      const amount = parsePositiveAssetAmount(moveAmount, token, maxAmount ?? undefined);
      const selfEntityId = resolveSelfEntityId();
      const reserveRecipientIsSelf = !moveReserveRecipient || moveReserveRecipient === selfEntityId;
      switch (routeKey) {
        case 'reserve->reserve':
          setMoveProgress(`Transferring reserve balance to ${formatAddress(moveReserveRecipient)}`);
          await reserveToReserve(token.tokenId, amount, moveReserveRecipient);
          break;
        case 'reserve->account':
          setMoveProgress(`Funding ${formatAddress(moveTargetEntity)} via hub ${formatAddress(moveTargetAccount)}`);
          await reserveToCollateral(token.tokenId, amount, moveTargetAccount, moveTargetEntity);
          break;
        case 'account->reserve':
          setMoveProgress('Requesting hub proof and settling account back to your reserve');
          await collateralToReserve(
            token.tokenId,
            amount,
            moveSourceAccount,
            reserveRecipientIsSelf
              ? { type: 'none' }
              : { type: 'r2r', recipientEntityId: moveReserveRecipient },
          );
          break;
        case 'reserve->external':
          setMoveProgress('Withdrawing from your reserve to recipient EOA');
          await withdrawReserveToExternal(token.tokenId, amount, moveExternalRecipient.trim());
          break;
        case 'account->external':
          setMoveProgress('Requesting hub proof and settling account back to your reserve');
          await collateralToReserve(
            token.tokenId,
            amount,
            moveSourceAccount,
            { type: 'r2e', recipientEoa: moveExternalRecipient.trim() },
          );
          break;
        case 'account->account':
          setMoveProgress('Requesting hub proof and settling account back to your reserve');
          await collateralToReserve(
            token.tokenId,
            amount,
            moveSourceAccount,
            {
              type: 'reserve_to_collateral',
              targetEntityId: moveTargetEntity,
              counterpartyEntityId: moveTargetAccount,
            },
          );
          break;
        default:
          throw new Error('Route not implemented');
      }
      moveAmount = '';
      moveProgressLabel = '';
      toasts.success(`Queued ${MOVE_ENDPOINT_LABEL[moveFromEndpoint]} → ${MOVE_ENDPOINT_LABEL[moveToEndpoint]}`);
    } catch (err) {
      moveProgressLabel = '';
      throw err;
    } finally {
      moveExecuting = false;
    }
  }
  // Reserve → Collateral (deposit reserves into selected bilateral account)
  async function reserveToCollateral(
    tokenId: number,
    amountOverride?: bigint,
    counterpartyEntityIdOverride?: string,
    receivingEntityIdOverride?: string,
  ) {
    const entityId = replica?.state?.entityId || tab.entityId;
    const signerId = resolveEntitySigner(entityId, 'reserve-to-collateral');
    const counterpartyEntityId = String(counterpartyEntityIdOverride || workspaceAccountId || selectedAccountId || '').trim();
    const receivingEntityId = String(receivingEntityIdOverride || entityId || '').trim().toLowerCase();
    if (!entityId) {
      notifyUserActionError('reserve-to-collateral', 'Active entity missing for account funding');
      return;
    }
    if (!signerId) {
      notifyUserActionError('reserve-to-collateral', 'Active signer missing for account funding');
      return;
    }
    if (!counterpartyEntityId) {
      toasts.error('Select an account to deposit collateral');
      return;
    }
    if (!activeIsLive) {
      toasts.error('Deposit requires LIVE mode');
      return;
    }
    const amount = amountOverride ?? (onchainReserves.get(tokenId) ?? 0n);
    if (amount <= 0n) {
      toasts.error('No reserve balance for this token');
      return;
    }
    const accounts = replica?.state?.accounts;
    if (receivingEntityId === String(entityId).trim().toLowerCase() && (!accounts || !findLocalAccountByCounterparty(entityId, accounts, counterpartyEntityId))) {
      toasts.error('No account found for selected counterparty');
      return;
    }
    const info = getTokenInfo(tokenId);
    collateralFundingToken = info.symbol;
    try {
      await submitEntityInputs([buildEntityInput(entityId, signerId, [
          buildReserveToCollateralTx({
            counterpartyEntityId,
            selfEntityId: entityId,
            receivingEntityId,
            tokenId,
            amount,
          }),
          buildBroadcastTx(),
        ])]);
      toasts.info(`R→C pending on-chain confirmation for ${info.symbol}.`);
    } catch (err) {
      logEntityPanelDiagnostic('Reserve → Collateral failed', {
        tokenId,
        counterpartyEntityId,
        error: toErrorMessage(err, 'Reserve to collateral failed'),
      });
      toasts.error(`Reserve → Collateral failed: ${(err as Error).message}`);
    } finally {
      collateralFundingToken = null;
    }
  }
  async function openAccountWithFullId(targetEntityId: string) {
    const entityId = replica?.state?.entityId || tab.entityId;
    const signerId = resolveEntitySigner(entityId, 'open-account');
    const trimmed = targetEntityId.trim().toLowerCase();
    if (!canOpenAccounts) {
      toasts.error(openAccountPermissionError || 'Open account requires admin runtime access');
      return;
    }
    if (!entityId) {
      notifyUserActionError('open-account', 'Active entity missing for open-account');
      return;
    }
    if (!signerId) {
      notifyUserActionError('open-account', 'Active signer missing for open-account');
      return;
    }
    if (!isFullEntityId(trimmed)) {
      toasts.error('Full entity ID required (0x + 64 hex chars)');
      return;
    }
	    if (trimmed === String(entityId).toLowerCase()) {
	      toasts.error('Cannot open account with yourself');
	      return;
	    }
    if (!isSameJurisdictionEntityInReplicas(activeReplicas, replica, tab.entityId, entityId, trimmed)) {
      toasts.error('Accounts can only be opened inside the same jurisdiction');
      return;
    }
	    if (accountIds.some((id) => String(id).toLowerCase() === trimmed)) {
	      toasts.info('Account with this entity already exists');
	      return;
    }
    if (!activeIsLive) {
      toasts.error('Open account requires LIVE mode');
      return;
    }
    try {
      const env = getRuntimeEnv(actionRuntimeEnv);
      const rebalancePolicy = getOpenAccountRebalancePolicyData(getTokenInfo(1).decimals);
      if (env) await prewarmCounterpartyProfiles(env, [trimmed]);
      await submitRuntimeInput(buildDirectOpenAccountRuntimeInput({
        sourceEntityId: entityId,
        signerId,
        targetEntityId: trimmed,
        rebalancePolicy,
      }));
      openAccountEntityId = '';
      toasts.success('Account request sent');
    } catch (err) {
      logEntityPanelDiagnostic('Open account failed', {
        targetEntityId: trimmed,
        error: toErrorMessage(err, 'Open account failed'),
      });
      toasts.error(`Open account failed: ${(err as Error).message}`);
    }
  }
  function confirmDisputeAction(
    kind: 'prepare' | 'start' | 'finalize',
    counterpartyEntityId: string,
  ): boolean {
    const label = pendingBatchEntityLabel(counterpartyEntityId, getPendingBatchLabelOptions());
    if (kind === 'prepare') {
      return confirm(
        `Prepare dispute with ${label}?\n\nThis freezes normal account traffic, removes orderbook exposure, and waits for stable dispute evidence before any on-chain batch is queued.`,
      );
    }
    if (kind === 'start') {
      return confirm(
        `Start on-chain dispute with ${label}?\n\nThis adds Dispute Start to the pending batch. Use it only after dispute preparation reports stable evidence.`,
      );
    }
    return confirm(
      `Finalize on-chain dispute with ${label}?\n\nThis adds Dispute Finalize to the pending batch. Only do this after the dispute timeout has passed.`,
    );
  }
  let unsafeCrossJTargetDisputeAccepted = false;
  let unsafeCrossJTargetDisputeAccountId = '';
  $: if (workspaceAccountId !== unsafeCrossJTargetDisputeAccountId) {
    unsafeCrossJTargetDisputeAccepted = false;
    unsafeCrossJTargetDisputeAccountId = workspaceAccountId;
  }
  function getCrossJTargetDisputeRisk(counterpartyEntityId: string): CrossJTargetDisputeRisk | null {
    return getCrossJTargetDisputeRiskForState(replica?.state, counterpartyEntityId);
  }
  function formatCrossJTargetDisputeRisk(risk: CrossJTargetDisputeRisk): string {
    return formatCrossJTargetDisputeRiskLabel({
      risk,
      resolveToken: resolveReserveTokenMeta,
      formatTokenInputAmount,
    });
  }
  async function confirmAndQueueDisputePrepare(
    counterpartyEntityId: string,
    description = 'dispute-prepare-from-configure',
  ) {
    if (!confirmDisputeAction('prepare', counterpartyEntityId)) return;
    await queueDisputePrepare(counterpartyEntityId, description);
  }
  async function confirmAndQueueDisputeStart(
    counterpartyEntityId: string,
    description = 'dispute-from-configure',
    options: DisputeStartOptions = {},
  ) {
    if (!confirmDisputeAction('start', counterpartyEntityId)) return;
    await queueDisputeStart(counterpartyEntityId, description, options);
  }
  async function confirmAndQueueDisputeFinalize(counterpartyEntityId: string, description = 'dispute-finalize-from-configure') {
    if (!confirmDisputeAction('finalize', counterpartyEntityId)) return;
    await queueDisputeFinalize(counterpartyEntityId, description);
  }
  async function queueDisputePrepare(
    counterpartyEntityId: string,
    description = 'dispute-prepare-from-configure',
  ) {
    const entityId = replica?.state?.entityId || tab.entityId;
    const signerId = resolveEntitySigner(entityId, 'dispute-prepare');
    if (!entityId) {
      notifyUserActionError('dispute-prepare', 'Active entity missing for dispute prepare');
      return;
    }
    if (!signerId) {
      notifyUserActionError('dispute-prepare', 'Active signer missing for dispute prepare');
      return;
    }
    if (!activeIsLive) { toasts.error('Dispute prepare requires LIVE mode'); return; }
    try {
      await submitEntityInputs([buildEntityInput(entityId, signerId, [
        buildPrepareDisputeTx(counterpartyEntityId, description),
      ])]);
      toasts.success('Dispute prepared — orderbook exposure removed');
    } catch (err) {
      logEntityPanelDiagnostic('Dispute prepare failed', {
        counterpartyEntityId,
        error: toErrorMessage(err, 'Dispute prepare failed'),
      });
      toasts.error(`Dispute prepare failed: ${(err as Error).message}`);
    }
  }
  async function queueDisputeStart(
    counterpartyEntityId: string,
    description = 'dispute-from-configure',
    options: DisputeStartOptions = {},
  ) {
    const entityId = replica?.state?.entityId || tab.entityId;
    const signerId = resolveEntitySigner(entityId, 'dispute-start');
    if (!entityId) {
      notifyUserActionError('dispute-start', 'Active entity missing for dispute start');
      return;
    }
    if (!signerId) {
      notifyUserActionError('dispute-start', 'Active signer missing for dispute start');
      return;
    }
    if (!activeIsLive) { toasts.error('Dispute requires LIVE mode'); return; }
    try {
      await submitEntityInputs([buildEntityInput(entityId, signerId, [
        buildDisputeStartTx(counterpartyEntityId, description, options),
      ])]);
      toasts.success('Dispute queued — will be submitted on next batch broadcast');
    } catch (err) {
      logEntityPanelDiagnostic('Dispute start failed', {
        counterpartyEntityId,
        error: toErrorMessage(err, 'Dispute start failed'),
      });
      toasts.error(`Dispute failed: ${(err as Error).message}`);
    }
  }
  async function queueDisputeFinalize(counterpartyEntityId: string, description = 'dispute-finalize-from-configure') {
    const entityId = replica?.state?.entityId || tab.entityId;
    const signerId = resolveEntitySigner(entityId, 'dispute-finalize');
    if (!entityId) {
      notifyUserActionError('dispute-finalize', 'Active entity missing for dispute finalize');
      return;
    }
    if (!signerId) {
      notifyUserActionError('dispute-finalize', 'Active signer missing for dispute finalize');
      return;
    }
    if (!activeIsLive) {
      toasts.error('Dispute finalize requires LIVE mode');
      return;
    }
    try {
      await submitEntityInputs([buildEntityInput(entityId, signerId, [
        buildDisputeFinalizeTx(counterpartyEntityId, description),
      ])]);
      toasts.success('Dispute finalize queued — will be submitted on next batch broadcast');
    } catch (err) {
      logEntityPanelDiagnostic('Dispute finalize failed', {
        counterpartyEntityId,
        error: toErrorMessage(err, 'Dispute finalize failed'),
      });
      toasts.error(`Dispute finalize failed: ${(err as Error).message}`);
    }
  }
  async function reopenDisputedAccount(counterpartyEntityId: string) {
    const entityId = replica?.state?.entityId || tab.entityId;
    const signerId = resolveEntitySigner(entityId, 'reopen-disputed-account');
    if (!entityId) {
      notifyUserActionError('reopen-disputed-account', 'Active entity missing for reopen');
      return;
    }
    if (!signerId) {
      notifyUserActionError('reopen-disputed-account', 'Active signer missing for reopen');
      return;
    }
    if (!activeIsLive) {
      toasts.error('Reopen account requires LIVE mode');
      return;
    }
    try {
      await submitEntityInputs([buildEntityInput(entityId, signerId, [
        buildReopenDisputedAccountTx(counterpartyEntityId),
      ])]);
      toasts.success('Reopen disputed account queued');
    } catch (err) {
      logEntityPanelDiagnostic('Reopen disputed account failed', {
        counterpartyEntityId,
        error: toErrorMessage(err, 'Reopen disputed account failed'),
      });
      toasts.error(`Reopen failed: ${(err as Error).message}`);
    }
  }
  async function enforceOutstandingDebt(request: DebtDrainRequest): Promise<void> {
    const { tokenId, symbol, maxIterations, openCount, outstandingAmount, reserveAmount, payableAmount, nextDebtIndex } = request;
    const entityId = String(replica?.state?.entityId || tab.entityId || '').trim();
    if (!entityId) {
      notifyUserActionError('debt-enforcement', 'Active entity missing for debt enforcement');
      return;
    }
    if (!activeIsLive) {
      toasts.error('Debt enforcement requires LIVE mode');
      return;
    }
    debtEnforcingTokenId = tokenId;
    try {
      const signerId = resolveEntitySigner(entityId, 'debt-enforcement');
      const jurisdictionName = String(
        replica?.state?.config?.jurisdiction?.name ||
        selectedJurisdictionName ||
        '',
      ).trim();
      const input = buildDebtEnforcementRuntimeInputFromProjection({
        entityId,
        jurisdictionName,
        tokenId,
        maxIterations,
        ...(signerId ? { signerId } : {}),
        timestamp: requirePanelRuntimeTimestamp('debt-enforcement'),
      });
      await submitRuntimeCommandInput(input);
      const token = getTokenInfo(tokenId);
      const tokenLabel = symbol || token.symbol || `Token #${tokenId}`;
      const amountLabel = `${formatAmount(payableAmount, token.decimals)} ${tokenLabel}`;
      const totalLabel = `${formatAmount(outstandingAmount, token.decimals)} ${tokenLabel}`;
      const reserveLabel = `${formatAmount(reserveAmount, token.decimals)} ${tokenLabel}`;
      toasts.success(
        `Drain submitted: ${amountLabel} payable now, ${openCount} open debts, ${totalLabel} outstanding, ${reserveLabel} reserve, next ${nextDebtIndex === null ? '—' : `#${nextDebtIndex}`}.`,
      );
    } catch (err) {
      logEntityPanelDiagnostic('Enforce debt failed', {
        tokenId,
        maxIterations,
        error: toErrorMessage(err, 'Debt enforcement failed'),
      });
      toasts.error(`Debt enforcement failed: ${(err as Error).message}`);
    } finally {
      debtEnforcingTokenId = null;
    }
  }
  async function addTokenToAccount() {
    const entityId = replica?.state?.entityId || tab.entityId;
    const signerId = resolveEntitySigner(entityId, 'add-token-to-account');
    const counterpartyEntityId = String(workspaceAccountId || '').trim();
    if (!entityId) {
      notifyUserActionError('add-token-to-account', 'Active entity missing for add-token');
      return;
    }
    if (!signerId) {
      notifyUserActionError('add-token-to-account', 'Active signer missing for add-token');
      return;
    }
    if (!counterpartyEntityId) {
      toasts.error('Select account first');
      return;
    }
    if (!Number.isFinite(configureTokenId) || configureTokenId <= 0) {
      toasts.error('Select valid token');
      return;
    }
    if (!activeIsLive) {
      toasts.error('Add token requires LIVE mode');
      return;
    }
    try {
      await submitEntityInputs([buildEntityInput(entityId, signerId, [
        buildAddTokenToAccountTx(counterpartyEntityId, configureTokenId),
      ])]);
      const symbol = getTokenInfo(configureTokenId).symbol || `TKN${configureTokenId}`;
      toasts.success(`Token ${symbol} added to account`);
    } catch (err) {
      logEntityPanelDiagnostic('Add token failed', {
        counterpartyEntityId,
        tokenId: configureTokenId,
        error: toErrorMessage(err, 'Add token failed'),
      });
      toasts.error(`Add token failed: ${(err as Error).message}`);
    }
  }
  // Faucet external tokens (ERC20 to signer EOA)
  async function faucetExternalTokens(tokenSymbol: string = 'USDC') {
    const signerId = currentSignerId;
    if (!signerId) return;
    try {
      const requestApiBase = resolveApiBase();
      const amount = tokenSymbol === 'ETH' ? '0.1' : '100';
      const isEth = tokenSymbol === 'ETH';
      const endpoint = isEth ? `${requestApiBase}/api/faucet/gas` : `${requestApiBase}/api/faucet/erc20`;
      const payload = isEth
        ? { userAddress: signerId, amount }
        : { userAddress: signerId, tokenSymbol, amount };
      // Faucet A: ERC20 to wallet (or native ETH gas faucet)
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const result = await readJsonResponse<FaucetApiResult>(response);
      if (!response.ok || !result?.success) {
        throw new Error(result?.error || `Faucet failed (${response.status})`);
      }
      toasts.success(`Received ${amount} ${tokenSymbol} in external!`);
      if (isEth) {
        void fetchExternalTokens(true);
      }
    } catch (err) {
      logEntityPanelDiagnostic('External faucet failed', {
        tokenSymbol,
        error: toErrorMessage(err, 'External faucet failed'),
      });
      toasts.error(`External faucet failed: ${(err as Error).message}`);
    }
  }
  async function submitAssetFaucet(target: 'external' | 'reserve' | 'account'): Promise<void> {
    if (assetFaucetSubmitting) return;
    assetFaucetSubmitting = true;
    try {
      if (target === 'external') {
        await faucetExternalTokens(faucetAssetSymbol);
        return;
      }
      const token = getFaucetReserveTokenMeta(faucetAssetSymbol);
      if (!token) {
        toasts.error('Reserve faucet supports ERC20 assets only');
        return;
      }
      if (target === 'account') {
        const firstAccountId = firstFaucetAccountId;
        if (!firstAccountId) {
          toasts.error('Open an account first');
          return;
        }
        await faucetOffchain(firstAccountId, token.tokenId);
        return;
      }
      await faucetReserves(token.tokenId, token.symbol);
    } finally {
      assetFaucetSubmitting = false;
    }
  }
  function refreshBalances(): void {
    void fetchExternalTokens(true);
  }
  $: {
    activeEnv;
    envRevision;
    replica;
    currentSignerId;
    tab.entityId;
    tab.signerId;
    const nextExternalWalletStateSyncKey = buildExternalWalletStateSyncSignature();
    if (nextExternalWalletStateSyncKey !== externalWalletStateSyncKey) {
      externalWalletStateSyncKey = nextExternalWalletStateSyncKey;
      if (nextExternalWalletStateSyncKey && externalTokens.length > 0 && !externalFetchInFlight) {
        void fetchExternalTokens();
      }
    }
  }
  async function handleResetEverything(): Promise<void> {
    if (resettingEverything) return;
    const confirmed = window.confirm('Reset ALL local XLN data? Wallets, runtimes, settings, and IndexedDB databases will be deleted.');
    if (!confirmed) return;
    resettingEverything = true;
    try {
      await resetEverything({ confirmed: true, reason: 'entity-empty-state' });
    } finally {
      resettingEverything = false;
    }
  }
  const EXTERNAL_WALLET_REFRESH_MS = 5_000;
  let externalBalancePollKey = '';
  $: {
    if (typeof window === 'undefined') {
      externalBalancePollKey = '';
    } else {
      const signerId = String(currentSignerId || '').trim();
      const runtimeId = String(panelView.runtimeId || '').trim();
      const jurisdiction = String(currentEntityJurisdictionName || panelView.activeJurisdictionName || '').trim();
      const nextKey = `${signerId}|${runtimeId}|${jurisdiction}|${activeIsLive ? 'live' : 'history'}|${EXTERNAL_WALLET_REFRESH_MS}`;
      if (nextKey !== externalBalancePollKey) {
        externalBalancePollKey = nextKey;
        if (signerId) {
          void fetchExternalTokens();
        } else {
          externalTokens = [];
          externalWalletSnapshotSource = null;
          externalTokensLoading = false;
        }
      }
    }
  }
  onDestroy(() => {
    moveVisualController.destroy();
  });
  onMount(() => {
    applyDeepLinkViewFromUrl();
    const externalWalletRefresh = window.setInterval(() => {
      if (document.visibilityState !== 'visible' || !activeIsLive || !String(currentSignerId || '').trim()) return;
      void fetchExternalTokens(true);
    }, EXTERNAL_WALLET_REFRESH_MS);
    const handleMovePointer = (event: PointerEvent | MouseEvent) => {
      if (!moveDragSource) return;
      const hovered = document.elementFromPoint(event.clientX, event.clientY)?.closest?.('[data-move-side="to"]');
      const endpoint = hovered?.getAttribute?.('data-move-endpoint');
      moveDragHoverTarget = endpoint === 'external' || endpoint === 'reserve' || endpoint === 'account'
        ? endpoint
        : null;
    };
    const handleMovePointerUp = () => {
      if (moveDragSource && moveDragHoverTarget) {
        completeMoveSelection(moveDragHoverTarget);
      } else {
        clearMoveDrag();
      }
    };
    const handleUrlNavigation = () => applyDeepLinkViewFromUrl();
    window.addEventListener('pointermove', handleMovePointer);
    window.addEventListener('pointerup', handleMovePointerUp);
    window.addEventListener('mousemove', handleMovePointer);
    window.addEventListener('mouseup', handleMovePointerUp);
    window.addEventListener('hashchange', handleUrlNavigation);
    window.addEventListener('popstate', handleUrlNavigation);
    return () => {
      window.clearInterval(externalWalletRefresh);
      window.removeEventListener('pointermove', handleMovePointer);
      window.removeEventListener('pointerup', handleMovePointerUp);
      window.removeEventListener('mousemove', handleMovePointer);
      window.removeEventListener('mouseup', handleMovePointerUp);
      window.removeEventListener('hashchange', handleUrlNavigation);
      window.removeEventListener('popstate', handleUrlNavigation);
    };
  });
  // Formatting
  function getTokenInfo(tokenId: number) {
    const jurisdictionToken = externalTokens.find((token) => token.tokenId === tokenId);
    if (jurisdictionToken) {
      return {
        symbol: jurisdictionToken.symbol,
        name: jurisdictionToken.symbol,
        color: '',
        decimals: requireTokenDecimals(jurisdictionToken.decimals, `token:${tokenId}`),
      };
    }
    if (!activeXlnFunctions) throw new Error(`TOKEN_METADATA_READER_UNAVAILABLE:token:${tokenId}`);
    const info = activeXlnFunctions.getTokenInfo(tokenId);
    return {
      ...info,
      decimals: requireTokenDecimals(info.decimals, `token:${tokenId}`),
    };
  }
  function resolveConsensusTokenMetadata(tokenId: number): { symbol: string } | null {
    const token = externalTokens.find((candidate) => candidate.tokenId === tokenId);
    return token ? { symbol: token.symbol } : null;
  }
  let {
    formatAmount,
    formatCompact,
    formatApproxUsd,
    formatUsdExact,
    getAssetPrice,
    getAssetValue,
    getExternalValue,
    calculatePortfolioValue,
  } = createEntityAssetValueFormatters({
    getTokenInfo,
    tokenPrecision: undefined,
    compactNumbers: false,
  });
  $: ({
    formatAmount,
    formatCompact,
    formatApproxUsd,
    formatUsdExact,
    getAssetPrice,
    getAssetValue,
    getExternalValue,
    calculatePortfolioValue,
  } = createEntityAssetValueFormatters({
    getTokenInfo,
    tokenPrecision: $settings?.tokenPrecision,
    compactNumbers: Boolean($settings?.compactNumbers),
  }));
  // Calculate totals for the three buckets
  $: externalTotal = (() => {
    let total = 0;
    for (const token of externalTokens) {
      if (token.balance > 0n) {
        total += getExternalValue(token);
      }
    }
    return total;
  })();
  $: reservesTotal = calculatePortfolioValue(onchainReserves);
  $: accountsData = buildAccountPortfolioData({
    accounts: replica?.state?.accounts,
    localEntityId: tab.entityId,
    deriveDelta: activeXlnFunctions?.deriveDelta,
    getTokenInfo,
  });
  $: disputedAccounts = buildDisputedAccountViews(replica?.state?.accounts);
  $: netWorth = externalTotal + reservesTotal + accountsData.total;
  $: entityActivityRows = buildEntityActivityRows({
    replica,
    tabEntityId: tab.entityId,
    activeEnv,
    activeXlnFunctions,
    getTokenInfo,
    formatAmount,
  });
  $: entityActivityAccounts = buildEntityActivityAccounts(entityActivityRows);
  $: filteredEntityActivityRows = filterEntityActivityRows(entityActivityRows, entityActivityAccountFilter);
  $: if (entityActivityAccountFilter !== 'all' && !entityActivityAccounts.some((row) => row.accountId === entityActivityAccountFilter)) {
    entityActivityAccountFilter = 'all';
  }
  // Handlers
  function handleEntitySelect(event: CustomEvent) {
    const { jurisdiction, signerId, entityId } = event.detail;
    selectedAccountId = null;
    dispatch('entitySelect', event.detail);
    if (userModeHeader) return;
    tab = { ...tab, jurisdiction, signerId, entityId };
  }
  function handleHeaderAddEntity() {
    dispatch('addEntity');
  }
  function handleHeaderAddJurisdiction() {
    dispatch('addJurisdiction');
  }
  function handleHeaderAddRuntime() {
    dispatch('addRuntime');
  }
  function applyAccountNavigationPatch(patch: AccountWorkspaceNavigationPatch): void {
    if (patch.activeTab) activeTab = patch.activeTab;
    if (patch.accountWorkspaceTab) accountWorkspaceTab = patch.accountWorkspaceTab;
    if (patch.workspaceAccountId !== undefined) workspaceAccountId = patch.workspaceAccountId;
    if (patch.selectedAccountId !== undefined) selectedAccountId = patch.selectedAccountId;
  }
  function handleAccountSelect(event: CustomEvent) {
    applyAccountNavigationPatch(selectAccountNavigation(workspaceAccountIds, event.detail?.accountId || ''));
  }
  function handleJurisdictionSelect(event: CustomEvent<{ selected: string | null }>) {
    const next = event.detail?.selected ?? null;
    dispatch('jurisdictionSelect', next ? { name: next } : { name: null });
    if (next) selectedJurisdictionName = next;
  }
  function handleBackToAccounts() {
    applyAccountNavigationPatch(returnToAccountsWorkspace({ selectedAccountId }, workspaceAccountIds, 'activity'));
  }
  function selectTopLevelTab(nextTab: ViewTab) {
    applyAccountNavigationPatch(selectTopLevelTabNavigation({ selectedAccountId }, workspaceAccountIds, nextTab));
  }
  function handleAccountPanelGoToOpenAccounts() {
    applyAccountNavigationPatch(returnToAccountsWorkspace({ selectedAccountId }, workspaceAccountIds, 'open'));
  }
  function openDisputedAccount(counterpartyEntityId: string) {
    applyAccountNavigationPatch(openDisputedAccountNavigation(counterpartyEntityId));
  }
  function getPendingBatchLabelOptions() {
    return {
      activeEnv,
      selfEntityId: resolveSelfEntityId(),
      activeXlnFunctions,
    };
  }
  $: openOutgoingDebtSummary = buildOpenOutgoingDebtTotals({ replica, activeXlnFunctions });
  $: pendingBatchState = buildPendingBatchState(replica?.state?.jBatchState);
  $: hasDraftBatch = pendingBatchState.hasDraftBatch;
  $: hasSentBatch = pendingBatchState.hasSentBatch;
  $: pendingBatchReserveIssue = getPendingBatchReserveIssue({
    entityId: String(replica?.state?.entityId || tab.entityId || ''),
    batch: replica?.state?.jBatchState?.batch,
    onchainReserves,
    openDebtByToken: openOutgoingDebtSummary.byToken,
  });
  $: pendingBatchReserveIssueText = formatBatchReserveIssue(pendingBatchReserveIssue, getPendingBatchLabelOptions());
  $: canBroadcastPendingBatch = canBroadcastPendingBatchState(pendingBatchState, pendingBatchReserveIssue);
  function enqueueCurrentPendingBatchAction(action: 'clear' | 'broadcast' | 'rebroadcast', context: string): Promise<void> {
    return enqueuePendingBatchAction({
      activeIsLive,
      action,
      context,
      entityId: replica?.state?.entityId || tab.entityId,
      resolveEntitySigner,
      submitEntityInputs,
    });
  }
  const runPendingBatchAction = createPendingBatchActionRunner({
    getState: () => ({
      pendingBatchCount,
      pendingBatchSubmitting,
      pendingBatchReserveIssueText,
      canBroadcastPendingBatch,
      hasSentBatch,
    }),
    setSubmitting: (submitting) => {
      pendingBatchSubmitting = submitting;
    },
    enqueueAction: enqueueCurrentPendingBatchAction,
    confirmClear: () => confirm('Clear current draft and any sent batch state?'),
    notifySuccess: toasts.success,
    notifyError: toasts.error,
    formatError: toErrorMessage,
  });
  async function clearPendingBatch(): Promise<void> {
    await runPendingBatchAction('clear');
  }
  async function broadcastPendingBatch(): Promise<void> {
    await runPendingBatchAction('broadcast');
  }
  async function rebroadcastPendingBatch(): Promise<void> {
    await runPendingBatchAction('rebroadcast');
  }
  // Tab config
  // Pending batch count for Accounts tab badge
  $: pendingBatchCount = pendingBatchState.count;
  $: pendingBatchMode = pendingBatchState.mode;
  $: pendingBatchPreview = buildPendingBatchPreview(
    pendingBatchState.previewBatch,
    getPendingBatchLabelOptions(),
  );
  const tabs: IconBadgeTabConfig<ViewTab>[] = [
    { id: 'assets', icon: Landmark, label: 'Assets' },
    { id: 'accounts', icon: Users, label: 'Accounts' },
    { id: 'settings', icon: SettingsIcon, label: 'Settings' },
  ];
  $: hasAnyAccounts = accountIds.length > 0;
  $: faucetSupportsReserve = !!getFaucetReserveTokenMeta(faucetAssetSymbol);
  $: canShowAccountFaucet = faucetSupportsReserve && hasAnyAccounts;
  let lastAppliedHashRoute: string | null = null;
  $: routeSyncSignature = [
    activeTab,
    assetWorkspaceTab,
    settingsSubview,
    accountWorkspaceTab,
  ].join(':');
  $: {
    const hashRoute = typeof window === 'undefined' ? '' : getLocationHashRoute(window.location) || '';
    if (hashRoute !== lastAppliedHashRoute) {
      lastAppliedHashRoute = hashRoute;
      applyDeepLinkViewFromUrl();
    }
  }
  $: if (typeof window !== 'undefined') {
    routeSyncSignature;
    syncHashToCurrentView();
  }
</script>

<div class="entity-panel" data-panel-id={tab.id}>
  <EntityPanelChrome
    {tab}
    {hideHeader}
    {showJurisdiction}
    {userModeHeader}
    bind:selectedJurisdictionName
    {activeReplicas}
    entityNames={panelView.entityNames}
    jurisdictions={panelView.jurisdictions}
    {handleJurisdictionSelect}
    {handleEntitySelect}
  />

  <main class="main-scroll">
    {#if !tab.entityId || !tab.signerId}
      <EntitySelectionEmptyState
        {tab}
        {userModeHeader}
        {resettingEverything}
        {allowHeaderAddRuntime}
        {headerRuntimeAddLabel}
        {handleResetEverything}
        {handleHeaderAddRuntime}
        {handleHeaderAddJurisdiction}
        {handleHeaderAddEntity}
        {handleEntitySelect}
      />

    {:else if isAccountFocused && selectedAccount && selectedAccountId}
      <EntityFocusedAccountView
        {selectedAccount}
        {selectedAccountId}
        {tab}
        {replica}
        entityNames={panelView.entityNames}
        {pendingOffchainFaucetKeys}
        {handleBackToAccounts}
        {handleAccountFaucet}
        {handleAccountPanelGoToOpenAccounts}
      />

    {:else if replica}
      <EntityPanelHeroTabs
        {tab}
        {userModeHeader}
        {avatar}
        {activeXlnFunctions}
        {entityJurisdictionBadge}
        {heroDisplayName}
        {allowHeaderAddRuntime}
        {headerRuntimeAddLabel}
        {currentEntityValue}
        {copiedMetaField}
        {netWorth}
        {tabs}
        {activeTab}
        {pendingBatchCount}
        {formatUsdExact}
        {copyMetaValue}
        {selectTopLevelTab}
        {handleHeaderAddRuntime}
        {handleHeaderAddJurisdiction}
        {handleHeaderAddEntity}
        {handleEntitySelect}
      />

      <section class="content">
        {#if activeTab === 'assets'}
          <EntityAssetsTab
            {replica}
            {tab}
            {activeIsLive}
            profileByEntityId={panelView.profileByEntityId}
            entityNames={panelView.entityNames}
            {currentExternalEoaValue}
            {copiedMetaField}
            {externalWalletSnapshotSource}
            {externalTokensLoading}
            {assetFaucetSubmitting}
            {assetLedgerRows}
            {assetLedgerTotals}
            {assetLedgerGrandTotal}
            bind:faucetAssetSymbol
            {faucetSupportsReserve}
            {canShowAccountFaucet}
            {openOutgoingDebtSummary}
            {pendingBatchCount}
            {pendingBatchMode}
            {pendingBatchReserveIssueText}
            {pendingBatchPreview}
            {pendingBatchSubmitting}
            {hasSentBatch}
            {canBroadcastPendingBatch}
            {assetWorkspaceTab}
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
            {moveAllowanceRouteEnabled}
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
            {moveUiState}
            {setMoveSource}
            {setMoveTarget}
            {beginMoveDrag}
            {getMoveNodeAnchor}
            {buildMoveArrowPath}
            {moveRouteSteps}
            {canAddMoveToExistingBatch}
            {submitMovePrimaryAction}
            {approveMoveExternalAllowance}
            {handleMoveAllowanceAmountInput}
            {handleMoveSourceAccountChange}
            {handleMoveReserveRecipientChange}
            {handleMoveTargetEntityChange}
            {handleMoveTargetHubChange}
            {moveNodeAction}
            {moveEntityOptions}
            {moveHubEntityOptions}
            {moveSourceAccountOptions}
            {resolveSelfEntityId}
            {moveAssetOptions}
            moveEndpointLabels={MOVE_ENDPOINT_LABEL}
            moveEndpoints={MOVE_ENDPOINTS}
            {formatAmount}
            {formatApproxUsd}
            {getMovePrimaryActionLabel}
            setMoveVisualRoot={moveVisualController.setRoot}
            {handleMoveWorkspaceError}
            {refreshBalances}
            {submitAssetFaucet}
            {copyMetaValue}
            {shortHash}
            {enforceOutstandingDebt}
            {openAssetMoveWorkspace}
            {openAssetHistoryWorkspace}
            {clearPendingBatch}
            {rebroadcastPendingBatch}
            {broadcastPendingBatch}
          />
        {:else if activeTab === 'accounts'}
          <AccountWorkspaceView
            {replica}
            {tab}
            {activeEnv}
            {liveRuntimeEnv}
            {activeIsLive}
            {actionRuntimeEnv}
            {canOpenAccounts}
            {submitRuntimeInput}
            runtimeHeight={panelView.height}
            entityNames={panelView.entityNames}
            profileByEntityId={panelView.profileByEntityId}
            isDevnet={panelView.isDevnet}
            {hubDiscoveryProjection}
            {paymentView}
            {swapRuntimeView}
            {accountIds}
            {workspaceAccountIds}
            {workspaceAccountId}
            {selectedAccountId}
            {pendingOffchainFaucetKeys}
            bind:accountWorkspaceTab
            bind:configureWorkspaceTab
            bind:configureTokenId
            {configureTokenOptions}
            bind:unsafeCrossJTargetDisputeAccepted
            {openOutgoingDebtSummary}
            {pendingBatchCount}
            {pendingBatchMode}
            {pendingBatchReserveIssueText}
            {pendingBatchPreview}
            {pendingBatchSubmitting}
            {hasSentBatch}
            {canBroadcastPendingBatch}
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
            {moveAllowanceRouteEnabled}
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
            {moveUiState}
            {setMoveSource}
            {setMoveTarget}
            {beginMoveDrag}
            {getMoveNodeAnchor}
            {buildMoveArrowPath}
            {moveRouteSteps}
            {canAddMoveToExistingBatch}
            {submitMovePrimaryAction}
            {approveMoveExternalAllowance}
            {handleMoveAllowanceAmountInput}
            {handleMoveSourceAccountChange}
            {handleMoveReserveRecipientChange}
            {handleMoveTargetEntityChange}
            {handleMoveTargetHubChange}
            {moveNodeAction}
            {moveEntityOptions}
            {moveHubEntityOptions}
            {moveSourceAccountOptions}
            {moveAssetOptions}
            moveEndpointLabels={MOVE_ENDPOINT_LABEL}
            moveEndpoints={MOVE_ENDPOINTS}
            bind:openAccountEntityId
            {openAccountEntityOptions}
            {disputedAccounts}
            {entityActivityRows}
            {filteredEntityActivityRows}
            {entityActivityAccounts}
            bind:entityActivityAccountFilter
            {handleAccountSelect}
            {handleAccountFaucet}
            {handleQuickSettleApprove}
            {openAccountHistoryWorkspace}
            {openAccountMoveWorkspace}
            {clearPendingBatch}
            {rebroadcastPendingBatch}
            {broadcastPendingBatch}
            {handleWorkspaceAccountChange}
            {getCrossJTargetDisputeRisk}
            {formatCrossJTargetDisputeRisk}
            {confirmAndQueueDisputeFinalize}
            {confirmAndQueueDisputeStart}
            {confirmAndQueueDisputePrepare}
            {addTokenToAccount}
            {handleOpenAccountTargetChange}
            {openAccountWithFullId}
            {openDisputedAccount}
            {reopenDisputedAccount}
            {resolveSelfEntityId}
            {formatAmount}
            {formatApproxUsd}
            {getMovePrimaryActionLabel}
            onMoveVisualRoot={moveVisualController.setRoot}
            {handleMoveWorkspaceError}
          />

        {:else if activeTab === 'settings'}
          <EntitySettingsProjectionPanel
            entityId={currentEntityValue || tab.entityId}
            signerId={currentSignerId || tab.signerId}
            runtimeId={panelView.runtimeId}
            runtimeHeight={panelView.height}
            jurisdictionLabel={selectedJurisdictionName || ''}
            profile={replica.state?.profile ?? null}
            hubPolicy={replica.state?.hubRebalanceConfig ?? null}
            accountCount={accountIds.length}
            reserveCount={replica.state?.reserves?.size ?? 0}
            proposalCount={replica.state?.proposals?.size ?? 0}
            isHub={replica.state?.profile?.isHub === true || Boolean((replica.state as { orderbookHubProfile?: unknown })?.orderbookHubProfile)}
            {activeIsLive}
            runtimeEnv={getRuntimeEnv(actionRuntimeEnv)}
            consensusView={buildEntityConsensusSettingsView(
              replica,
              panelView.height,
              displayProjectionFrame === null,
              { resolveTokenMetadata: resolveConsensusTokenMetadata },
            )}
            {settingsSubview}
            onSaveProfile={saveSettingsProjectionProfile}
            onImportJMachine={importSettingsJMachine}
          />
        {/if}
      </section>
    {/if}
  </main>
</div>

<style>
  .entity-panel {
    --space-1: 8px;
    --space-2: 12px;
    --space-3: 16px;
    --space-4: 20px;
    --panel-gutter-x: 16px;
    display: flex;
    flex-direction: column;
    width: 100%;
    max-width: 1220px;
    min-height: 0;
    height: auto;
    margin: 0 auto;
    padding-bottom: calc(var(--space-4) + env(safe-area-inset-bottom, 0px));
    background: transparent;
    color: var(--theme-text-primary, #e4e4e7);
    font-family: 'Inter', -apple-system, sans-serif;
    font-size: 13px;
    box-sizing: border-box;
  }

  /* Main content - NO own scrollbar, parent .panel-content scrolls */
  .main-scroll {
    display: contents;
  }

  /* Content */
  .content {
    padding: var(--space-3) var(--panel-gutter-x);
    min-width: 0;
  }

  .content :global(input:not([type="range"]):not([type="checkbox"]):not(.entity-input-field):not(.move-amount-input):not(.move-external-input)),
  .content :global(select:not(.move-token-select)) {
    background: color-mix(in srgb, var(--theme-input-bg, #09090b) 88%, transparent) !important;
    border: 1px solid color-mix(in srgb, var(--theme-input-border, #27272a) 82%, transparent) !important;
    border-radius: 6px !important;
    color: var(--theme-text-primary, #e4e4e7) !important;
    padding: 10px 12px !important;
    font-size: 13px !important;
  }

  .content :global(input:not([type="range"]):not([type="checkbox"]):focus),
  .content :global(select:focus) {
    outline: none !important;
    border-color: var(--theme-input-focus, #fbbf24) !important;
  }

  .content :global(input::placeholder) {
    color: var(--theme-text-muted, #71717a) !important;
  }

  .content :global(button:not(.tab):not(.toggle):not(.back-btn):not(.btn-add):not(.btn-live):not(.c-delete):not(.account-workspace-tab):not(.configure-tab):not(.btn-add-token):not(.scope-btn):not(.primary-btn):not(.cancel-btn):not(.summary-action):not(.summary-action-inline):not(.delta-capacity-bar):not(.delta-faucet):not(.delta-expand):not(.step-btn):not(.step-auto-btn):not(.move-node):not(.move-primary-cta):not(.refresh-btn):not(.hub-primary):not(.btn-connect):not(.expand-toggle):not(.closed-trigger):not(.dropdown-toggle):not(.dropdown-item):not(.settings-tab):not(.compact-btn):not(.pill):not(.theme-swatch):not(.icon-btn):not(.danger-icon):not(.close-btn):not(.file-btn):not(.danger-btn):not(.btn-table-action):not(.wallet-meta-copy)) {
    background: color-mix(in srgb, var(--theme-surface, #18181b) 88%, transparent) !important;
    border: 1px solid color-mix(in srgb, var(--theme-border, #27272a) 76%, transparent) !important;
    border-radius: 6px !important;
    color: var(--theme-text-secondary, #a1a1aa) !important;
    padding: 10px 14px !important;
    font-size: 12px !important;
    cursor: pointer !important;
  }

  .content :global(h3),
  .content :global(h4),
  .content :global(label) {
    color: var(--theme-text-secondary, #a1a1aa) !important;
  }

  /* ============================================
     HORIZONTAL TABLE LAYOUT (External/Reserves)
     ============================================ */

  @media (max-width: 900px) {
    .entity-panel {
      --panel-gutter-x: 10px;
      --space-2: 10px;
      --space-3: 12px;
    }


    .content {
      padding: 12px var(--panel-gutter-x);
      max-width: 100%;
      overflow-x: clip;
    }

    .content {
      width: 100%;
      max-width: 100%;
      min-width: 0;
      box-sizing: border-box;
    }


  }

  @media (max-width: 460px) {
  }
</style>
