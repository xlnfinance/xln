<script lang="ts">
  import { flushSync, tick } from 'svelte';
  import type { AccountMachine, EntityReplica, Tab } from '$lib/types/ui';
  import { writable } from 'svelte/store';
  import type { BookState, CrossJurisdictionSwapRoute, Delta, EntityTx, Env } from '@xln/runtime/xln-api';
  import {
    deriveCanonicalCrossJurisdictionBookOwnerForLegs,
    deriveCanonicalCrossJurisdictionMarketForLegs,
    deriveCanonicalCrossJurisdictionVenueIdForLegs,
    getJurisdictionStackId,
    getBestAsk,
    getBestBid,
  } from '@xln/runtime/xln-api';
  import type { Profile as GossipProfile } from '@xln/runtime/xln-api';
  import type { SwapBookEntry } from '@xln/runtime/xln-api';
  import { submitEntityInputs, submitRuntimeInput, xlnFunctions } from '../../stores/xlnStore';
  import { toasts } from '../../stores/toastStore';
  import { errorLog } from '../../stores/errorLogStore';
  import { requireSignerIdForEntity } from '$lib/utils/entityReplica';
  import { unwrapLiveRuntimeEnv } from '$lib/utils/liveRuntimeEnv';
  import { prewarmCounterpartyProfiles } from '$lib/utils/p2pPrefetch';
  import { amountToUsd } from '$lib/utils/assetPricing';
  import { requireTokenDecimals } from './token-metadata';
  import { formatEntityId } from '$lib/utils/format';
  import {
    buildSwapPanelRuntimeView,
    buildCrossSwapRuntimeInputPlan,
    buildCrossSwapSetupSteps,
    crossOrderbookPairLabel,
    firstAvailableHubId,
    formatEntityNetworkLabel,
    getTokenMapValue,
    maxBigInt,
    normalizeJurisdictionDisplayName,
    nonNegative,
    parseCrossAssetKey,
    resolveHubIdCandidate,
    sameOrderbookPairLabel,
    tokenNetworkLabel,
    type CrossSwapSetupStep,
    type SwapPanelRuntimeView,
    type TokenKeyedMap,
  } from './swap-panel-helpers';
  import {
    compareStableText,
    normalizeDecimalInput,
    normalizeDisplayPriceForInput,
    parseDecimalAmountToBigInt,
    toBigIntSafe,
  } from './swap-formatting';
  import {
    AGGREGATED_ORDERBOOK_DEPTH,
    FILLED_DISPLAY_PPM_THRESHOLD,
    MAX_PRICE_DEVIATION_BPS,
    MIN_ORDER_NOTIONAL_USD,
    ORDERBOOK_PRICE_DECIMALS,
    ORDERBOOK_PRICE_SCALE,
    ORDERBOOK_SNAPSHOT_FRESH_MS,
    SELECTED_ORDERBOOK_DEPTH,
    computePriceDeviationBps,
    formatSwapTokenAmount,
    formatSwapTokenAmountForInput,
    parseSwapDisplayPriceTicks,
    type PreparedSwapOrderLike,
    type SwapFormValidationInput,
    validateSwapForm,
  } from './swap-order-math';
  import {
    buildDeterministicSwapOfferId as buildSwapOfferId,
    buildRoutedRouteCandidates as buildRoutedRouteCandidatesPure,
    estimateRoutedHopOutput,
    orderbookSnapshotCacheKey,
    orderbookSnapshotSignature,
    type OrderbookSnapshot,
    type RouteQuote,
    type RoutedSwapHop,
    type RoutedSwapRouteCandidate,
  } from './routed-swap-planner';
  import {
    buildClosedOrderViews,
    buildOfferPriceImprovementByKey,
    buildTotalPriceImprovementSummary,
    closedOrderStatusLabel,
    closedOrderStatusTone,
    collectOfferLifecyclesFrom as collectOfferLifecyclesFromPure,
    extractStpBlockingOrderId,
    formatCloseComment,
    formatOrderTime,
    isDustOpenOffer as isDustOpenOfferPure,
    offerLifecycleKey,
    offerPriceTicks as offerPriceTicksPure,
    offerSideLabel as offerSideLabelPure,
    remainingOfferUsd as remainingOfferUsdPure,
    type ClosedOrderStatus,
    type ClosedOrderView,
    type OfferLifecycle,
    type OfferLike,
    type SwapCompletionModal,
  } from './swap-order-history';
  import SwapOrderList from './SwapOrderList.svelte';
  import SwapCompletionDialog from './SwapCompletionDialog.svelte';
  import SwapOrderbookSection from './SwapOrderbookSection.svelte';
  import SwapTradeTicket from './SwapTradeTicket.svelte';
  import type { SwapOrderbookLevelClickDetail, SwapOrderbookPairOption } from './swap-orderbook-view';
  import './SwapPanel.css';

  export let replica: EntityReplica | null;
  export let tab: Tab;
  export let env: Env | null = null;
  export let isLive: boolean;
  export let runtimeView: SwapPanelRuntimeView | null = null;

  // Props
  export let counterpartyId: string = '';
  let orderbookScopeMode: 'aggregated' | 'selected' = 'selected';
  let swapPanelRoot: HTMLDivElement | null = null;
  let orderAmountInputElement: HTMLInputElement | null = null;
  let orderAmountRevision = 0;
  let orderAmountDomRevision = 0;
  let latestOrderAmountDomValue = '';
  let hasLatestOrderAmountDomValue = false;
  let createOrderAccountId = '';
  let selectedBookAccountId = '';
  let activeOrderAccountId = '';
  let showOrderbook = true;
  let selectedRouteEntityId = '';
  let selectedRouteEntityName = '';
  let selectedRouteJurisdictionLabel = '';
  type BookSide = 'bid' | 'ask';
  type SwapOfferLike = SwapBookEntry;
  type ClickedOrderLevel = {
    side: BookSide;
    priceTicks: bigint;
    displayPrice: string;
    inputPriceTicks: bigint;
    sizeBaseWei: bigint;
    baseTokenId: number;
    quoteTokenId: number;
    accountId: string;
    accountIds: string[];
  };
  let selectedOrderLevel: ClickedOrderLevel | null = null;
  let orderbookSnapshot: OrderbookSnapshot = {
    pairId: '1/2',
    hubIds: [],
    bids: [],
    asks: [],
    spread: null,
    spreadPercent: '-',
    sourceCount: 0,
    sourceStatus: 'syncing',
    updatedAt: 0,
  };
  const orderbookSnapshotCache = new Map<string, OrderbookSnapshot>();
  const orderbookSnapshotCacheSignatures = new Map<string, string>();
  const orderbookSnapshotCacheBumpedAt = new Map<string, number>();
  const routedOrderAmountInput = writable('');
  let orderbookQuoteNonce = 0;
  let orderbookPairId = '1/2';
  let orderbookRefreshNonce = 0;
  let orderPercent = 100;
  let submitError = '';
  let pendingSwapFeedbackOfferId = '';
  let swapCompletionModal: SwapCompletionModal | null = null;
  let tradeSide: 'buy-base' | 'sell-base' = 'buy-base';
  let hasAutoSuggestedInitialPrice = false;
  let hasUserEditedPriceInput = false;
  let selectedPair: PairOption | null = null;
  let giveTokenId = '1';
  let wantTokenId = '2';
  let orderAmountInput = '';
  let liveOrderAmountInput = '';
  let priceRatioInput = '';
  let giveAmount: bigint = 0n;
  let wantAmount: bigint = 0n;
  let preparedOrder: PreparedSwapOrderLike | null = null;
  let parsedOrderbookPair: { baseTokenId: number; quoteTokenId: number } | null = null;
  let orderbookPairDisplayLabel = '';
  let orderbookPairOptions: SwapOrderbookPairOption[] = [];
  let orderbookPairSelectValue = '';
  let lastOrderbookPairSelectValue = '';
  let lastOrderbookPairSelectMode = '';
  let lastOrderbookPairSelectRoute = '';
  let lastOrderbookPairSelectCommit = '';
  let orderMode: 'buy-base' | 'sell-base' | 'none' = 'none';
  let limitPriceTicks: bigint | null = null;
  let orderListTab: 'open' | 'closed' = 'open';
  let orderRouteFilter: 'all' | 'same' | 'cross' = 'all';
  let closedOrderStatusFilter: 'all' | ClosedOrderStatus = 'all';
  let activeOffers: SwapOfferLike[] = [];
  let routeFilteredOpenOffers: SwapOfferLike[] = [];
  let openOrders: SwapOfferLike[] = [];
  let offerLifecycles: OfferLifecycle[] = [];
  let closedOfferLifecycles: OfferLifecycle[] = [];
  let closedOrderViews: ClosedOrderView[] = [];
  let filteredClosedOrderViews: ClosedOrderView[] = [];
  let wantTokenPresentInAccount = false;
  let availableGiveCapacity = 0n;
  let availableWantInCapacity = 0n;
  let autoInboundCreditTarget: bigint | null = null;
  let currentPeerCreditLimit = 0n;
  let formattedAvailableGiveAmount = '0';
  let formattedAvailableGive = '0';
  let formattedAvailableWantInAmount = '0';
  let formattedAvailableWantIn = '0';
  let targetCapacityAmount = 0n;
  let formattedTargetCapacityAmount = '0';
  let targetCapacityLabel = '0';
  let autoInboundCreditIncrease = 0n;
  let canAutoPrepareInboundCapacity = false;
  let swapRouteMode: 'same' | 'cross' = 'same';
  let selectedRouteValue = 'same';
  let liveSelectedRouteValue = 'same';
  let committedRouteSelectionValue = 'same';
  let routeSelectionCommitNonce = 0;
  let routeSelectElement: HTMLSelectElement | null = null;
  let lastRouteSelectNativeSyncKey = '';
  let routeSelectNativeSyncVersion = 0;
  let selectedCrossTargetValue = '';
  let crossTargetOptions: CrossTargetOption[] = [];
  let routeOptions: SwapRouteOption[] = [];
  let visibleRouteOptions: SwapRouteOption[] = [];
  let selectedRouteOption: SwapRouteOption | null = null;
  let selectedRouteOptionOverride: SwapRouteOption | null = null;
  let selectedCrossTarget: CrossTargetOption | null = null;
  let selectedCrossTargetOverride: CrossTargetOption | null = null;
  let routedRouteRecommendations: RoutedSwapRouteCandidate[] = [];
  let showManualRouteRecommendation = false;
  let lastPriceContextSignature = '';
  let preservePriceOnNextContextChange = false;
  let selectedSourceEntityValue = '';
  let routeDetailsOpen = false;
  let openTokenMenu: 'give' | 'want' | '' = '';
  let sourceMenuOpen = false;
  let routeMenuOpen = false;
  const routeMenuOpenStore = writable(false);
  let routeMenuToggleCount = 0;
  let routeMenuNativeClickCount = 0;
  let routeMenuSetCount = 0;
  let routeMenuLastSetReason = 'init';
  let ignoreOutsideMenuClickUntil = 0;
  let ignoreNextWindowMenuClick = false;
  let ignoreWindowMenuClickCount = 0;
  let hubMenuOpen = false;
  let crossTargetInCapacity = 0n;
  let selectedCrossTargetReplica: EntityReplica | null = null;
  let crossTargetHasAccount = false;
  let needsCrossTargetAccountSetup = false;
  let canAutoOpenCrossTargetAccount = false;
  let needsCrossTargetCreditSetup = false;
  let crossDesiredInboundAmount = 0n;
  let crossAutoInboundCreditTarget: bigint | null = null;
  let crossCurrentPeerCreditLimit = 0n;
  let canAutoPrepareCrossInboundCapacity = false;
  let crossSetupCreditLimitLabel = '';
  let crossSetupCreditIncreaseLabel = '';
  let crossSwapSetupSteps: CrossSwapSetupStep[] = [];
  let placingSwapOffer = false;
  let swapRuntimeView: SwapPanelRuntimeView = buildSwapPanelRuntimeView(null);

    $: activeXlnFunctions = $xlnFunctions;
    $: activeFrame = env;
    $: runtimeEnv = unwrapLiveRuntimeEnv(activeFrame);
    $: swapRuntimeView = runtimeView ?? buildSwapPanelRuntimeView(activeFrame);
    $: activeIsLive = isLive;
    $: sourceEntityOptions = buildSourceEntityOptions(swapRuntimeView, tab.entityId);
    $: if (!sourceEntityOptions.some((option) => option.value === selectedSourceEntityValue)) {
      const tabEntityId = String(tab.entityId || '').trim().toLowerCase();
      selectedSourceEntityValue = sourceEntityOptions.find((option) => option.value === tabEntityId)?.value
        || sourceEntityOptions[0]?.value
        || '';
    }
    $: selectedSourceEntity = sourceEntityOptions.find((option) => option.value === selectedSourceEntityValue) || null;
    $: currentReplica = selectedSourceEntity?.replica || replica;
    $: sourceEntityIdValue = String(currentReplica?.entityId || currentReplica?.state?.entityId || tab.entityId || '').trim().toLowerCase();
    $: sourceSignerIdValue = String(currentReplica?.signerId || tab.signerId || '').trim().toLowerCase();

    // Get available accounts (counterparties)
  $: accounts = currentReplica?.state?.accounts
    ? Array.from(currentReplica.state.accounts.keys())
    : [];
  $: baseAccountIds = accounts.map((id) => String(id)).sort();
  $: accountIds = (() => {
    const selected = String(counterpartyId || '');
    if (!selected || !baseAccountIds.includes(selected)) return baseAccountIds;
    return [selected, ...baseAccountIds.filter((id) => id !== selected)];
  })();
  function isHubAccount(accountIdValue: string): boolean {
    const normalized = String(accountIdValue || '').trim().toLowerCase();
    if (!normalized) return false;
    return swapRuntimeView.isHubEntity(normalized);
  }
  $: hubAccountIds = accountIds.filter((id) => isHubAccount(id)).slice(0, 10);
  $: hiddenAccountCount = Math.max(0, accountIds.length - hubAccountIds.length);
  $: fallbackHubAccountId = firstAvailableHubId(hubAccountIds, [
    counterpartyId,
  ], isHubAccount);
  $: if (!resolveHubIdCandidate(selectedBookAccountId, hubAccountIds, isHubAccount) && fallbackHubAccountId) {
    selectedBookAccountId = fallbackHubAccountId;
  }
  $: if (!resolveHubIdCandidate(createOrderAccountId, hubAccountIds, isHubAccount) && fallbackHubAccountId) {
    createOrderAccountId = fallbackHubAccountId;
  }
  $: if (orderbookScopeMode === 'selected' && selectedBookAccountId) {
    createOrderAccountId = selectedBookAccountId;
  }
  $: currentHubSelection = orderbookScopeMode === 'aggregated'
    ? (resolveHubIdCandidate(createOrderAccountId, hubAccountIds, isHubAccount) || fallbackHubAccountId)
    : (resolveHubIdCandidate(selectedBookAccountId, hubAccountIds, isHubAccount) || resolveHubIdCandidate(createOrderAccountId, hubAccountIds, isHubAccount) || fallbackHubAccountId);
  $: activeOrderAccountId = orderbookScopeMode === 'aggregated'
    ? (resolveHubIdCandidate(createOrderAccountId, hubAccountIds, isHubAccount) || fallbackHubAccountId)
    : (resolveHubIdCandidate(selectedBookAccountId, hubAccountIds, isHubAccount) || resolveHubIdCandidate(createOrderAccountId, hubAccountIds, isHubAccount) || fallbackHubAccountId);
  $: activeBookHubId = (() => {
    const sourceHubId = String(
      activeOrderAccountId
      || selectedRouteOption?.sourceHubEntityId
      || fallbackHubAccountId
      || selectedBookAccountId
      || createOrderAccountId
      || '',
    ).trim().toLowerCase();
    if (swapRouteMode !== 'cross' || !selectedCrossTarget || !sourceHubId) return sourceHubId;
    const sourceJurisdictionRef = getReplicaJurisdictionRef(currentReplica);
    if (!sourceJurisdictionRef || !selectedCrossTarget.targetJurisdictionRef) return sourceHubId;
    return deriveCanonicalCrossJurisdictionBookOwnerForLegs(
      sourceJurisdictionRef,
      sourceHubId,
      selectedCrossTarget.targetJurisdictionRef,
      selectedCrossTarget.targetHubEntityId,
    );
  })();
  $: orderbookHubIds = swapRouteMode === 'cross'
    ? (activeBookHubId ? [activeBookHubId] : [])
    : (
        orderbookScopeMode === 'aggregated'
          ? hubAccountIds
          : (selectedBookAccountId ? [selectedBookAccountId] : [])
      );
  $: visibleOrderbookHubIds = swapRouteMode !== 'cross' && orderbookScopeMode === 'aggregated'
    ? orderbookHubIds
    : [];
  $: activeOrderbookRelayUrl = activeBookHubId ? orderbookRelayUrlForHub(activeBookHubId) : '';
  $: orderbookDepth = orderbookScopeMode === 'aggregated'
    ? AGGREGATED_ORDERBOOK_DEPTH
    : SELECTED_ORDERBOOK_DEPTH;

  function resolveCounterpartyId(input: string): string {
    const normalized = String(input || '').trim().toLowerCase();
    if (!normalized) return '';
    const match = accountIds.find((id) => String(id || '').toLowerCase() === normalized);
    return match || String(input || '').trim();
  }
  function accountLabel(accountIdValue: string): string {
    const normalized = String(accountIdValue || '').trim().toLowerCase();
    const resolved = swapRuntimeView.entityNames.get(normalized) || '';
    return resolved || formatEntityId(accountIdValue);
  }

  function toErrorMessage(error: unknown, fallback = 'Unknown error'): string {
    return error instanceof Error && error.message ? error.message : fallback;
  }

  function logSwapDiagnostic(message: string, error: unknown, details: Record<string, unknown> = {}): void {
    errorLog.log(message, 'Swap Panel', {
      entityId: sourceEntityIdValue,
      signerId: sourceSignerIdValue,
      accountId: activeOrderAccountId,
      counterpartyId,
      routeMode: swapRouteMode,
      giveTokenId,
      wantTokenId,
      ...details,
      error,
    });
  }

  function jurisdictionLabelForAssetKey(assetKey: string): string {
    const parsed = parseCrossAssetKey(assetKey);
    if (!parsed) return sourceJurisdictionLabel;
    const sourceRef = String(getReplicaJurisdictionRef(currentReplica) || '').trim().toLowerCase();
    const targetRef = String(selectedCrossTarget?.targetJurisdictionRef || '').trim().toLowerCase();
    const ref = parsed.jurisdictionRef.toLowerCase();
    if (sourceRef && ref === sourceRef) return sourceJurisdictionLabel;
    if (targetRef && ref === targetRef) return targetJurisdictionLabel;
    return normalizeJurisdictionDisplayName(parsed.jurisdictionRef);
  }

  function entityAvatarSrc(entityIdValue: string): string {
    const normalized = String(entityIdValue || '').trim();
    if (!normalized || !activeXlnFunctions?.isReady) return '';
    return activeXlnFunctions.generateEntityAvatar?.(normalized) || '';
  }

  function hubJurisdictionLabel(entityIdValue: string): string {
    const profileJurisdiction = getProfileJurisdictionName(getHubProfile(entityIdValue));
    return profileJurisdiction || sourceJurisdictionLabel;
  }
  $: selectedHubOptions = hubAccountIds.map((id) => ({ value: id, label: accountLabel(id) }));
  $: selectedHubOption = selectedHubOptions.find((hub) => hub.value === (createOrderAccountId || activeOrderAccountId)) || null;
  $: crossTargetOptions = buildCrossTargetOptions(swapRuntimeView, sourceEntityIdValue, currentReplica);
  $: routeOptions = buildRouteOptions(sourceEntityIdValue, currentReplica, activeOrderAccountId, crossTargetOptions);
  $: visibleRouteOptions = selectedRouteOptionOverride
    && routeMatchesCurrentSource(selectedRouteOptionOverride)
    && !routeOptions.some((option) => option.value === selectedRouteOptionOverride?.value)
    ? [...routeOptions, selectedRouteOptionOverride]
    : routeOptions;
  $: liveSelectedRouteValue = selectedRouteValue || committedRouteSelectionValue || 'same';
  $: {
    const selectedRouteIsVisible = visibleRouteOptions.some((option) => option.value === liveSelectedRouteValue);
    const syncKey = `${liveSelectedRouteValue}|${routeSelectionCommitNonce}|${visibleRouteOptions.map((option) => option.value).join('|')}`;
    if (routeSelectElement && selectedRouteIsVisible && syncKey !== lastRouteSelectNativeSyncKey) {
      lastRouteSelectNativeSyncKey = syncKey;
      const expectedValue = liveSelectedRouteValue;
      routeSelectElement.value = expectedValue;
      const syncVersion = ++routeSelectNativeSyncVersion;
      void tick().then(() => {
        if (syncVersion !== routeSelectNativeSyncVersion || !routeSelectElement) return;
        const stillVisible = Array.from(routeSelectElement.options).some((option) => option.value === expectedValue);
        if (stillVisible && routeSelectElement.value !== expectedValue) {
          routeSelectElement.value = expectedValue;
        }
      });
    }
  }
  $: selectedRouteOption = visibleRouteOptions.find((option) => option.value === liveSelectedRouteValue)
    || (
      selectedRouteOptionOverride?.value === liveSelectedRouteValue
      && routeMatchesCurrentSource(selectedRouteOptionOverride)
        ? selectedRouteOptionOverride
        : null
    )
    || visibleRouteOptions[0]
    || null;
  $: swapRouteMode = selectedRouteOption?.mode === 'cross' ? 'cross' : 'same';
  $: selectedCrossTargetValue = swapRouteMode === 'cross' && selectedRouteOption ? selectedRouteOption.value : '';
  $: selectedCrossTarget = crossTargetOptions.find((option) => option.value === selectedCrossTargetValue)
    || (selectedCrossTargetOverride?.value === selectedCrossTargetValue ? selectedCrossTargetOverride : null)
    || null;
  $: routedRouteRecommendations = buildRoutedRouteCandidates(
    swapRouteMode,
    selectedCrossTarget,
    activeOrderAccountId,
    currentReplica,
    sourceJurisdictionLabel,
    giveToken,
    wantToken,
    giveAmount,
    orderbookQuoteNonce,
  )
    .filter((candidate) => candidate.hops.length > 1 && candidate.id !== 'direct-cross')
    .slice(0, 3);
  $: showManualRouteRecommendation = (
    swapRouteMode === 'cross'
    && routedRouteRecommendations.length > 0
    && String(orderbookSnapshot?.pairId || '').trim() === String(orderbookPairId || '').trim()
    && (
      orderbookSnapshot.sourceStatus === 'no-market'
      || orderbookSnapshot.sourceStatus === 'empty'
      || orderbookSnapshot.sourceStatus === 'error'
    )
  );
  $: sourceJurisdictionLabel = getReplicaJurisdictionName(currentReplica) || 'Current';
  $: targetJurisdictionLabel = swapRouteMode === 'cross' && selectedCrossTarget
    ? selectedCrossTarget.targetJurisdiction
    : sourceJurisdictionLabel;
  $: sourceRouteEntityLabel = `${accountLabel(sourceEntityIdValue)} -> ${accountLabel(String(activeOrderAccountId || ''))}`;
  $: targetRouteEntityLabel = swapRouteMode === 'cross' && selectedCrossTarget
    ? `${accountLabel(selectedCrossTarget.targetHubEntityId)} -> ${accountLabel(selectedCrossTarget.targetEntityId)}`
    : `${accountLabel(String(activeOrderAccountId || ''))} -> ${accountLabel(sourceEntityIdValue)}`;
  $: sourceChainLabel = selectedSourceEntity?.jurisdiction || sourceJurisdictionLabel;
  $: selectedRouteUnavailableReason = selectedRouteOption?.disabledReason || '';
  $: routeVenueLabel = activeOrderAccountId ? accountLabel(activeOrderAccountId) : 'Select venue';
  $: bookVenueLabel = activeBookHubId ? accountLabel(activeBookHubId) : routeVenueLabel;
  $: selectedSourceEntityLabel = selectedSourceEntity?.label || sourceChainLabel || '';
  $: selectedRouteLabel = selectedRouteOption?.label || '';
  $: selectedRouteEntityId = swapRouteMode === 'cross'
    ? (selectedRouteOption?.targetEntityId || selectedCrossTarget?.targetEntityId || '')
    : sourceEntityIdValue;
  $: selectedRouteEntityName = swapRouteMode === 'cross'
    ? accountLabel(selectedRouteEntityId)
    : accountLabel(sourceEntityIdValue);
  $: selectedRouteJurisdictionLabel = swapRouteMode === 'cross'
    ? (selectedRouteOption?.targetJurisdiction || targetJurisdictionLabel)
    : sourceJurisdictionLabel;
  $: selectedHubLabel = selectedHubOption?.label || routeVenueLabel || '';
  $: selectedHubJurisdictionLabel = hubJurisdictionLabel(createOrderAccountId || activeOrderAccountId) || sourceJurisdictionLabel;
  $: selectedHubDisplayLabel = (createOrderAccountId || activeOrderAccountId)
    ? formatEntityNetworkLabel(selectedHubLabel, selectedHubJurisdictionLabel)
    : 'Select hub';
  $: routePathSourceLabel = sourceJurisdictionLabel || selectedRouteOption?.sourceJurisdiction || 'Current';
  $: routePathTargetLabel = swapRouteMode === 'cross'
    ? (targetJurisdictionLabel || selectedRouteOption?.targetJurisdiction || selectedCrossTarget?.targetJurisdiction || 'Target')
    : routePathSourceLabel;
  $: routePathLabel = swapRouteMode === 'cross'
    ? `${routePathSourceLabel} -> ${routePathTargetLabel}`
    : routePathSourceLabel;
  $: routeVenueDisplayLabel = activeOrderAccountId
    ? formatEntityNetworkLabel(routeVenueLabel, hubJurisdictionLabel(activeOrderAccountId) || sourceJurisdictionLabel)
    : routeVenueLabel || accountLabel(selectedRouteOption?.sourceHubEntityId || '') || 'Select venue';
  $: routeSummaryLabel = swapRouteMode === 'cross' ? 'Direct route' : 'Same account';
  $: routeSummaryAssetsLabel = swapRouteMode === 'cross'
    ? `${tokenNetworkLabel(giveToken, sourceJurisdictionLabel, tokenSymbol)} -> ${tokenNetworkLabel(wantToken, targetJurisdictionLabel, tokenSymbol)}`
    : `${giveTokenSymbol} -> ${wantTokenSymbol}`;
  $: swapTokenPairLabel = `${giveTokenSymbol} -> ${wantTokenSymbol}`;
  $: selectedCrossTargetReplica = selectedCrossTarget ? findReplicaByEntityId(selectedCrossTarget.targetEntityId) : null;
  $: crossTargetHasAccount = Boolean(
    swapRouteMode === 'cross'
    && selectedCrossTarget
    && selectedCrossTarget.targetHubEntityId
    && hasReplicaAccount(selectedCrossTargetReplica, selectedCrossTarget.targetHubEntityId)
  );
  $: targetAccountReady = swapRouteMode !== 'cross' || crossTargetHasAccount;
  $: needsCrossTargetAccountSetup = Boolean(
    swapRouteMode === 'cross'
    && selectedCrossTarget
    && !crossTargetHasAccount
  );
  $: canAutoOpenCrossTargetAccount = Boolean(
    needsCrossTargetAccountSetup
    && selectedCrossTarget
    && selectedCrossTargetReplica
    && selectedCrossTarget.targetHubEntityId
    && activeIsLive
  );
  $: orderbookSourceLabels = Object.fromEntries(
    orderbookHubIds.map((id) => [id, accountLabel(id)]),
  );
  $: orderbookSourceAvatars = Object.fromEntries(
    orderbookHubIds.map((id) => [id, activeXlnFunctions?.isReady ? (activeXlnFunctions.generateEntityAvatar?.(id) || '') : '']),
  );

  type CrossTargetOption = {
    value: string;
    label: string;
    targetEntityId: string;
    targetSignerId: string;
    targetHubEntityId: string;
    targetJurisdiction: string;
    targetJurisdictionRef: string;
    hasTargetAccount: boolean;
  };
  type SourceEntityOption = {
    value: string;
    label: string;
    name: string;
    entityId: string;
    signerId: string;
    jurisdiction: string;
    replica: EntityReplica;
  };
  type SwapRouteOption = {
    value: string;
    label: string;
    mode: 'same' | 'cross';
    sourceJurisdiction: string;
    targetJurisdiction: string;
    sourceEntityId: string;
    sourceHubEntityId: string;
    targetEntityId: string;
    targetHubEntityId: string;
    sourceJurisdictionRef: string;
    targetJurisdictionRef: string;
    targetLabel: string;
    disabled?: boolean;
    disabledReason?: string;
  };
  type CrossMarketView = {
    venueId: string;
    sourceIsBase: boolean;
    sourceKey: string;
    targetKey: string;
    baseKey: string;
    quoteKey: string;
  };

  function getAccountDelta(counterpartyEntityId: string, tokenIdValue: number): { delta: Delta; isLeft: boolean } | null {
    if (!counterpartyEntityId || !Number.isFinite(tokenIdValue) || tokenIdValue <= 0 || !sourceEntityIdValue) return null;
    const resolvedCounterparty = resolveCounterpartyId(counterpartyEntityId);
    const account = currentReplica?.state?.accounts?.get?.(resolvedCounterparty);
    const deltas = account?.deltas as TokenKeyedMap<Delta> | undefined;
    if (!(deltas instanceof Map)) return null;
    const delta = getTokenMapValue(deltas, tokenIdValue);
    if (!delta) return null;
    return {
      delta,
      isLeft: sourceEntityIdValue < String(resolvedCounterparty).toLowerCase(),
    };
  }

  function getReplicaJurisdictionName(candidate: EntityReplica | null | undefined): string {
    const state = candidate?.state as { config?: { jurisdiction?: { name?: unknown } } } | undefined;
    const byConfig = String(state?.config?.jurisdiction?.name || '').trim();
    if (byConfig) return normalizeJurisdictionDisplayName(byConfig);
    const byPosition = String(candidate?.position?.jurisdiction || '').trim();
    if (byPosition) return normalizeJurisdictionDisplayName(byPosition);
    return '';
  }

  function getReplicaJurisdictionRef(candidate: EntityReplica | null | undefined): string {
    const state = candidate?.state as {
      config?: { jurisdiction?: { chainId?: unknown; depositoryAddress?: unknown; name?: unknown } };
    } | undefined;
    const stackId = getJurisdictionStackId(state?.config?.jurisdiction);
    if (stackId) return stackId;
    return '';
  }

  function getAccountDeltaForReplica(
    candidate: EntityReplica | null | undefined,
    ownerEntityId: string,
    counterpartyEntityId: string,
    tokenIdValue: number,
  ): { delta: Delta; isLeft: boolean } | null {
    const owner = String(ownerEntityId || '').trim();
    const counterparty = String(counterpartyEntityId || '').trim();
    if (!candidate || !owner || !counterparty || !Number.isFinite(tokenIdValue) || tokenIdValue <= 0) return null;
    const account = candidate.state?.accounts?.get?.(counterparty);
    const deltas = account?.deltas as TokenKeyedMap<Delta> | undefined;
    if (!(deltas instanceof Map)) return null;
    const delta = getTokenMapValue(deltas, tokenIdValue);
    if (!delta) return null;
    return {
      delta,
      isLeft: owner.toLowerCase() < counterparty.toLowerCase(),
    };
  }

  function hasTokenInReplicaAccount(
    candidate: EntityReplica | null | undefined,
    ownerEntityId: string,
    counterpartyEntityId: string,
    tokenIdValue: number,
  ): boolean {
    if (!candidate || !counterpartyEntityId || !Number.isFinite(tokenIdValue) || tokenIdValue <= 0) return false;
    const account = candidate.state?.accounts?.get?.(counterpartyEntityId);
    const deltas = account?.deltas as TokenKeyedMap<Delta> | undefined;
    if (!(deltas instanceof Map)) return false;
    return getTokenMapValue(deltas, tokenIdValue) !== undefined;
  }

  function readInCapacityForReplica(
    candidate: EntityReplica | null | undefined,
    ownerEntityId: string,
    counterpartyEntityId: string,
    tokenIdValue: number,
  ): bigint {
    const accountDelta = getAccountDeltaForReplica(candidate, ownerEntityId, counterpartyEntityId, tokenIdValue);
    if (!accountDelta || !activeXlnFunctions?.deriveDelta) return 0n;
    try {
      const derived = activeXlnFunctions.deriveDelta(accountDelta.delta, accountDelta.isLeft);
      const inCapacityRaw = (derived as { inCapacity?: unknown })?.inCapacity;
      if (typeof inCapacityRaw === 'bigint') return inCapacityRaw;
      return toBigIntSafe(inCapacityRaw) ?? 0n;
    } catch {
      return 0n;
    }
  }

  function buildSourceEntityOptions(
    view: SwapPanelRuntimeView = swapRuntimeView,
    currentEntityId = String(tab.entityId || '').trim().toLowerCase(),
  ): SourceEntityOption[] {
    const options = view.localReplicas
      .map((candidate) => {
        const entityId = String(candidate.entityId || candidate.state?.entityId || '').trim().toLowerCase();
        const signerId = String(candidate.signerId || '').trim().toLowerCase();
        const jurisdiction = getReplicaJurisdictionName(candidate);
        if (!entityId || !signerId || !jurisdiction) return null;
        const name = accountLabel(entityId);
        return {
          value: entityId,
          label: formatEntityNetworkLabel(name, jurisdiction),
          name,
          entityId,
          signerId,
          jurisdiction,
          replica: candidate,
        } satisfies SourceEntityOption;
      })
      .filter((option): option is SourceEntityOption => option !== null);
    return options.sort((a, b) => {
      const current = String(currentEntityId || '').trim().toLowerCase();
      if (a.entityId === current && b.entityId !== current) return -1;
      if (b.entityId === current && a.entityId !== current) return 1;
      return compareStableText(a.label, b.label);
    });
  }

  function getProfileJurisdictionName(profile: GossipProfile | undefined | null): string {
    return normalizeJurisdictionDisplayName(profile?.metadata?.jurisdiction?.name);
  }

  function getHubProfile(entityIdValue: string): GossipProfile | null {
    return swapRuntimeView.getHubProfile(entityIdValue);
  }

  function orderbookRelayUrlForHub(entityIdValue: string): string {
    const profile = getHubProfile(entityIdValue);
    const relays = Array.isArray(profile?.relays) ? profile.relays : [];
    return String(relays.find((value) => String(value || '').trim()) || '').trim();
  }

  function hubBaseName(profile: GossipProfile | null): string {
    return String(profile?.name || profile?.entityId || '').trim().split(/\s+/)[0]?.toLowerCase() || '';
  }

  function hubMirrorsEntity(profile: GossipProfile | null, entityIdValue: string): boolean {
    const normalized = String(entityIdValue || '').trim().toLowerCase();
    if (!profile || !normalized) return false;
    const mirrors = profile.metadata?.mirrors;
    if (!Array.isArray(mirrors)) return false;
    return mirrors.some((mirror) => String(mirror?.entityId || '').trim().toLowerCase() === normalized);
  }

  function hubRouteCompatible(sourceHubEntityId: string, targetHubEntityId: string): boolean {
    const sourceHub = getHubProfile(sourceHubEntityId);
    const targetHub = getHubProfile(targetHubEntityId);
    if (!sourceHub || !targetHub) return false;
    if (hubMirrorsEntity(sourceHub, targetHub.entityId) || hubMirrorsEntity(targetHub, sourceHub.entityId)) return true;
    const sourceRuntime = String(sourceHub.runtimeId || '').trim().toLowerCase();
    const targetRuntime = String(targetHub.runtimeId || '').trim().toLowerCase();
    if (sourceRuntime && sourceRuntime === targetRuntime) return true;
    const sourceBase = hubBaseName(sourceHub);
    const targetBase = hubBaseName(targetHub);
    return Boolean(sourceBase && sourceBase === targetBase);
  }

  function findHubProfileForJurisdiction(jurisdictionName: string): GossipProfile | null {
    const normalized = String(jurisdictionName || '').trim().toLowerCase();
    if (!normalized) return null;
    const profiles = swapRuntimeView.profiles
      .filter((profile) => profile?.metadata?.isHub === true)
      .filter((profile) => getProfileJurisdictionName(profile).toLowerCase() === normalized);
    return profiles.sort((a, b) => compareStableText(String(a.name || a.entityId), String(b.name || b.entityId)))[0] || null;
  }

  function findHubProfilesForJurisdiction(jurisdictionName: string): GossipProfile[] {
    const normalized = String(jurisdictionName || '').trim().toLowerCase();
    if (!normalized) return [];
    return swapRuntimeView.profiles
      .filter((profile) => profile?.metadata?.isHub === true)
      .filter((profile) => getProfileJurisdictionName(profile).toLowerCase() === normalized)
      .sort((a, b) => compareStableText(String(a.name || a.entityId), String(b.name || b.entityId)));
  }

  function buildCrossTargetOptions(
    view: SwapPanelRuntimeView = swapRuntimeView,
    sourceEntityId = sourceEntityIdValue,
    sourceReplica: EntityReplica | null | undefined = currentReplica,
  ): CrossTargetOption[] {
    const sourceJurisdiction = getReplicaJurisdictionName(sourceReplica);
    const sourceJurisdictionRef = getReplicaJurisdictionRef(sourceReplica);
    if (!sourceEntityId || !sourceJurisdiction || !sourceJurisdictionRef) return [];
    const options: CrossTargetOption[] = [];
    for (const candidate of view.localReplicas) {
      const targetEntityId = String(candidate.entityId || candidate.state?.entityId || '').trim().toLowerCase();
      if (!targetEntityId || targetEntityId === sourceEntityId) continue;
      const targetJurisdiction = getReplicaJurisdictionName(candidate);
      const targetJurisdictionRef = getReplicaJurisdictionRef(candidate);
      if (!targetJurisdiction || !targetJurisdictionRef || targetJurisdictionRef === sourceJurisdictionRef) continue;
      const targetSignerId = String(candidate.signerId || '').trim();
      if (!targetSignerId) continue;
      const accountHubIds = Array.from(candidate.state?.accounts?.keys?.() || [])
        .map((id) => String(id || '').trim())
        .filter((id) => id && isHubAccount(id))
        .sort(compareStableText);
      const fallbackHub = findHubProfileForJurisdiction(targetJurisdiction)?.entityId || '';
      const targetHubIds = Array.from(new Set([
        ...accountHubIds,
        ...findHubProfilesForJurisdiction(targetJurisdiction)
          .map((profile) => String(profile.entityId || '').trim())
          .filter(Boolean),
        ...(fallbackHub ? [fallbackHub] : []),
      ].map((id) => id.toLowerCase()).filter(Boolean))).sort(compareStableText);
      for (const targetHubEntityId of targetHubIds) {
        const hasTargetAccount = accountHubIds.some((id) => id.toLowerCase() === targetHubEntityId.toLowerCase());
        options.push({
          value: `${targetEntityId}:${targetHubEntityId}`,
          label: `${targetJurisdiction} · ${accountLabel(targetHubEntityId)}${hasTargetAccount ? '' : ' · setup required'}`,
          targetEntityId,
          targetSignerId,
          targetHubEntityId,
          targetJurisdiction,
          targetJurisdictionRef,
          hasTargetAccount,
        });
      }
    }
    return options.sort((a, b) => compareStableText(a.label, b.label));
  }

  function buildRouteOptions(
    sourceEntityId = sourceEntityIdValue,
    sourceReplica: EntityReplica | null | undefined = currentReplica,
    selectedHubEntityId = activeOrderAccountId,
    targets: CrossTargetOption[] = crossTargetOptions,
  ): SwapRouteOption[] {
    const sourceJurisdiction = getReplicaJurisdictionName(sourceReplica) || 'Current';
    const sourceJurisdictionRef = getReplicaJurisdictionRef(sourceReplica) || sourceJurisdiction;
    const sourceHubEntityId = String(selectedHubEntityId || '').trim().toLowerCase();
    const options: SwapRouteOption[] = [{
      value: 'same',
      label: 'Same account',
      mode: 'same',
      sourceJurisdiction,
      targetJurisdiction: sourceJurisdiction,
      sourceEntityId,
      sourceHubEntityId,
      targetEntityId: sourceEntityId,
      targetHubEntityId: sourceHubEntityId,
      sourceJurisdictionRef,
      targetJurisdictionRef: sourceJurisdictionRef,
      targetLabel: accountLabel(sourceEntityId),
    }];

    const groupedTargets = new Map<string, CrossTargetOption[]>();
    for (const target of targets) {
      const key = `${target.targetJurisdictionRef}:${target.targetEntityId}`;
      groupedTargets.set(key, [...(groupedTargets.get(key) || []), target]);
    }

    for (const group of groupedTargets.values()) {
      const sortedGroup = [...group].sort((a, b) => {
        const aCompatible = sourceHubEntityId && hubRouteCompatible(sourceHubEntityId, a.targetHubEntityId);
        const bCompatible = sourceHubEntityId && hubRouteCompatible(sourceHubEntityId, b.targetHubEntityId);
        if (aCompatible !== bCompatible) return aCompatible ? -1 : 1;
        if (a.hasTargetAccount !== b.hasTargetAccount) return a.hasTargetAccount ? -1 : 1;
        return compareStableText(accountLabel(a.targetHubEntityId), accountLabel(b.targetHubEntityId));
      });
      const target = sortedGroup[0];
      if (!target) continue;
      // User chooses the recipient entity, not the internal target hub leg. The
      // matching sibling hub is selected here from the active source hub.
      const compatible = Boolean(sourceHubEntityId && hubRouteCompatible(sourceHubEntityId, target.targetHubEntityId));
      const recipientLabel = formatEntityNetworkLabel(accountLabel(target.targetEntityId), target.targetJurisdiction);
      const disabledReason = compatible
        ? ''
        : `Try another hub: ${accountLabel(sourceHubEntityId)} has no sibling on ${target.targetJurisdiction}.`;
      options.push({
        value: target.value,
        label: recipientLabel,
        mode: 'cross',
        sourceJurisdiction,
        targetJurisdiction: target.targetJurisdiction,
        sourceJurisdictionRef,
        targetJurisdictionRef: target.targetJurisdictionRef,
        sourceEntityId,
        sourceHubEntityId,
        targetEntityId: target.targetEntityId,
        targetHubEntityId: target.targetHubEntityId,
        targetLabel: target.label,
        disabledReason,
      });
    }
    return options;
  }

  function routeMatchesCurrentSource(route: SwapRouteOption | null | undefined): boolean {
    if (!route) return false;
    const currentSourceEntityId = String(sourceEntityIdValue || '').trim().toLowerCase();
    const routeSourceEntityId = String(route.sourceEntityId || '').trim().toLowerCase();
    if (currentSourceEntityId && routeSourceEntityId && currentSourceEntityId !== routeSourceEntityId) return false;
    const currentSourceRef = String(getReplicaJurisdictionRef(currentReplica) || '').trim().toLowerCase();
    const routeSourceRef = String(route.sourceJurisdictionRef || '').trim().toLowerCase();
    if (currentSourceRef && routeSourceRef && currentSourceRef !== routeSourceRef) return false;
    if (route.mode === 'cross') {
      const routeTargetEntityId = String(route.targetEntityId || '').trim().toLowerCase();
      const routeTargetRef = String(route.targetJurisdictionRef || '').trim().toLowerCase();
      if (currentSourceEntityId && routeTargetEntityId && currentSourceEntityId === routeTargetEntityId) return false;
      if (currentSourceRef && routeTargetRef && currentSourceRef === routeTargetRef) return false;
    }
    return true;
  }

  function buildCommittedRouteSelectionFromDom(node: HTMLSelectElement | null, value: string): {
    route: SwapRouteOption;
    target: CrossTargetOption | null;
  } | null {
    const cleanValue = String(value || '').trim();
    if (!cleanValue) return null;
    const existingRoute = visibleRouteOptions.find((option) => option.value === cleanValue);
    const existingTarget = crossTargetOptions.find((option) => option.value === cleanValue) || null;
    if (existingRoute) {
      return { route: existingRoute, target: existingTarget };
    }
    if (cleanValue === 'same') return visibleRouteOptions[0] ? { route: visibleRouteOptions[0], target: null } : null;
    const [targetEntityIdRaw, targetHubEntityIdRaw] = cleanValue.split(':');
    const targetEntityId = String(targetEntityIdRaw || '').trim().toLowerCase();
    const targetHubEntityId = String(targetHubEntityIdRaw || '').trim().toLowerCase();
    if (!targetEntityId || !targetHubEntityId) return null;
    const targetReplica = findReplicaByEntityId(targetEntityId);
    const sourceHubEntityId = String(activeOrderAccountId || selectedBookAccountId || createOrderAccountId || '').trim().toLowerCase();
    const sourceJurisdiction = String(sourceJurisdictionLabel || getReplicaJurisdictionName(currentReplica) || '').trim() || 'Current';
    const sourceJurisdictionRef = String(getReplicaJurisdictionRef(currentReplica) || sourceJurisdiction).trim() || sourceJurisdiction;
    const targetJurisdiction = String(existingTarget?.targetJurisdiction || getReplicaJurisdictionName(targetReplica) || '').trim() || 'Target';
    const targetJurisdictionRef = String(existingTarget?.targetJurisdictionRef || getReplicaJurisdictionRef(targetReplica) || targetJurisdiction).trim() || targetJurisdiction;
    const label = String(
      Array.from(node?.options || []).find((option) => option.value === cleanValue)?.textContent
      || existingTarget?.label
      || formatEntityNetworkLabel(accountLabel(targetEntityId), targetJurisdiction),
    ).trim();
    const hasTargetAccount = existingTarget?.hasTargetAccount ?? hasReplicaAccount(targetReplica, targetHubEntityId);
    const target: CrossTargetOption = existingTarget || {
      value: cleanValue,
      label,
      targetEntityId,
      targetSignerId: String(targetReplica?.signerId || '').trim(),
      targetHubEntityId,
      targetJurisdiction,
      targetJurisdictionRef,
      hasTargetAccount,
    };
    const route: SwapRouteOption = {
      value: cleanValue,
      label: formatEntityNetworkLabel(accountLabel(targetEntityId), targetJurisdiction),
      mode: 'cross',
      sourceJurisdiction,
      targetJurisdiction,
      sourceJurisdictionRef,
      targetJurisdictionRef,
      sourceEntityId: sourceEntityIdValue,
      sourceHubEntityId,
      targetEntityId,
      targetHubEntityId,
      targetLabel: label,
      disabledReason: '',
    };
    return { route, target };
  }

  function defaultTradingPairOrientations(): Array<{ baseTokenId: number; quoteTokenId: number; pairId: string }> {
    const runtimeRequiredPairs = activeXlnFunctions?.getDefaultSwapTradingPairs?.() || [];
    const requiredPairs = runtimeRequiredPairs.length > 0
      ? runtimeRequiredPairs.map((pair) => resolvePairOrientation(Number(pair.baseTokenId), Number(pair.quoteTokenId)))
      : [
          resolvePairOrientation(1, 2),
          resolvePairOrientation(2, 3),
          resolvePairOrientation(1, 3),
        ];
    const seen = new Set<string>();
    return requiredPairs.filter((pair) => {
      const key = `${pair.baseTokenId}/${pair.quoteTokenId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function tradingPairsForHub(hubId: string): Array<{ baseTokenId: number; quoteTokenId: number; pairId: string }> {
    const normalizedHubId = String(hubId || '').trim().toLowerCase();
    const hubReplica = normalizedHubId ? findReplicaByEntityId(normalizedHubId) : null;
    const configuredPairs = Array.isArray(hubReplica?.state?.swapTradingPairs)
      ? hubReplica.state.swapTradingPairs
      : [];
    const rawPairs = [...configuredPairs, ...defaultTradingPairOrientations()];
    const out: Array<{ baseTokenId: number; quoteTokenId: number; pairId: string }> = [];
    const seen = new Set<string>();
    for (const pair of rawPairs) {
      const rawBase = Number(pair?.baseTokenId);
      const rawQuote = Number(pair?.quoteTokenId);
      if (!Number.isFinite(rawBase) || !Number.isFinite(rawQuote) || rawBase <= 0 || rawQuote <= 0 || rawBase === rawQuote) {
        continue;
      }
      const oriented = resolvePairOrientation(rawBase, rawQuote);
      const key = `${oriented.baseTokenId}/${oriented.quoteTokenId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(oriented);
    }
    return out;
  }

  function cacheOrderbookSnapshot(snapshot: OrderbookSnapshot): void {
    const pairIdValue = String(snapshot?.pairId || '').trim();
    if (!pairIdValue) return;
    if (snapshot.sourceStatus === 'syncing' || snapshot.sourceStatus === 'error') return;
    const hubIds = (snapshot?.hubIds || [])
      .map((id) => String(id || '').trim().toLowerCase())
      .filter(Boolean);
    if (hubIds.length !== 1) return;
    const cacheKey = orderbookSnapshotCacheKey(hubIds[0]!, pairIdValue);
    orderbookSnapshotCache.set(cacheKey, {
      ...snapshot,
      hubIds,
    });
    const nextSignature = orderbookSnapshotSignature(snapshot);
    const now = Date.now();
    const lastBumpedAt = orderbookSnapshotCacheBumpedAt.get(cacheKey) || 0;
    if (orderbookSnapshotCacheSignatures.get(cacheKey) !== nextSignature || now - lastBumpedAt >= 1_000) {
      orderbookSnapshotCacheSignatures.set(cacheKey, nextSignature);
      orderbookSnapshotCacheBumpedAt.set(cacheKey, now);
      orderbookQuoteNonce += 1;
    }
  }

  function readCachedOrderbookSnapshot(hubEntityId: string, pairIdValue: string): OrderbookSnapshot | null {
    const snapshot = orderbookSnapshotCache.get(orderbookSnapshotCacheKey(hubEntityId, pairIdValue));
    if (!snapshot) return null;
    const status = snapshot.sourceStatus;
    if (status === 'syncing' || status === 'error') return null;
    const updatedAt = Number(snapshot.updatedAt || 0);
    if (!Number.isFinite(updatedAt) || updatedAt <= 0) return null;
    if (Date.now() - updatedAt > ORDERBOOK_SNAPSHOT_FRESH_MS) return null;
    return snapshot;
  }

  function estimateHopOutput(hop: RoutedSwapHop, inputAmount: bigint): RouteQuote {
    return estimateRoutedHopOutput({
      hop,
      inputAmount,
      readCachedOrderbookSnapshot,
      readPairBook,
      getBestBid,
      getBestAsk,
      quoteFromBase,
      baseFromQuote,
      getTokenDecimals,
      tokenSymbol,
      accountLabel,
    });
  }

  function buildRoutedRouteCandidates(
    mode = swapRouteMode,
    target = selectedCrossTarget,
    sourceHubInput = activeOrderAccountId,
    sourceReplica: EntityReplica | null | undefined = currentReplica,
    sourceJurisdiction = sourceJurisdictionLabel,
    sourceToken = giveToken,
    targetToken = wantToken,
    quoteInputAmount = 0n,
    _quoteNonce = orderbookQuoteNonce,
  ): RoutedSwapRouteCandidate[] {
    void _quoteNonce;
    return buildRoutedRouteCandidatesPure({
      mode,
      target,
      sourceHubId: String(sourceHubInput || '').trim().toLowerCase(),
      sourceJurisdictionRef: getReplicaJurisdictionRef(sourceReplica),
      sourceJurisdiction,
      sourceToken,
      targetToken,
      quoteInputAmount,
      allowedSwapTokenIds,
      resolvePairOrientation,
      tradingPairsForHub,
      isLiquidToken,
      tokenSymbol,
      compareStableText,
      formatAmount,
      estimateHopOutput,
    });
  }

  function manualRouteEstimateLabel(route: RoutedSwapRouteCandidate): string {
    if (route.estimatedOutAmount !== null) return `Approx. ${route.estimatedOutLabel}`;
    if (giveAmount > 0n) return 'Quote each hop manually';
    return 'Enter amount for an estimate';
  }

  type PairOption = {
    value: string;
    label: string;
    pairId: string;
    baseTokenId: number;
    quoteTokenId: number;
    liquidScore: number;
  };


  function resolvePairOrientation(tokenA: number, tokenB: number): { baseTokenId: number; quoteTokenId: number; pairId: string } {
    const runtimeResolver = activeXlnFunctions?.getSwapPairOrientation;
    if (runtimeResolver) return runtimeResolver(tokenA, tokenB);
    const left = Math.min(tokenA, tokenB);
    const right = Math.max(tokenA, tokenB);
    const pairId = `${left}/${right}`;
    const isLiquid = (id: number) => id === 1 || id === 3;
    if (isLiquid(tokenA) && !isLiquid(tokenB)) return { baseTokenId: tokenB, quoteTokenId: tokenA, pairId };
    if (!isLiquid(tokenA) && isLiquid(tokenB)) return { baseTokenId: tokenA, quoteTokenId: tokenB, pairId };
    return { baseTokenId: left, quoteTokenId: right, pairId };
  }

  function isLiquidToken(tokenIdValue: number): boolean {
    const runtimeChecker = activeXlnFunctions?.isLiquidSwapToken;
    if (runtimeChecker) return runtimeChecker(tokenIdValue);
    return tokenIdValue === 1 || tokenIdValue === 3;
  }

  function tokenIdsForJurisdiction(jurisdiction: string): number[] {
    const cleanJurisdiction = String(jurisdiction || '').trim();
    if (!cleanJurisdiction) return [];
    const resolver = activeXlnFunctions?.getTokenIdsForJurisdiction;
    if (!resolver) return [1, 2, 3];
    try {
      return resolver(cleanJurisdiction)
        .map((tokenId) => Number(tokenId))
        .filter((tokenId) => Number.isFinite(tokenId) && tokenId > 0);
    } catch {
      return [1, 2, 3];
    }
  }

  function buildPairOrientationsForTokenIds(tokenIds: number[]): Array<{ baseTokenId: number; quoteTokenId: number; pairId: string }> {
    const unique = Array.from(new Set(
      tokenIds
        .map((tokenId) => Math.floor(Number(tokenId) || 0))
        .filter((tokenId) => Number.isFinite(tokenId) && tokenId > 0),
    )).sort((a, b) => a - b);
    const pairs: Array<{ baseTokenId: number; quoteTokenId: number; pairId: string }> = [];
    const seen = new Set<string>();
    for (let i = 0; i < unique.length; i += 1) {
      for (let j = i + 1; j < unique.length; j += 1) {
        const oriented = resolvePairOrientation(unique[i]!, unique[j]!);
        const key = `${oriented.baseTokenId}/${oriented.quoteTokenId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        pairs.push(oriented);
      }
    }
    return pairs;
  }

  function buildPairOptions(jurisdiction: string): PairOption[] {
    const runtimeRequiredPairs = activeXlnFunctions?.getDefaultSwapTradingPairs?.() || [];
    const jurisdictionPairs = buildPairOrientationsForTokenIds(tokenIdsForJurisdiction(jurisdiction));
    const requiredPairCandidates = [
      ...runtimeRequiredPairs.map((pair) => resolvePairOrientation(Number(pair.baseTokenId), Number(pair.quoteTokenId))),
      ...jurisdictionPairs,
    ];
    const requiredPairs = requiredPairCandidates.length > 0
      ? requiredPairCandidates
      : [
        resolvePairOrientation(1, 2), // WETH/USDC
        resolvePairOrientation(2, 3), // WETH/USDT
        resolvePairOrientation(1, 3), // USDC/USDT
      ];
    const allowedPairKeys = new Set(requiredPairs.map((pair) => `${pair.baseTokenId}/${pair.quoteTokenId}`));
    const configuredPairs = Array.isArray(currentReplica?.state?.swapTradingPairs)
      ? currentReplica.state.swapTradingPairs
      : [];
    const out: PairOption[] = [];
    const seen = new Set<string>();
    for (const pair of configuredPairs) {
      const rawBase = Number(pair?.baseTokenId);
      const rawQuote = Number(pair?.quoteTokenId);
      if (!Number.isFinite(rawBase) || !Number.isFinite(rawQuote) || rawBase <= 0 || rawQuote <= 0 || rawBase === rawQuote) {
        continue;
      }
      const oriented = resolvePairOrientation(rawBase, rawQuote);
      const value = `${oriented.baseTokenId}/${oriented.quoteTokenId}`;
      if (!allowedPairKeys.has(value)) continue;
      if (seen.has(value)) continue;
      seen.add(value);
      const baseSymbol = tokenSymbol(oriented.baseTokenId);
      const quoteSymbol = tokenSymbol(oriented.quoteTokenId);
      const liquidScore = isLiquidToken(oriented.quoteTokenId) ? 1 : 0;
      out.push({
        value,
        label: `${baseSymbol}/${quoteSymbol}`,
        pairId: oriented.pairId,
        baseTokenId: oriented.baseTokenId,
        quoteTokenId: oriented.quoteTokenId,
        liquidScore,
      });
    }
    for (const pair of requiredPairs) {
      const value = `${pair.baseTokenId}/${pair.quoteTokenId}`;
      if (seen.has(value)) continue;
      const baseSymbol = tokenSymbol(pair.baseTokenId);
      const quoteSymbol = tokenSymbol(pair.quoteTokenId);
      const liquidScore = isLiquidToken(pair.quoteTokenId) ? 1 : 0;
      out.push({
        value,
        label: `${baseSymbol}/${quoteSymbol}`,
        pairId: pair.pairId,
        baseTokenId: pair.baseTokenId,
        quoteTokenId: pair.quoteTokenId,
        liquidScore,
      });
    }

    const primary = resolvePairOrientation(1, 2); // WETH/USDC
    const primaryKey = `${primary.baseTokenId}/${primary.quoteTokenId}`;

    return out.sort((a, b) => {
      const aKey = `${a.baseTokenId}/${a.quoteTokenId}`;
      const bKey = `${b.baseTokenId}/${b.quoteTokenId}`;
      if (aKey === primaryKey && bKey !== primaryKey) return -1;
      if (bKey === primaryKey && aKey !== primaryKey) return 1;
      if (a.liquidScore !== b.liquidScore) return b.liquidScore - a.liquidScore;
      return compareStableText(a.label, b.label);
    });
  }

  function crossAssetLabelForRoute(assetKey: string, route: SwapRouteOption): string {
    const parsed = parseCrossAssetKey(assetKey);
    if (!parsed) return sourceJurisdictionLabel;
    const ref = parsed.jurisdictionRef.toLowerCase();
    if (ref === String(route.sourceJurisdictionRef || '').toLowerCase()) return route.sourceJurisdiction;
    if (ref === String(route.targetJurisdictionRef || '').toLowerCase()) return route.targetJurisdiction;
    return normalizeJurisdictionDisplayName(parsed.jurisdictionRef);
  }

  function buildSameOrderbookPairOptions(hubId: string): SwapOrderbookPairOption[] {
    const hub = String(hubId || '').trim().toLowerCase();
    if (!hub) return [];
    const jurisdictionRef = getReplicaJurisdictionRef(currentReplica) || sourceJurisdictionLabel;
    return tradingPairsForHub(hub).map((pair) => ({
      value: `same:${pair.pairId}`,
      label: sameOrderbookPairLabel(pair.baseTokenId, pair.quoteTokenId, sourceJurisdictionLabel, tokenSymbol),
      mode: 'same',
      pairId: pair.pairId,
      baseTokenId: pair.baseTokenId,
      quoteTokenId: pair.quoteTokenId,
      sourceTokenId: pair.baseTokenId,
      targetTokenId: pair.quoteTokenId,
      routeValue: 'same',
      sourceJurisdiction: sourceJurisdictionLabel,
      targetJurisdiction: sourceJurisdictionLabel,
      sourceJurisdictionRef: jurisdictionRef,
      targetJurisdictionRef: jurisdictionRef,
    }));
  }

  function buildCrossOrderbookPairOptions(): SwapOrderbookPairOption[] {
    const sourceTokens = tokenIdsForJurisdiction(sourceJurisdictionLabel);
    const options: SwapOrderbookPairOption[] = [];
    const routes = swapRouteMode === 'cross' && selectedRouteOption?.mode === 'cross'
      ? [selectedRouteOption]
      : [];
    for (const route of routes) {
      if (route.mode !== 'cross' || route.disabled) continue;
      const targetTokens = tokenIdsForJurisdiction(route.targetJurisdiction);
      for (const sourceTokenId of sourceTokens) {
        for (const targetTokenId of targetTokens) {
          const market = deriveCanonicalCrossJurisdictionMarketForLegs(
            route.sourceJurisdictionRef,
            sourceTokenId,
            route.targetJurisdictionRef,
            targetTokenId,
          ) as CrossMarketView;
          if (!market.sourceKey || !market.targetKey || market.sourceKey === market.targetKey) continue;
          const baseJurisdiction = crossAssetLabelForRoute(market.baseKey, route);
          const quoteJurisdiction = crossAssetLabelForRoute(market.quoteKey, route);
          const value = `cross:${route.value}:${route.sourceJurisdictionRef}:${sourceTokenId}:${route.targetJurisdictionRef}:${targetTokenId}`;
          options.push({
            value,
            label: crossOrderbookPairLabel(
              market.sourceIsBase ? sourceTokenId : targetTokenId,
              baseJurisdiction,
              market.sourceIsBase ? targetTokenId : sourceTokenId,
              quoteJurisdiction,
              tokenSymbol,
            ),
            mode: 'cross',
            pairId: market.venueId,
            baseTokenId: market.sourceIsBase ? sourceTokenId : targetTokenId,
            quoteTokenId: market.sourceIsBase ? targetTokenId : sourceTokenId,
            sourceTokenId,
            targetTokenId,
            routeValue: route.value,
            sourceJurisdiction: route.sourceJurisdiction,
            targetJurisdiction: route.targetJurisdiction,
            sourceJurisdictionRef: route.sourceJurisdictionRef,
            targetJurisdictionRef: route.targetJurisdictionRef,
          });
        }
      }
    }
    const seen = new Set<string>();
    return options
      .filter((option) => {
        const key = `${option.label}:${option.pairId}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => compareStableText(a.label, b.label));
  }

  function buildOrderbookPairOptions(): SwapOrderbookPairOption[] {
    const sameOptions = buildSameOrderbookPairOptions(activeOrderAccountId || selectedBookAccountId || createOrderAccountId);
    const crossOptions = buildCrossOrderbookPairOptions();
    return [...sameOptions, ...crossOptions];
  }

  $: pairOptions = buildPairOptions(sourceJurisdictionLabel);
  $: allowedSwapTokenIds = (() => {
    const tokenIds = new Set<number>();
    for (const pair of pairOptions) {
      tokenIds.add(pair.baseTokenId);
      tokenIds.add(pair.quoteTokenId);
    }
    for (const tokenId of tokenIdsForJurisdiction(sourceJurisdictionLabel)) tokenIds.add(tokenId);
    for (const tokenId of tokenIdsForJurisdiction(targetJurisdictionLabel)) tokenIds.add(tokenId);
    return tokenIds;
  })();
  $: sourceSelectableSwapTokenIds = new Set(tokenIdsForJurisdiction(sourceJurisdictionLabel));
  $: targetSelectableSwapTokenIds = new Set(tokenIdsForJurisdiction(targetJurisdictionLabel));
  $: giveTokenOptions = Array.from(sourceSelectableSwapTokenIds)
    .sort((a, b) => compareStableText(tokenSymbol(a), tokenSymbol(b)))
    .map((tokenId) => ({ tokenId, symbol: tokenSymbol(tokenId) }));
  $: wantTokenOptions = Array.from(targetSelectableSwapTokenIds)
    .sort((a, b) => compareStableText(tokenSymbol(a), tokenSymbol(b)))
    .map((tokenId) => ({ tokenId, symbol: tokenSymbol(tokenId) }));
  $: swapTokenOptions = Array.from(new Set([...sourceSelectableSwapTokenIds, ...targetSelectableSwapTokenIds]))
    .sort((a, b) => compareStableText(tokenSymbol(a), tokenSymbol(b)))
    .map((tokenId) => ({ tokenId, symbol: tokenSymbol(tokenId) }));
  $: giveToken = Number.parseInt(giveTokenId, 10);
  $: wantToken = Number.parseInt(wantTokenId, 10);
  $: if (giveTokenOptions.length > 0 && !giveTokenOptions.some((token) => String(token.tokenId) === String(giveTokenId))) {
    giveTokenId = String(giveTokenOptions[0]?.tokenId || '');
    selectedOrderLevel = null;
  }
  $: if (wantTokenOptions.length > 0 && !wantTokenOptions.some((token) => String(token.tokenId) === String(wantTokenId))) {
    const fallbackWant = wantTokenOptions.find((token) => String(token.tokenId) !== String(giveTokenId))
      || wantTokenOptions[0];
    wantTokenId = String(fallbackWant?.tokenId || '');
    selectedOrderLevel = null;
  }
  $: derivedTokenPairValue = (() => {
    if (!Number.isFinite(giveToken) || !Number.isFinite(wantToken) || giveToken <= 0 || wantToken <= 0) return '';
    if (giveToken === wantToken && swapRouteMode === 'same') return '';
    const oriented = resolvePairOrientation(giveToken, wantToken);
    return `${oriented.baseTokenId}/${oriented.quoteTokenId}`;
  })();
  $: selectedPair = derivedTokenPairValue
    ? pairOptions.find((option) => option.value === derivedTokenPairValue) || null
    : null;

  function fallbackCounterToken(tokenIdValue: number): number | null {
    if (!Number.isFinite(tokenIdValue) || tokenIdValue <= 0) return null;
    const pair = selectedPair;
    if (pair) {
      if (tokenIdValue === pair.baseTokenId) return pair.quoteTokenId;
      if (tokenIdValue === pair.quoteTokenId) return pair.baseTokenId;
    }
    const fallback = wantTokenOptions.find((token) => token.tokenId !== tokenIdValue)
      || swapTokenOptions.find((token) => token.tokenId !== tokenIdValue);
    return fallback?.tokenId ?? null;
  }

  function setSwapTokens(nextGiveToken: number, nextWantToken: number, allowSameToken = false): void {
    if (!Number.isFinite(nextGiveToken) || !Number.isFinite(nextWantToken)) return;
    const previousGiveTokenId = String(giveTokenId);
    const previousWantTokenId = String(wantTokenId);
    if (nextGiveToken <= 0 || nextWantToken <= 0) {
      giveTokenId = String(nextGiveToken || '');
      wantTokenId = String(nextWantToken || '');
      selectedOrderLevel = null;
      submitError = '';
      return;
    }
    if (nextGiveToken === nextWantToken && !allowSameToken && liveSelectedRouteValue === 'same') {
      const fallbackWantToken = fallbackCounterToken(nextGiveToken);
      if (!fallbackWantToken || fallbackWantToken === nextGiveToken) {
        submitError = 'Sell token and Buy token must be different.';
        return;
      }
      nextWantToken = fallbackWantToken;
    }
    const oriented = resolvePairOrientation(nextGiveToken, nextWantToken);
    tradeSide = nextGiveToken === oriented.baseTokenId ? 'sell-base' : 'buy-base';
    const nextGiveTokenId = String(nextGiveToken);
    const nextWantTokenId = String(nextWantToken);
    const tokensChanged = previousGiveTokenId !== nextGiveTokenId || previousWantTokenId !== nextWantTokenId;
    giveTokenId = nextGiveTokenId;
    wantTokenId = nextWantTokenId;
    if (tokensChanged) selectedOrderLevel = null;
    submitError = '';
  }

  function buildReverseCrossRouteSelection(): {
    route: SwapRouteOption;
    target: CrossTargetOption;
    sourceEntityId: string;
    sourceHubEntityId: string;
  } | null {
    const route = selectedRouteOption;
    const target = selectedCrossTarget;
    if (swapRouteMode !== 'cross' || !route || route.mode !== 'cross' || !target) return null;
    const sourceEntityId = String(target.targetEntityId || '').trim().toLowerCase();
    const sourceHubEntityId = String(target.targetHubEntityId || '').trim().toLowerCase();
    const targetEntityId = String(route.sourceEntityId || sourceEntityIdValue || '').trim().toLowerCase();
    const targetHubEntityId = String(route.sourceHubEntityId || activeOrderAccountId || '').trim().toLowerCase();
    if (!sourceEntityId || !sourceHubEntityId || !targetEntityId || !targetHubEntityId) {
      submitError = 'Cannot reverse cross route: source or target hub is missing.';
      return null;
    }
    const sourceReplica = findReplicaByEntityId(sourceEntityId);
    const targetReplica = findReplicaByEntityId(targetEntityId);
    if (!sourceReplica || !targetReplica) {
      submitError = 'Cannot reverse cross route: both jurisdiction replicas must be loaded.';
      return null;
    }
    if (!hasReplicaAccount(sourceReplica, sourceHubEntityId)) {
      submitError = `Cannot reverse cross route: open a ${target.targetJurisdiction} hub account first.`;
      return null;
    }
    if (!hubRouteCompatible(sourceHubEntityId, targetHubEntityId)) {
      submitError = 'Cannot reverse cross route: selected hubs are not connected across jurisdictions.';
      return null;
    }
    const sourceJurisdiction = getReplicaJurisdictionName(sourceReplica);
    const targetJurisdiction = getReplicaJurisdictionName(targetReplica);
    const sourceJurisdictionRef = getReplicaJurisdictionRef(sourceReplica);
    const targetJurisdictionRef = getReplicaJurisdictionRef(targetReplica);
    const targetSignerId = String(targetReplica.signerId || '').trim().toLowerCase();
    if (!sourceJurisdiction || !targetJurisdiction || !sourceJurisdictionRef || !targetJurisdictionRef || !targetSignerId) {
      submitError = 'Cannot reverse cross route: jurisdiction metadata is incomplete.';
      return null;
    }
    const hasTargetAccount = hasReplicaAccount(targetReplica, targetHubEntityId);
    const reverseTarget: CrossTargetOption = {
      value: `${targetEntityId}:${targetHubEntityId}`,
      label: `${targetJurisdiction} · ${accountLabel(targetHubEntityId)}${hasTargetAccount ? '' : ' · setup required'}`,
      targetEntityId,
      targetSignerId,
      targetHubEntityId,
      targetJurisdiction,
      targetJurisdictionRef,
      hasTargetAccount,
    };
    return {
      sourceEntityId,
      sourceHubEntityId,
      target: reverseTarget,
      route: {
        value: reverseTarget.value,
        label: formatEntityNetworkLabel(accountLabel(targetEntityId), targetJurisdiction),
        mode: 'cross',
        sourceJurisdiction,
        targetJurisdiction,
        sourceEntityId,
        sourceHubEntityId,
        targetEntityId,
        targetHubEntityId,
        sourceJurisdictionRef,
        targetJurisdictionRef,
        targetLabel: reverseTarget.label,
        disabledReason: '',
      },
    };
  }

  function computeCurrentReceiveAmountForFlip(): bigint {
    const fallbackAmount = canonicalWantAmount > 0n ? canonicalWantAmount : wantAmount;
    if (!parsedOrderbookPair) return fallbackAmount;
    const currentGiveAmount = parseDecimalAmountToBigInt(liveOrderAmountInput, getTokenDecimals(giveToken));
    const explicitPriceTicks = selectedOrderLevel?.inputPriceTicks && selectedOrderLevel.inputPriceTicks > 0n
      ? selectedOrderLevel.inputPriceTicks
      : (selectedOrderLevel?.priceTicks && selectedOrderLevel.priceTicks > 0n ? selectedOrderLevel.priceTicks : limitPriceTicks);
    if (currentGiveAmount <= 0n || !explicitPriceTicks || explicitPriceTicks <= 0n) return fallbackAmount;
    const activeMode = orderMode !== 'none' ? orderMode : tradeSide;
    const currentWantAmount = activeMode === 'sell-base'
      ? quoteFromBase(
          currentGiveAmount,
          explicitPriceTicks,
          getTokenDecimals(parsedOrderbookPair.baseTokenId),
          getTokenDecimals(parsedOrderbookPair.quoteTokenId),
        )
      : baseFromQuote(
          currentGiveAmount,
          explicitPriceTicks,
          getTokenDecimals(parsedOrderbookPair.baseTokenId),
          getTokenDecimals(parsedOrderbookPair.quoteTokenId),
        );
    if (currentWantAmount <= 0n) return fallbackAmount;
    return prepareCanonicalOrder(currentGiveAmount, currentWantAmount)?.effectiveWant ?? currentWantAmount;
  }

  function flipSwapTokens(): void {
    const nextGiveToken = wantToken;
    const nextWantToken = giveToken;
    const nextGiveAmount = computeCurrentReceiveAmountForFlip();
    const nextAmountInput = nextGiveAmount > 0n
      ? formatAmountForInput(nextGiveAmount, nextGiveToken)
      : '';
    const isCrossReverse = swapRouteMode === 'cross';
    const currentPriceTicks = selectedOrderLevel?.inputPriceTicks && selectedOrderLevel.inputPriceTicks > 0n
      ? selectedOrderLevel.inputPriceTicks
      : (selectedOrderLevel?.priceTicks && selectedOrderLevel.priceTicks > 0n ? selectedOrderLevel.priceTicks : limitPriceTicks);
    const nextPriceInput = currentPriceTicks && currentPriceTicks > 0n ? formatPriceTicks(currentPriceTicks) : priceRatioInput;
    if (isCrossReverse) {
      const reverseSelection = buildReverseCrossRouteSelection();
      if (!reverseSelection) return;
      selectedSourceEntityValue = reverseSelection.sourceEntityId;
      selectedBookAccountId = reverseSelection.sourceHubEntityId;
      createOrderAccountId = reverseSelection.sourceHubEntityId;
      commitRouteSelection({ route: reverseSelection.route, target: reverseSelection.target });
      preservePriceOnNextContextChange = false;
      setSwapTokens(nextGiveToken, nextWantToken, true);
      priceRatioInput = '';
      hasUserEditedPriceInput = false;
      hasAutoSuggestedInitialPrice = false;
    } else {
      preservePriceOnNextContextChange = true;
      setSwapTokens(nextGiveToken, nextWantToken);
    }
    if (!isCrossReverse && nextPriceInput) {
      priceRatioInput = nextPriceInput;
      hasUserEditedPriceInput = true;
      hasAutoSuggestedInitialPrice = true;
    }
    setOrderAmountInputValue(nextAmountInput);
  }
  function handleSourceEntityChange(event: Event): void {
    selectSourceEntityOption(String((event.currentTarget as HTMLSelectElement | null)?.value || ''));
  }
  function selectSourceEntityOption(value: string): void {
    const option = sourceEntityOptions.find((candidate) => candidate.value === value);
    if (!option) return;
    selectedSourceEntityValue = option.value;
    selectedRouteValue = 'same';
    committedRouteSelectionValue = 'same';
    selectedRouteOptionOverride = null;
    selectedCrossTargetOverride = null;
    routeSelectionCommitNonce += 1;
    selectedOrderLevel = null;
    submitError = '';
    sourceMenuOpen = false;
    openTokenMenu = '';
    setRouteMenuOpen(false, 'source-change');
    hubMenuOpen = false;
  }
  function handleGiveTokenChange(event: Event): void {
    const nextGive = Number.parseInt(String((event.currentTarget as HTMLSelectElement | null)?.value || ''), 10);
    setSwapTokens(nextGive, wantToken);
  }
  function handleWantTokenChange(event: Event): void {
    const nextWant = Number.parseInt(String((event.currentTarget as HTMLSelectElement | null)?.value || ''), 10);
    setSwapTokens(giveToken, nextWant);
  }
  function setOrderAmountInputValue(value: string): void {
    const next = String(value || '');
    flushSync(() => {
      routedOrderAmountInput.set(next);
      if (!hasLatestOrderAmountDomValue || latestOrderAmountDomValue !== next) {
        latestOrderAmountDomValue = next;
        hasLatestOrderAmountDomValue = true;
        orderAmountDomRevision += 1;
      }
      if (orderAmountInput !== next) {
        orderAmountInput = next;
        orderAmountRevision += 1;
      }
    });
  }
  function handleOrderAmountInput(event: Event): void {
    setOrderAmountInputValue(String((event.currentTarget as HTMLInputElement | null)?.value || ''));
  }
  function handleSwapPanelAmountSync(event: Event): void {
    const input = event.target instanceof HTMLInputElement && event.target.dataset['testid'] === 'swap-order-amount'
      ? event.target
      : null;
    if (!input) return;
    setOrderAmountInputValue(input.value);
  }

  function tokenIconText(symbol: string): string {
    const text = String(symbol || '').trim();
    return text.slice(0, 1).toUpperCase() || '?';
  }
  function tokenClass(symbol: string): string {
    return String(symbol || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'token';
  }

  function toggleTokenMenu(menu: 'give' | 'want'): void {
    sourceMenuOpen = false;
    setRouteMenuOpen(false, 'token-menu');
    hubMenuOpen = false;
    openTokenMenu = openTokenMenu === menu ? '' : menu;
  }

  function toggleSourceMenu(): void {
    openTokenMenu = '';
    setRouteMenuOpen(false, 'source-menu');
    hubMenuOpen = false;
    sourceMenuOpen = !sourceMenuOpen;
  }

  function setRouteMenuOpen(nextOpen: boolean, reason = 'unknown'): void {
    routeMenuSetCount += 1;
    routeMenuLastSetReason = `${reason}:${nextOpen ? 'open' : 'closed'}`;
    routeMenuOpen = nextOpen;
    routeMenuOpenStore.set(nextOpen);
  }

  function toggleRouteMenu(): void {
    sourceMenuOpen = false;
    openTokenMenu = '';
    hubMenuOpen = false;
    routeMenuToggleCount += 1;
    setRouteMenuOpen(!routeMenuOpen, 'toggle');
  }

  function routeMenuButtonAction(node: HTMLButtonElement): { destroy: () => void } {
    const handleClick = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      routeMenuNativeClickCount += 1;
      node.dataset['routeNativeClickCount'] = String(routeMenuNativeClickCount);
      const nextOpen = node.dataset['routeMenuOpen'] !== 'true';
      routeMenuToggleCount += 1;
      node.dataset['routeMenuToggleCount'] = String(routeMenuToggleCount);
      node.dataset['routeNextOpen'] = String(nextOpen);
      ignoreOutsideMenuClickUntil = Date.now() + 1500;
      ignoreNextWindowMenuClick = true;
      ignoreWindowMenuClickCount = 4;
      if (typeof window !== 'undefined') {
        (window as Window & { __xlnRouteMenuSuppressWindowClickUntil?: number }).__xlnRouteMenuSuppressWindowClickUntil = Date.now() + 3000;
      }
      setRouteMenuOpen(nextOpen, 'route-button');
    };
    node.addEventListener('click', handleClick);
    return {
      destroy() {
        node.removeEventListener('click', handleClick);
      },
    };
  }

  function toggleHubMenu(): void {
    sourceMenuOpen = false;
    openTokenMenu = '';
    setRouteMenuOpen(false, 'hub-menu');
    hubMenuOpen = !hubMenuOpen;
  }

  function selectGiveTokenOption(tokenIdValue: number): void {
    setSwapTokens(tokenIdValue, wantToken);
    sourceMenuOpen = false;
    openTokenMenu = '';
    setRouteMenuOpen(false, 'give-token');
    hubMenuOpen = false;
  }

  function selectWantTokenOption(tokenIdValue: number): void {
    setSwapTokens(giveToken, tokenIdValue);
    sourceMenuOpen = false;
    openTokenMenu = '';
    setRouteMenuOpen(false, 'want-token');
    hubMenuOpen = false;
  }

  function handleRouteSelectChange(event: Event): void {
    const nextValue = String((event.currentTarget as HTMLSelectElement | null)?.value || '');
    selectRouteOption(nextValue);
  }

  function handleRouteCommitEvent(event: CustomEvent<{ value?: string }>): void {
    const nextValue = String(event.detail?.value || '');
    if (!nextValue) return;
    selectRouteOption(nextValue);
  }

  function commitRouteSelection(selection: { route: SwapRouteOption; target: CrossTargetOption | null }): void {
    selectedRouteOptionOverride = selection.route.mode === 'cross' ? selection.route : null;
    selectedCrossTargetOverride = selection.target;
    selectedRouteValue = selection.route.value;
    committedRouteSelectionValue = selection.route.value;
    routeSelectionCommitNonce += 1;
  }

  function selectRouteOption(value: string): void {
    const selection = buildCommittedRouteSelectionFromDom(routeSelectElement, value);
    if (!selection || selection.route.disabled) return;
    commitRouteSelection(selection);
    sourceMenuOpen = false;
    openTokenMenu = '';
    setRouteMenuOpen(false, 'route-select');
    hubMenuOpen = false;
    submitError = '';
  }

  function dispatchRouteCommit(node: HTMLSelectElement, value: string): void {
    const nextValue = String(value || '').trim();
    if (!nextValue) return;
    node.dataset['routeCommittedValue'] = nextValue;
    node.dispatchEvent(new CustomEvent('xlnroutecommit', {
      bubbles: true,
      detail: { value: nextValue },
    }));
  }

  function closeSwapMenus(reason = 'window-close'): void {
    sourceMenuOpen = false;
    openTokenMenu = '';
    if (reason === 'escape') {
      setRouteMenuOpen(false, reason);
    }
    hubMenuOpen = false;
  }

  function handleSwapWindowClick(event: MouseEvent): void {
    const globalSuppressUntil = typeof window !== 'undefined'
      ? (window as Window & { __xlnRouteMenuSuppressWindowClickUntil?: number }).__xlnRouteMenuSuppressWindowClickUntil || 0
      : 0;
    if (Date.now() < globalSuppressUntil) return;
    if (routeMenuLastSetReason === 'route-button:open') return;
    if (routeMenuOpen) return;
    if (ignoreWindowMenuClickCount > 0) {
      ignoreWindowMenuClickCount -= 1;
      return;
    }
    if (ignoreNextWindowMenuClick) {
      ignoreNextWindowMenuClick = false;
      return;
    }
    if (Date.now() < ignoreOutsideMenuClickUntil) return;
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    const clickedInsideMenuRoot = path.some((entry) =>
      entry instanceof HTMLElement && Boolean(entry.closest('[data-swap-menu-root]')),
    );
    if (clickedInsideMenuRoot) return;
    closeSwapMenus('window-click');
  }

  function handleSwapWindowKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') closeSwapMenus('escape');
  }

  function formatPriceTicks(ticks: bigint): string {
    const whole = ticks / ORDERBOOK_PRICE_SCALE;
    if (ORDERBOOK_PRICE_DECIMALS <= 0) return whole.toString();
    const frac = (ticks % ORDERBOOK_PRICE_SCALE)
      .toString()
      .padStart(ORDERBOOK_PRICE_DECIMALS, '0');
    return `${whole.toString()}.${frac}`;
  }

  function lotsToBaseWei(sizeLots: bigint, baseTokenId: number): bigint {
    if (sizeLots <= 0n) return 0n;
    if (!activeXlnFunctions?.isReady) return 0n;
    return sizeLots * activeXlnFunctions.getSwapLotScale(baseTokenId);
  }

  function tokenSymbol(tokenIdValue: number): string {
    if (!Number.isFinite(tokenIdValue) || tokenIdValue <= 0) return 'Token';
    const info = activeXlnFunctions?.getTokenInfo?.(tokenIdValue);
    const symbol = String(info?.symbol || '').trim();
    return symbol || `Token #${tokenIdValue}`;
  }

  function selectedTokenSymbol(
    tokenIdValue: number,
    tokenIdRaw: string,
    options: Array<{ tokenId: number; symbol: string }>,
  ): string {
    const raw = String(tokenIdRaw || '').trim();
    const rawTokenId = Number.parseInt(raw, 10);
    const selectedOption = options.find((token) => String(token.tokenId) === raw)
      || (Number.isFinite(tokenIdValue) ? options.find((token) => token.tokenId === tokenIdValue) : null)
      || (Number.isFinite(rawTokenId) ? options.find((token) => token.tokenId === rawTokenId) : null)
      || options[0]
      || null;
    const optionSymbol = String(selectedOption?.symbol || '').trim();
    if (optionSymbol) return optionSymbol;
    if (Number.isFinite(tokenIdValue) && tokenIdValue > 0) return tokenSymbol(tokenIdValue);
    if (Number.isFinite(rawTokenId) && rawTokenId > 0) return tokenSymbol(rawTokenId);
    return '';
  }

  function handlePriceRatioInput(event: Event): void {
    const target = event.currentTarget as HTMLInputElement | null;
    hasUserEditedPriceInput = true;
    const normalized = normalizeDecimalInput(target?.value || '', ORDERBOOK_PRICE_DECIMALS);
    if (selectedOrderLevel) {
      const pinnedPrice = selectedOrderLevel.displayPrice
        ? normalizeDisplayPriceForInput(selectedOrderLevel.displayPrice)
        : formatPriceTicks(selectedOrderLevel.inputPriceTicks > 0n ? selectedOrderLevel.inputPriceTicks : selectedOrderLevel.priceTicks);
      if (normalizeDisplayPriceForInput(normalized) !== pinnedPrice) {
        selectedOrderLevel = null;
      }
    }
    priceRatioInput = normalized;
  }

  $: {
    try {
      const nextOffers = currentReplica && activeXlnFunctions?.listOpenSwapOffers
        ? activeXlnFunctions.listOpenSwapOffers(currentReplica.state)
        : [];
      activeOffers = Array.isArray(nextOffers) ? nextOffers : [];
    } catch {
      activeOffers = [];
    }
  }

  function readOutCapacity(counterpartyEntityId: string, tokenIdValue: number): bigint {
    const accountDelta = getAccountDelta(counterpartyEntityId, tokenIdValue);
    if (!accountDelta || !activeXlnFunctions?.deriveDelta) return 0n;
    try {
      const derived = activeXlnFunctions.deriveDelta(accountDelta.delta, accountDelta.isLeft);
      const outCapacityRaw = (derived as { outCapacity?: unknown })?.outCapacity;
      if (typeof outCapacityRaw === 'bigint') return outCapacityRaw;
      return toBigIntSafe(outCapacityRaw) ?? 0n;
    } catch {
      return 0n;
    }
  }

  function hasTokenInAccount(counterpartyEntityId: string, tokenIdValue: number): boolean {
    if (!counterpartyEntityId || !Number.isFinite(tokenIdValue) || tokenIdValue <= 0) return false;
    const resolvedCounterparty = resolveCounterpartyId(counterpartyEntityId);
    const account = currentReplica?.state?.accounts?.get?.(resolvedCounterparty);
    const deltas = account?.deltas as TokenKeyedMap<Delta> | undefined;
    if (!(deltas instanceof Map)) return false;
    return getTokenMapValue(deltas, tokenIdValue) !== undefined;
  }

  function readInCapacity(counterpartyEntityId: string, tokenIdValue: number): bigint {
    const accountDelta = getAccountDelta(counterpartyEntityId, tokenIdValue);
    if (!accountDelta || !activeXlnFunctions?.deriveDelta) return 0n;
    try {
      const derived = activeXlnFunctions.deriveDelta(accountDelta.delta, accountDelta.isLeft);
      const inCapacityRaw = (derived as { inCapacity?: unknown })?.inCapacity;
      if (typeof inCapacityRaw === 'bigint') return inCapacityRaw;
      return toBigIntSafe(inCapacityRaw) ?? 0n;
    } catch {
      return 0n;
    }
  }

  function readAccountDelta(counterpartyEntityId: string, tokenIdValue: number): Delta | null {
    return getAccountDelta(counterpartyEntityId, tokenIdValue)?.delta ?? null;
  }

  function readPeerCreditLimit(counterpartyEntityId: string, tokenIdValue: number): bigint {
    const delta = readAccountDelta(counterpartyEntityId, tokenIdValue);
    if (!delta || !sourceEntityIdValue) return 0n;
    const isLeft = sourceEntityIdValue < String(resolveCounterpartyId(counterpartyEntityId)).toLowerCase();
    const raw = isLeft ? delta.rightCreditLimit : delta.leftCreditLimit;
    return nonNegative(toBigIntSafe(raw) ?? 0n);
  }

  function findReplicaByEntityId(entityId: string, view: SwapPanelRuntimeView = swapRuntimeView): EntityReplica | null {
    const normalized = String(entityId || '').trim().toLowerCase();
    if (!normalized) return null;
    return view.localReplicas.find((candidate) =>
      String(candidate.entityId || candidate.state?.entityId || '').trim().toLowerCase() === normalized,
    ) || null;
  }

  function hasReplicaAccount(candidate: EntityReplica | null | undefined, counterpartyEntityId: string): boolean {
    const counterparty = String(counterpartyEntityId || '').trim();
    if (!candidate || !counterparty) return false;
    return candidate.state?.accounts instanceof Map && candidate.state.accounts.has(counterparty);
  }

  function readPeerCreditLimitForReplica(
    candidate: EntityReplica | null | undefined,
    ownerEntityId: string,
    counterpartyEntityId: string,
    tokenIdValue: number,
  ): bigint {
    const accountDelta = getAccountDeltaForReplica(candidate, ownerEntityId, counterpartyEntityId, tokenIdValue);
    if (!accountDelta) return 0n;
    const raw = accountDelta.isLeft ? accountDelta.delta.rightCreditLimit : accountDelta.delta.leftCreditLimit;
    return nonNegative(toBigIntSafe(raw) ?? 0n);
  }

  function computeAutoInboundCreditTarget(
    counterpartyEntityId: string,
    tokenIdValue: number,
    desiredInboundAmount: bigint,
  ): bigint | null {
    if (!counterpartyEntityId || !Number.isFinite(tokenIdValue) || tokenIdValue <= 0 || desiredInboundAmount <= 0n) return null;
    if (!activeXlnFunctions?.deriveDelta || !sourceEntityIdValue) return desiredInboundAmount;
    const accountDelta = getAccountDelta(counterpartyEntityId, tokenIdValue);
    if (!accountDelta) return desiredInboundAmount;
    const resolvedCounterparty = resolveCounterpartyId(counterpartyEntityId);
    try {
      const derived = activeXlnFunctions.deriveDelta(accountDelta.delta, accountDelta.isLeft) as {
        inCapacity?: unknown;
        inPeerCredit?: unknown;
        outPeerCredit?: unknown;
      };
      const inCapacity = nonNegative(toBigIntSafe(derived.inCapacity) ?? 0n);
      if (inCapacity >= desiredInboundAmount) return null;

      const inPeerCredit = nonNegative(toBigIntSafe(derived.inPeerCredit) ?? 0n);
      const inWithoutPeerCredit = inCapacity > inPeerCredit ? inCapacity - inPeerCredit : 0n;
      const neededPeerCredit = desiredInboundAmount > inWithoutPeerCredit ? desiredInboundAmount - inWithoutPeerCredit : 0n;

      const currentPeerLimit = readPeerCreditLimit(resolvedCounterparty, tokenIdValue);
      const outPeerDebt = nonNegative(toBigIntSafe(derived.outPeerCredit) ?? 0n);
      const targetPeerLimit = outPeerDebt + neededPeerCredit;
      if (targetPeerLimit > currentPeerLimit) return targetPeerLimit;
      return null;
    } catch {
      return desiredInboundAmount;
    }
  }

  function computeAutoInboundCreditTargetForReplica(
    candidate: EntityReplica | null | undefined,
    ownerEntityId: string,
    counterpartyEntityId: string,
    tokenIdValue: number,
    desiredInboundAmount: bigint,
  ): bigint | null {
    if (!hasReplicaAccount(candidate, counterpartyEntityId)) return null;
    if (!Number.isFinite(tokenIdValue) || tokenIdValue <= 0 || desiredInboundAmount <= 0n) return null;
    const accountDelta = getAccountDeltaForReplica(candidate, ownerEntityId, counterpartyEntityId, tokenIdValue);
    if (!accountDelta || !activeXlnFunctions?.deriveDelta) return desiredInboundAmount;
    try {
      const derived = activeXlnFunctions.deriveDelta(accountDelta.delta, accountDelta.isLeft) as {
        inCapacity?: unknown;
        inPeerCredit?: unknown;
        outPeerCredit?: unknown;
      };
      const inCapacity = nonNegative(toBigIntSafe(derived.inCapacity) ?? 0n);
      if (inCapacity >= desiredInboundAmount) return null;

      const inPeerCredit = nonNegative(toBigIntSafe(derived.inPeerCredit) ?? 0n);
      const inWithoutPeerCredit = inCapacity > inPeerCredit ? inCapacity - inPeerCredit : 0n;
      const neededPeerCredit = desiredInboundAmount > inWithoutPeerCredit ? desiredInboundAmount - inWithoutPeerCredit : 0n;
      const currentPeerLimit = readPeerCreditLimitForReplica(candidate, ownerEntityId, counterpartyEntityId, tokenIdValue);
      const outPeerDebt = nonNegative(toBigIntSafe(derived.outPeerCredit) ?? 0n);
      const targetPeerLimit = outPeerDebt + neededPeerCredit;
      if (targetPeerLimit > currentPeerLimit) return targetPeerLimit;
      return null;
    } catch {
      return desiredInboundAmount;
    }
  }

  function isInboundCapacityValidationError(reason: string): boolean {
    if (!reason) return false;
    return reason.startsWith('Inbound token is not active in this account.')
      || reason.startsWith('Insufficient inbound capacity');
  }

  $: giveTokenSymbol = selectedTokenSymbol(giveToken, giveTokenId, giveTokenOptions);
  $: wantTokenSymbol = selectedTokenSymbol(wantToken, wantTokenId, wantTokenOptions);
  $: {
    currentReplica;
    wantTokenPresentInAccount = hasTokenInAccount(activeOrderAccountId, wantToken);
    availableGiveCapacity = readOutCapacity(activeOrderAccountId, giveToken);
    availableWantInCapacity = readInCapacity(activeOrderAccountId, wantToken);
    autoInboundCreditTarget = computeAutoInboundCreditTarget(activeOrderAccountId, wantToken, canonicalWantAmount);
    currentPeerCreditLimit = readPeerCreditLimit(activeOrderAccountId, wantToken);
  }
  $: {
    crossTargetInCapacity = selectedCrossTarget
      ? readInCapacityForReplica(selectedCrossTargetReplica, selectedCrossTarget.targetEntityId, selectedCrossTarget.targetHubEntityId, wantToken)
      : 0n;
    crossDesiredInboundAmount = canonicalWantAmount;
    crossAutoInboundCreditTarget = selectedCrossTarget && crossTargetHasAccount
      ? computeAutoInboundCreditTargetForReplica(
          selectedCrossTargetReplica,
          selectedCrossTarget.targetEntityId,
          selectedCrossTarget.targetHubEntityId,
          wantToken,
          crossDesiredInboundAmount,
        )
      : selectedCrossTarget && needsCrossTargetAccountSetup && crossDesiredInboundAmount > 0n
        ? maxBigInt(defaultCreditLimitForToken(wantToken), crossDesiredInboundAmount)
        : null;
    const currentPeerCreditLimit = selectedCrossTarget && crossTargetHasAccount
      ? readPeerCreditLimitForReplica(selectedCrossTargetReplica, selectedCrossTarget.targetEntityId, selectedCrossTarget.targetHubEntityId, wantToken)
      : 0n;
    crossCurrentPeerCreditLimit = currentPeerCreditLimit;
    needsCrossTargetCreditSetup = Boolean(
      swapRouteMode === 'cross'
      && selectedCrossTarget
      && (crossTargetHasAccount || canAutoOpenCrossTargetAccount)
      && crossAutoInboundCreditTarget !== null
      && crossAutoInboundCreditTarget > crossCurrentPeerCreditLimit,
    );
    canAutoPrepareCrossInboundCapacity = Boolean(
      swapRouteMode === 'cross'
      && selectedCrossTarget
      && needsCrossTargetCreditSetup,
    );
  }
  $: formattedAvailableGiveAmount = Number.isFinite(giveToken) && giveToken > 0
    ? formatAmount(availableGiveCapacity, giveToken)
    : availableGiveCapacity.toString();
  $: formattedAvailableGive = Number.isFinite(giveToken) && giveToken > 0
    ? `${formattedAvailableGiveAmount} ${giveTokenSymbol}`
    : formattedAvailableGiveAmount;
  $: formattedAvailableWantInAmount = Number.isFinite(wantToken) && wantToken > 0
    ? formatAmount(availableWantInCapacity, wantToken)
    : availableWantInCapacity.toString();
  $: formattedAvailableWantIn = Number.isFinite(wantToken) && wantToken > 0
    ? `${formattedAvailableWantInAmount} ${wantTokenSymbol}`
    : formattedAvailableWantInAmount;
  $: targetCapacityAmount = swapRouteMode === 'cross' ? crossTargetInCapacity : availableWantInCapacity;
  $: formattedTargetCapacityAmount = Number.isFinite(wantToken) && wantToken > 0
    ? formatAmount(targetCapacityAmount, wantToken)
    : targetCapacityAmount.toString();
  $: targetCapacityLabel = targetAccountReady ? formattedTargetCapacityAmount : 'Account setup required';
  $: crossSetupCreditLimitLabel = crossAutoInboundCreditTarget !== null && Number.isFinite(wantToken) && wantToken > 0
    ? `${formatAmount(crossAutoInboundCreditTarget, wantToken)} ${wantTokenSymbol}`
    : '';
  $: crossSetupCreditIncreaseLabel = crossAutoInboundCreditTarget !== null && crossAutoInboundCreditTarget > crossCurrentPeerCreditLimit
    ? `+${formatAmount(crossAutoInboundCreditTarget - crossCurrentPeerCreditLimit, wantToken)} ${wantTokenSymbol}`
    : '';
  $: crossSwapSetupSteps = buildCrossSwapSetupSteps({
    routeMode: swapRouteMode,
    targetAccountReady,
    canOpenTargetAccount: canAutoOpenCrossTargetAccount,
    needsCreditLimit: needsCrossTargetCreditSetup,
    targetHubLabel: selectedCrossTarget ? accountLabel(selectedCrossTarget.targetHubEntityId) : '',
    targetJurisdictionLabel,
    creditLimitLabel: crossSetupCreditLimitLabel,
    creditIncreaseLabel: crossSetupCreditIncreaseLabel,
    tokenSymbol: wantTokenSymbol,
  });
  $: estimatedPrice = limitPriceTicks && limitPriceTicks > 0n ? formatPriceTicks(limitPriceTicks) : 'n/a';
  $: estimatedReceiveLabel = Number.isFinite(wantToken) && wantToken > 0
    ? `${formatAmount(canonicalWantAmount, wantToken)} ${wantTokenSymbol}`
    : canonicalWantAmount.toString();
  $: estimatedSpendLabel = Number.isFinite(giveToken) && giveToken > 0
    ? `${formatAmount(canonicalGiveAmount, giveToken)} ${giveTokenSymbol}`
    : canonicalGiveAmount.toString();
  $: sourceAssetLabel = `${giveTokenSymbol} · ${sourceJurisdictionLabel}`;
  $: targetAssetLabel = `${wantTokenSymbol} · ${targetJurisdictionLabel}`;
  $: swapRouteTitle = swapRouteMode === 'cross'
    ? `${sourceJurisdictionLabel} -> ${targetJurisdictionLabel}`
    : sourceJurisdictionLabel;
  $: marketPriceTicks = resolveReferencePriceTicks();
  $: marketPriceLabel = marketPriceTicks && marketPriceTicks > 0n
    ? `${formatPriceTicks(marketPriceTicks)} ${quoteTokenSymbol}`
    : 'No market';
  $: marketPriceSideLabel = orderMode === 'sell-base' ? 'Best bid' : 'Best ask';
  $: leftoverGiveLabel = Number.isFinite(giveToken) && giveToken > 0
    ? `${formatAmount(giveAmountLeftover, giveToken)} ${giveTokenSymbol}`
    : giveAmountLeftover.toString();
  $: autoInboundCreditIncrease = autoInboundCreditTarget && autoInboundCreditTarget > currentPeerCreditLimit
    ? autoInboundCreditTarget - currentPeerCreditLimit
    : 0n;
  $: canAutoPrepareInboundCapacity = autoInboundCreditTarget !== null && autoInboundCreditIncrease > 0n;

  function formatPriceImprovement(amount: bigint, tokenIdValue: number | null): string {
    if (!tokenIdValue || amount <= 0n) return '—';
    return `${formatAmount(amount, tokenIdValue)} ${tokenSymbol(tokenIdValue)}`;
  }

  function formatSwapFee(amount: bigint, tokenIdValue: number | null): string {
    if (!tokenIdValue || amount <= 0n) return '—';
    return `${formatAmount(amount, tokenIdValue)} ${tokenSymbol(tokenIdValue)}`;
  }

  function resolveReferencePriceTicks(): bigint | null {
    const activeMode = orderMode !== 'none' ? orderMode : tradeSide;
    if (String(orderbookSnapshot?.pairId || '').trim() === String(orderbookPairId || '').trim()) {
      const level = activeMode === 'buy-base' ? orderbookSnapshot.asks?.[0] : orderbookSnapshot.bids?.[0];
      const price = level?.price ?? 0n;
      if (price > 0n) return price;
    }
    const bookSide: BookSide = activeMode === 'buy-base' ? 'ask' : 'bid';
    return readCurrentHubBestPriceTicks(bookSide, activeBookHubId || activeOrderAccountId);
  }

  function readCurrentHubPairBook(hubEntityId: string): BookState | null {
    return readPairBook(hubEntityId, orderbookPairId);
  }

  function readPairBook(hubEntityId: string, pairIdValue: string): BookState | null {
    return swapRuntimeView.getPairBook(hubEntityId, pairIdValue);
  }

  function validateCrossSwapForm(
    input: SwapFormValidationInput,
    target: CrossTargetOption | null,
    allowAutoPrepareTargetInbound: boolean,
    allowAutoOpenTargetAccount: boolean,
    unavailableReason = selectedRouteUnavailableReason,
  ): string {
    if (!target) return 'Select target jurisdiction account.';
    if (unavailableReason) return unavailableReason;
    if (!input.isLive) return 'Switch to LIVE mode to place swap orders.';
    if (!input.entityId) return 'Entity is not selected.';
    if (!input.counterpartyId) return 'Select source account (hub) first.';
    const hasSourceAccount = input.accountIds.some(
      (id) => String(id || '').toLowerCase() === String(input.counterpartyId || '').toLowerCase(),
    );
    if (!hasSourceAccount) return 'Selected source account is not active.';
    if (!Number.isFinite(input.giveToken) || !Number.isFinite(input.wantToken) || input.giveToken <= 0 || input.wantToken <= 0) {
      return 'Select valid Sell and Buy tokens.';
    }
    if (input.giveAmount <= 0n) return 'Enter amount to sell.';
    if (!input.limitPriceTicks || input.limitPriceTicks <= 0n) return 'Price is too small.';
    if (input.referencePriceTicks && input.referencePriceTicks > 0n) {
      const deviationBps = computePriceDeviationBps(input.limitPriceTicks, input.referencePriceTicks);
      if (deviationBps > MAX_PRICE_DEVIATION_BPS) {
        return 'Price must stay within 30% of the current orderbook.';
      }
    }
    if (input.wantAmount <= 0n) return 'Amount to receive is too small for selected price.';
    if (input.notionalUsd < MIN_ORDER_NOTIONAL_USD) {
      return `Minimum order size is ~$${MIN_ORDER_NOTIONAL_USD}.`;
    }
    if (input.giveAmount > input.availableGiveCapacity) {
      return `Insufficient source capacity: ${input.formattedAvailableGive} available.`;
    }

    const targetReplica = findReplicaByEntityId(target.targetEntityId);
    if (!hasReplicaAccount(targetReplica, target.targetHubEntityId)) {
      return allowAutoOpenTargetAccount ? '' : 'Target account setup is required.';
    }
    const targetHasToken = hasTokenInReplicaAccount(
      targetReplica,
      target.targetEntityId,
      target.targetHubEntityId,
      input.wantToken,
    );
    if (!targetHasToken && !allowAutoPrepareTargetInbound) return 'Target inbound token is not active. Enable auto-extend.';
    const targetInCapacity = readInCapacityForReplica(
      targetReplica,
      target.targetEntityId,
      target.targetHubEntityId,
      input.wantToken,
    );
    if (input.wantAmount > targetInCapacity) {
      if (allowAutoPrepareTargetInbound) return '';
      const formattedTargetIn = Number.isFinite(input.wantToken) && input.wantToken > 0
        ? `${formatAmount(targetInCapacity, input.wantToken)} ${tokenSymbol(input.wantToken)}`
        : targetInCapacity.toString();
      return `Insufficient target inbound capacity (${formattedTargetIn}).`;
    }
    return '';
  }

  function computeOrderNotionalUsd(
    mode: 'buy-base' | 'sell-base' | 'none',
    giveTokenValue: number,
    wantTokenValue: number,
    effectiveGiveAmount: bigint,
    effectiveWantAmount: bigint,
  ): number {
    if (mode === 'sell-base') {
      return amountToUsd(effectiveWantAmount, getTokenDecimals(wantTokenValue), tokenSymbol(wantTokenValue));
    }
    if (mode === 'buy-base') {
      return amountToUsd(effectiveGiveAmount, getTokenDecimals(giveTokenValue), tokenSymbol(giveTokenValue));
    }
    return 0;
  }

  function buildSwapValidationInput(
    candidateCounterpartyId: string,
    candidateGiveToken: number,
    candidateWantToken: number,
    candidateGiveAmount: bigint,
    candidateWantAmount: bigint,
    candidateLimitPriceTicks: bigint | null,
  ): SwapFormValidationInput {
    const liveWantTokenPresentInAccount = hasTokenInAccount(candidateCounterpartyId, candidateWantToken);
    const liveAvailableGiveCapacity = readOutCapacity(candidateCounterpartyId, candidateGiveToken);
    const liveAvailableWantInCapacity = readInCapacity(candidateCounterpartyId, candidateWantToken);
    const liveFormattedAvailableGive = Number.isFinite(candidateGiveToken) && candidateGiveToken > 0
      ? `${formatAmount(liveAvailableGiveCapacity, candidateGiveToken)} ${tokenSymbol(candidateGiveToken)}`
      : liveAvailableGiveCapacity.toString();
    const liveFormattedAvailableWantIn = Number.isFinite(candidateWantToken) && candidateWantToken > 0
      ? `${formatAmount(liveAvailableWantInCapacity, candidateWantToken)} ${tokenSymbol(candidateWantToken)}`
      : liveAvailableWantInCapacity.toString();
    return {
      isLive: activeIsLive,
      entityId: sourceEntityIdValue,
      counterpartyId: String(candidateCounterpartyId || ''),
      accountIds,
      giveToken: candidateGiveToken,
      wantToken: candidateWantToken,
      giveAmount: candidateGiveAmount,
      limitPriceTicks: candidateLimitPriceTicks,
      wantAmount: candidateWantAmount,
      wantTokenPresentInAccount: liveWantTokenPresentInAccount,
      availableGiveCapacity: liveAvailableGiveCapacity,
      availableWantInCapacity: liveAvailableWantInCapacity,
      formattedAvailableGive: liveFormattedAvailableGive,
      formattedAvailableWantIn: liveFormattedAvailableWantIn,
      notionalUsd: computeOrderNotionalUsd(orderMode, candidateGiveToken, candidateWantToken, candidateGiveAmount, candidateWantAmount),
      referencePriceTicks: resolveReferencePriceTicks(),
    };
  }

  $: swapPreparationError = (
    giveAmount > 0n
    && limitPriceTicks !== null
    && limitPriceTicks > 0n
    && parsedOrderbookPair
    && !preparedOrder
  ) ? 'Order does not fit canonical lot/tick constraints.' : '';
  $: swapDisabledReason = swapPreparationError || (
    swapRouteMode === 'cross'
      ? validateCrossSwapForm(
          buildSwapValidationInput(
            String(activeOrderAccountId || ''),
            giveToken,
            wantToken,
            canonicalGiveAmount,
            canonicalWantAmount,
            canonicalPriceTicks,
          ),
          selectedCrossTarget,
          canAutoPrepareCrossInboundCapacity,
          canAutoOpenCrossTargetAccount,
        )
      : validateSwapForm(
          buildSwapValidationInput(
            String(activeOrderAccountId || ''),
            giveToken,
            wantToken,
            canonicalGiveAmount,
            canonicalWantAmount,
            canonicalPriceTicks,
          ),
        )
  );
  $: swapActionDisabledReason = (
    swapRouteMode === 'same' && isInboundCapacityValidationError(swapDisabledReason) && canAutoPrepareInboundCapacity
      ? ''
      : swapDisabledReason
  );
  $: autoCapacityNote = (() => {
    if (swapRouteMode !== 'same') return '';
    if (!canAutoPrepareInboundCapacity) return '';
    const targetLabel = formatAmount(autoInboundCreditTarget ?? 0n, wantToken);
    const increaseLabel = formatAmount(autoInboundCreditIncrease, wantToken);
    return `Placing this swap will auto-activate ${wantTokenSymbol} and set inbound capacity to ${targetLabel} ${wantTokenSymbol} (+${increaseLabel}).`;
  })();
  $: sourceCapacityShortfall = canonicalGiveAmount > availableGiveCapacity ? canonicalGiveAmount - availableGiveCapacity : 0n;
  $: hasSourceCapacityShortfall = canonicalGiveAmount > 0n && sourceCapacityShortfall > 0n;
  $: leftoverGiveNote = giveAmountLeftover > 0n
    ? `Canonical order leaves ${leftoverGiveLabel} unspent after lot quantization.`
    : '';
  $: capacityWarning = (() => {
    if (!activeOrderAccountId || !Number.isFinite(giveToken) || giveToken <= 0) return '';
    if (availableGiveCapacity <= 0n) return `No ${giveTokenSymbol} outbound capacity on ${sourceRouteEntityLabel}.`;
    if (giveAmount > 0n && giveAmount > availableGiveCapacity) {
      return `Only ${formattedAvailableGive} available on ${sourceRouteEntityLabel}.`;
    }
    return '';
  })();
  $: swapSubmitLabel = placingSwapOffer
    ? 'Submitting swap...'
    : `Swap ${giveTokenSymbol} to ${wantTokenSymbol}`;
  $: if (
    swapRouteMode !== 'cross'
    && selectedOrderLevel
    && orderbookScopeMode !== 'aggregated'
    && selectedOrderLevel.accountId !== selectedBookAccountId
  ) {
    selectedOrderLevel = null;
  }

  function applyOrderPercent(percent: number) {
    const clamped = Math.max(0, Math.min(100, Math.round(percent)));
    orderPercent = clamped;
    const currentGiveCapacity = readOutCapacity(activeOrderAccountId, giveToken);
    if (!selectedOrderLevel) {
      const rawGive = (currentGiveCapacity * BigInt(clamped)) / 100n;
      const rawWant = orderMode === 'sell-base'
        ? quoteFromBase(rawGive, limitPriceTicks ?? 0n, baseTokenDecimals, quoteTokenDecimals)
        : baseFromQuote(rawGive, limitPriceTicks ?? 0n, baseTokenDecimals, quoteTokenDecimals);
      const fillGive = prepareCanonicalOrder(rawGive, rawWant)?.effectiveGive ?? 0n;
      setOrderAmountInputValue(formatAmountForInput(fillGive, giveToken));
      return;
    }

    const levelGiveTokenId = selectedOrderLevel.side === 'ask'
      ? selectedOrderLevel.quoteTokenId
      : selectedOrderLevel.baseTokenId;
    const selectedLevelAccountId = swapRouteMode === 'cross'
      ? activeOrderAccountId
      : (
          createOrderAccountId
          || selectedBookAccountId
          || selectedOrderLevel.accountIds[0]
          || ''
        );
    const levelBaseDecimals = getTokenDecimals(selectedOrderLevel.baseTokenId);
    const levelQuoteDecimals = getTokenDecimals(selectedOrderLevel.quoteTokenId);
    const levelGiveCapacity = readOutCapacity(selectedLevelAccountId, levelGiveTokenId);
    const maxFillGiveByBook = selectedOrderLevel.side === 'ask'
      ? quoteFromBase(selectedOrderLevel.sizeBaseWei, selectedOrderLevel.priceTicks, levelBaseDecimals, levelQuoteDecimals)
      : selectedOrderLevel.sizeBaseWei;
    const maxFillGive = levelGiveCapacity < maxFillGiveByBook ? levelGiveCapacity : maxFillGiveByBook;
    const rawGive = (maxFillGive * BigInt(clamped)) / 100n;
    const explicitPriceTicks = selectedOrderLevel.inputPriceTicks > 0n
      ? selectedOrderLevel.inputPriceTicks
      : selectedOrderLevel.priceTicks;
    const levelWantTokenId = selectedOrderLevel.side === 'ask'
      ? selectedOrderLevel.baseTokenId
      : selectedOrderLevel.quoteTokenId;
    const requantized = requantizeAtLimitPrice(
      levelGiveTokenId,
      levelWantTokenId,
      rawGive,
      explicitPriceTicks,
    );
    const fillGive = requantized?.effectiveGive ?? 0n;

    setOrderAmountInputValue(formatAmountForInput(fillGive, levelGiveTokenId));
    priceRatioInput = selectedOrderLevel.displayPrice
      ? normalizeDisplayPriceForInput(selectedOrderLevel.displayPrice)
      : formatPriceTicks(selectedOrderLevel.priceTicks);
  }

  function readLogicalNumber(value: unknown): number {
    const numeric = Number(value ?? 0);
    return Number.isFinite(numeric) ? Math.max(0, Math.floor(numeric)) : 0;
  }

  function resolveProjectedSignerId(entityId: string): string {
    const normalized = String(entityId || '').trim().toLowerCase();
    if (!normalized) return '';
    if (normalized === sourceEntityIdValue && sourceSignerIdValue) return sourceSignerIdValue;
    for (const entry of swapRuntimeView.localReplicaEntries) {
      if (entry.entityId === normalized && entry.signerId) return entry.signerId;
    }
    return '';
  }

  function resolveSwapLogicalClock(sourceReplica: EntityReplica | null | undefined = currentReplica): {
    logicalTimestamp: number;
    logicalHeight: number;
  } {
    const logicalTimestamp = readLogicalNumber(sourceReplica?.state?.timestamp ?? runtimeEnv?.timestamp);
    const logicalHeight = readLogicalNumber(sourceReplica?.state?.height ?? runtimeEnv?.height);
    if (logicalTimestamp <= 0 || logicalHeight <= 0) {
      throw new Error('Swap runtime clock is unavailable');
    }
    return { logicalTimestamp, logicalHeight };
  }

  function handleOrderbookSnapshot(event: CustomEvent<OrderbookSnapshot>) {
    orderbookSnapshot = event.detail;
    cacheOrderbookSnapshot(event.detail);
  }

  function readCurrentHubBestPriceTicks(side: BookSide, hubEntityId: string): bigint | null {
    const book = readCurrentHubPairBook(hubEntityId);
    if (!book) return null;
    return side === 'ask' ? getBestAsk(book) : getBestBid(book);
  }

  function toggleOrderbookScope(): void {
    orderbookScopeMode = orderbookScopeMode === 'aggregated' ? 'selected' : 'aggregated';
    selectedOrderLevel = null;
  }

  function resetOrderbookSelectionContext(): void {
    selectedOrderLevel = null;
    submitError = '';
    priceRatioInput = '';
    hasAutoSuggestedInitialPrice = false;
    hasUserEditedPriceInput = false;
  }

  function commitOrderbookCrossRoute(option: SwapOrderbookPairOption): boolean {
    const route = visibleRouteOptions.find((candidate) => candidate.value === option.routeValue)
      || (
        selectedRouteOption?.value === option.routeValue && routeMatchesCurrentSource(selectedRouteOption)
          ? selectedRouteOption
          : null
      );
    const routeIsCurrentSelected = selectedRouteOption?.value === option.routeValue && swapRouteMode === 'cross';
    const target = crossTargetOptions.find((candidate) => candidate.value === option.routeValue)
      || (
        selectedCrossTargetOverride?.value === option.routeValue
          ? selectedCrossTargetOverride
          : null
      );
    if (!route || route.mode !== 'cross' || route.disabled || (!routeIsCurrentSelected && !routeMatchesCurrentSource(route))) {
      submitError = 'Selected cross route is no longer available.';
      lastOrderbookPairSelectCommit = 'route-unavailable';
      return false;
    }
    if (
      String(option.sourceJurisdictionRef || '').trim().toLowerCase() !== String(route.sourceJurisdictionRef || '').trim().toLowerCase()
      || String(option.targetJurisdictionRef || '').trim().toLowerCase() !== String(route.targetJurisdictionRef || '').trim().toLowerCase()
    ) {
      submitError = 'Selected cross pair belongs to a different jurisdiction route.';
      lastOrderbookPairSelectCommit = 'route-mismatch';
      return false;
    }
    commitRouteSelection({ route, target });
    lastOrderbookPairSelectCommit = 'cross-committed';
    return true;
  }

  function selectOrderbookPairOption(value: string): void {
    lastOrderbookPairSelectValue = value;
    const option = orderbookPairOptions.find((candidate) => candidate.value === value);
    if (!option) {
      lastOrderbookPairSelectMode = 'missing';
      lastOrderbookPairSelectRoute = '';
      lastOrderbookPairSelectCommit = 'missing-option';
      return;
    }
    lastOrderbookPairSelectMode = option.mode;
    lastOrderbookPairSelectRoute = option.routeValue;
    lastOrderbookPairSelectCommit = 'selected';
    resetOrderbookSelectionContext();
    if (option.mode === 'cross') {
      if (!commitOrderbookCrossRoute(option)) return;
      setSwapTokens(option.sourceTokenId, option.targetTokenId, true);
      return;
    }

    if (liveSelectedRouteValue !== 'same') selectRouteOption('same');
    lastOrderbookPairSelectCommit = 'same-committed';
    const activeSide = orderMode !== 'none' ? orderMode : tradeSide;
    const nextGiveToken = activeSide === 'sell-base' ? option.baseTokenId : option.quoteTokenId;
    const nextWantToken = activeSide === 'sell-base' ? option.quoteTokenId : option.baseTokenId;
    setSwapTokens(nextGiveToken, nextWantToken);
  }

  function handleOrderbookPairSelectChange(event: Event): void {
    selectOrderbookPairOption(String((event.currentTarget as HTMLSelectElement | null)?.value || ''));
  }

  function handleSelectedHubChange(nextValue: string): void {
    if (orderbookScopeMode === 'aggregated') {
      createOrderAccountId = nextValue;
    } else {
      selectedBookAccountId = nextValue;
      createOrderAccountId = nextValue;
    }
    selectedOrderLevel = null;
    hubMenuOpen = false;
    sourceMenuOpen = false;
    openTokenMenu = '';
    setRouteMenuOpen(false, 'hub-change');
  }

  function selectHubOption(nextValue: string): void {
    const option = selectedHubOptions.find((candidate) => candidate.value === nextValue);
    if (!option) return;
    handleSelectedHubChange(option.value);
  }

  function defaultCreditLimitForToken(tokenIdValue: number): bigint {
    const decimals = BigInt(Math.max(0, getTokenDecimals(tokenIdValue)));
    return 10_000n * 10n ** decimals;
  }

  function computeCrossTargetCreditLimit(
    target: CrossTargetOption,
    targetReplica: EntityReplica | null,
    tokenIdValue: number,
    requiredInboundAmount: bigint,
  ): bigint | null {
    if (requiredInboundAmount <= 0n) return null;
    if (!hasReplicaAccount(targetReplica, target.targetHubEntityId)) {
      return maxBigInt(defaultCreditLimitForToken(tokenIdValue), requiredInboundAmount);
    }
    return computeAutoInboundCreditTargetForReplica(
      targetReplica,
      target.targetEntityId,
      target.targetHubEntityId,
      tokenIdValue,
      requiredInboundAmount,
    );
  }

  function handleOrderbookLevelClick(event: CustomEvent<SwapOrderbookLevelClickDetail>) {
    submitError = '';
    const pair = parsedOrderbookPair;
    if (!pair) {
      submitError = 'Select valid swap route first.';
      return;
    }

    const side = event.detail?.side;
    const rawSize = toBigIntSafe(event.detail?.size);
    const parsedPriceTicks = toBigIntSafe(event.detail?.priceTicks);
    if (
      (side !== 'ask' && side !== 'bid')
      || parsedPriceTicks === null
      || parsedPriceTicks <= 0n
      || rawSize === null
      || rawSize <= 0n
    ) {
      return;
    }

    const availableAccountIds = Array.isArray(event.detail?.accountIds)
      ? event.detail.accountIds.map((id) => String(id || '').trim()).filter(Boolean)
      : [];
    const clickedAccountId = swapRouteMode === 'cross'
      ? String(activeBookHubId || availableAccountIds[0] || '')
      : (
          orderbookScopeMode === 'aggregated'
            ? String(availableAccountIds.find((id) => hubAccountIds.includes(id)) || activeOrderAccountId || '')
            : String(selectedBookAccountId || availableAccountIds.find((id) => hubAccountIds.includes(id)) || '')
        );
    if (!clickedAccountId) {
      submitError = 'Pick a priced level from a connected account.';
      return;
    }
    if (swapRouteMode === 'cross') {
      const takeableSide: BookSide = activeCrossMarket?.sourceIsBase ? 'bid' : 'ask';
      if (side !== takeableSide) {
        return;
      }
      // Cross-j book owner can be the target hub. Source capacity still
      // belongs to activeOrderAccountId, so do not rewrite createOrderAccountId.
    } else if (orderbookScopeMode === 'aggregated') {
      createOrderAccountId = clickedAccountId;
    } else {
      selectedBookAccountId = clickedAccountId;
      createOrderAccountId = clickedAccountId;
    }

    const nextGiveToken = side === 'ask' ? pair.quoteTokenId : pair.baseTokenId;
    const nextWantToken = side === 'ask' ? pair.baseTokenId : pair.quoteTokenId;
    setSwapTokens(nextGiveToken, nextWantToken, swapRouteMode === 'cross');

    const priceTicks = parsedPriceTicks;
    const sizeBaseWei = lotsToBaseWei(rawSize, pair.baseTokenId);
    selectedOrderLevel = {
      side,
      priceTicks,
      displayPrice: typeof event.detail.displayPrice === 'string' ? event.detail.displayPrice : '',
      inputPriceTicks: parseDisplayPriceTicks(
        typeof event.detail.displayPrice === 'string' ? event.detail.displayPrice : '',
        priceTicks,
      ),
      sizeBaseWei,
      baseTokenId: pair.baseTokenId,
      quoteTokenId: pair.quoteTokenId,
      accountId: clickedAccountId,
      accountIds: availableAccountIds,
    };

    tradeSide = side === 'ask' ? 'buy-base' : 'sell-base';
    applyOrderPercent(100);
  }

  function resolveSuggestedInitialPriceTicks(): bigint | null {
    if (selectedOrderLevel) return null;
    if (String(orderbookSnapshot?.pairId || '').trim() !== String(orderbookPairId || '').trim()) return null;
    const activeMode = orderMode !== 'none' ? orderMode : tradeSide;
    if (activeMode === 'buy-base') {
      const ask = orderbookSnapshot.asks?.[0]?.price ?? 0n;
      return ask > 0n ? ask : null;
    }
    const bid = orderbookSnapshot.bids?.[0]?.price ?? 0n;
    return bid > 0n ? bid : null;
  }

  $: if (
    !hasAutoSuggestedInitialPrice
    && !hasUserEditedPriceInput
    && !priceRatioInput
    && orderbookSnapshot.updatedAt > 0
  ) {
    const suggestedTicks = resolveSuggestedInitialPriceTicks();
    if (suggestedTicks && suggestedTicks > 0n) {
      priceRatioInput = formatPriceTicks(suggestedTicks);
      hasAutoSuggestedInitialPrice = true;
    }
  }

  function resolveSignerId(entityId: string): string {
    const projectedSignerId = resolveProjectedSignerId(entityId);
    if (projectedSignerId) return projectedSignerId;
    if (runtimeEnv && activeXlnFunctions?.resolveEntityProposerId) {
      const proposerId = activeXlnFunctions.resolveEntityProposerId(runtimeEnv, entityId, 'swap-panel');
      if (proposerId) return proposerId;
    }
    if (runtimeEnv) return requireSignerIdForEntity(runtimeEnv, entityId, 'swap-panel');
    const normalized = String(entityId || 'unknown').trim().toLowerCase() || 'unknown';
    throw new Error(`No signer available for entity ${normalized} (swap-panel)`);
  }

  function getTokenDecimals(tokenIdValue: number): number {
    if (!activeXlnFunctions) throw new Error(`TOKEN_METADATA_READER_UNAVAILABLE:token:${tokenIdValue}`);
    return requireTokenDecimals(activeXlnFunctions.getTokenInfo(tokenIdValue).decimals, `token:${tokenIdValue}`);
  }

  function quoteFromBase(baseAmount: bigint, priceTicks: bigint, baseDecimals: number, quoteDecimals: number): bigint {
    if (baseAmount <= 0n || priceTicks <= 0n) return 0n;
    const baseScale = 10n ** BigInt(Math.max(0, baseDecimals));
    const quoteScale = 10n ** BigInt(Math.max(0, quoteDecimals));
    return (baseAmount * priceTicks * quoteScale) / (ORDERBOOK_PRICE_SCALE * baseScale);
  }

  function baseFromQuote(quoteAmount: bigint, priceTicks: bigint, baseDecimals: number, quoteDecimals: number): bigint {
    if (quoteAmount <= 0n || priceTicks <= 0n) return 0n;
    const baseScale = 10n ** BigInt(Math.max(0, baseDecimals));
    const quoteScale = 10n ** BigInt(Math.max(0, quoteDecimals));
    return (quoteAmount * ORDERBOOK_PRICE_SCALE * baseScale) / (priceTicks * quoteScale);
  }

  function prepareCanonicalOrder(rawGiveAmount: bigint, rawWantAmount: bigint): PreparedSwapOrderLike | null {
    if (!activeXlnFunctions?.isReady || !activeXlnFunctions?.prepareSwapOrder) return null;
    if (!Number.isFinite(giveToken) || !Number.isFinite(wantToken) || giveToken <= 0 || wantToken <= 0) return null;
    if (rawGiveAmount <= 0n || rawWantAmount <= 0n) return null;
    try {
      const explicitPriceTicks = selectedOrderLevel?.inputPriceTicks && selectedOrderLevel.inputPriceTicks > 0n
        ? selectedOrderLevel.inputPriceTicks
        : limitPriceTicks;
      if (explicitPriceTicks && explicitPriceTicks > 0n) {
        const requantized = requantizeAtLimitPrice(
          giveToken,
          wantToken,
          rawGiveAmount,
          explicitPriceTicks,
        );
        if (requantized && requantized.effectiveGive > 0n && requantized.effectiveWant > 0n) {
          return requantized;
        }
      }
      return activeXlnFunctions.prepareSwapOrder(giveToken, wantToken, rawGiveAmount, rawWantAmount);
    } catch {
      return null;
    }
  }

  $: activeCrossMarket = (() => {
    if (swapRouteMode !== 'cross' || !selectedCrossTarget) return null;
    if (!Number.isFinite(giveToken) || !Number.isFinite(wantToken) || giveToken <= 0 || wantToken <= 0) return null;
    const market = deriveCanonicalCrossJurisdictionMarketForLegs(
      getReplicaJurisdictionRef(currentReplica),
      giveToken,
      selectedCrossTarget.targetJurisdictionRef,
      wantToken,
    ) as CrossMarketView;
    if (!market.sourceKey || !market.targetKey || market.sourceKey === market.targetKey) return null;
    return market;
  })();
  $: parsedOrderbookPair = (() => {
    if (swapRouteMode === 'cross' && activeCrossMarket) {
      return {
        baseTokenId: activeCrossMarket.sourceIsBase ? giveToken : wantToken,
        quoteTokenId: activeCrossMarket.sourceIsBase ? wantToken : giveToken,
      };
    }
    return selectedPair
      ? { baseTokenId: selectedPair.baseTokenId, quoteTokenId: selectedPair.quoteTokenId }
      : null;
  })();
  $: orderbookPairId = swapRouteMode === 'cross' && activeCrossMarket
    ? activeCrossMarket.venueId
    : selectedPair?.pairId || '1/2';
  $: orderMode = parsedOrderbookPair
    ? (
        swapRouteMode === 'cross' && activeCrossMarket
          ? (activeCrossMarket.sourceIsBase ? 'sell-base' : 'buy-base')
          : tradeSide
      )
    : 'none';
  $: {
    const nextPriceContextSignature = [
      swapRouteMode,
      liveSelectedRouteValue,
      activeBookHubId,
      orderbookPairId,
      giveToken,
      wantToken,
      orderMode,
    ].join('::');
    if (nextPriceContextSignature !== lastPriceContextSignature) {
      lastPriceContextSignature = nextPriceContextSignature;
      if (preservePriceOnNextContextChange) {
        preservePriceOnNextContextChange = false;
      } else if (!selectedOrderLevel) {
        priceRatioInput = '';
        hasAutoSuggestedInitialPrice = false;
        hasUserEditedPriceInput = false;
      }
    }
  }
  $: baseTokenId = parsedOrderbookPair?.baseTokenId ?? giveToken;
  $: quoteTokenId = parsedOrderbookPair?.quoteTokenId ?? wantToken;
  $: baseTokenSymbol = tokenSymbol(baseTokenId);
  $: quoteTokenSymbol = tokenSymbol(quoteTokenId);
  $: orderbookPairDisplayLabel = swapRouteMode === 'cross' && activeCrossMarket
    ? crossOrderbookPairLabel(
        baseTokenId,
        jurisdictionLabelForAssetKey(activeCrossMarket.baseKey),
        quoteTokenId,
        jurisdictionLabelForAssetKey(activeCrossMarket.quoteKey),
        tokenSymbol,
      )
    : sameOrderbookPairLabel(baseTokenId, quoteTokenId, sourceJurisdictionLabel, tokenSymbol);
  $: orderbookPairOptions = (
    activeOrderAccountId,
    selectedBookAccountId,
    createOrderAccountId,
    sourceJurisdictionLabel,
    targetJurisdictionLabel,
    swapRouteMode,
    selectedRouteOption,
    selectedCrossTarget,
    liveSelectedRouteValue,
    giveToken,
    wantToken,
    buildOrderbookPairOptions()
  );
  $: orderbookPairSelectValue = (() => {
    if (swapRouteMode === 'cross') {
      const exactCrossValue = selectedRouteOption
        ? `cross:${liveSelectedRouteValue}:${selectedRouteOption.sourceJurisdictionRef}:${giveToken}:${selectedRouteOption.targetJurisdictionRef}:${wantToken}`
        : '';
      return orderbookPairOptions.find((option) => option.value === exactCrossValue)?.value
        || orderbookPairOptions.find((option) => option.mode === 'cross' && option.pairId === orderbookPairId)?.value
        || '';
    }
    const exactSameValue = selectedPair ? `same:${selectedPair.pairId}` : '';
    return orderbookPairOptions.find((option) => option.value === exactSameValue)?.value
      || orderbookPairOptions.find((option) => option.mode === 'same' && option.pairId === orderbookPairId)?.value
      || '';
  })();
  $: baseTokenDecimals = getTokenDecimals(baseTokenId);
  $: quoteTokenDecimals = getTokenDecimals(quoteTokenId);
  $: orderbookSizeDisplayScale = baseTokenDecimals > 12 ? 10 ** Math.max(0, baseTokenDecimals - 12) : 1;
  $: giveTokenDecimals = getTokenDecimals(giveToken);
  $: limitPriceTicks = parseDisplayPriceTicks(priceRatioInput, 0n);
  $: liveOrderAmountInput = (
    $routedOrderAmountInput,
    orderAmountRevision,
    orderAmountDomRevision,
    $routedOrderAmountInput || (
      hasLatestOrderAmountDomValue
        ? latestOrderAmountDomValue
        : String(orderAmountInputElement?.value ?? orderAmountInput ?? '')
    )
  );
  $: giveAmount = parseDecimalAmountToBigInt(liveOrderAmountInput, giveTokenDecimals);
  $: wantAmount = (() => {
    if (giveAmount <= 0n || !limitPriceTicks || limitPriceTicks <= 0n || !parsedOrderbookPair) return 0n;
    if (orderMode === 'sell-base') {
      return quoteFromBase(giveAmount, limitPriceTicks, baseTokenDecimals, quoteTokenDecimals);
    }
    if (orderMode === 'buy-base') {
      return baseFromQuote(giveAmount, limitPriceTicks, baseTokenDecimals, quoteTokenDecimals);
    }
    return 0n;
  })();
  $: preparedOrder = prepareCanonicalOrder(giveAmount, wantAmount);
  $: canonicalPriceTicks = preparedOrder?.priceTicks ?? limitPriceTicks;
  $: canonicalGiveAmount = preparedOrder?.effectiveGive ?? 0n;
  $: canonicalWantAmount = preparedOrder?.effectiveWant ?? 0n;
  $: giveAmountLeftover = preparedOrder?.unspentGiveAmount ?? 0n;
  function computeSwapPriceTicksSafe(
    giveTokenValue: number,
    wantTokenValue: number,
    giveAmountValue: bigint,
    wantAmountValue: bigint,
  ): bigint {
    return activeXlnFunctions?.computeSwapPriceTicks
      ? activeXlnFunctions.computeSwapPriceTicks(giveTokenValue, wantTokenValue, giveAmountValue, wantAmountValue)
      : 0n;
  }

  function orderHistoryDeps() {
    return {
      resolvePairOrientation,
      getTokenDecimals,
      quoteFromBase,
    };
  }

  function offerSideLabel(offer: OfferLike): 'Ask' | 'Bid' {
    return offerSideLabelPure(offer, resolvePairOrientation);
  }

  function offerPriceTicks(offer: OfferLike): bigint {
    return offerPriceTicksPure(offer, computeSwapPriceTicksSafe);
  }

  function remainingOfferUsd(offer: SwapOfferLike): number {
    return remainingOfferUsdPure(offer, (tokenIdValue) => activeXlnFunctions?.getTokenInfo?.(tokenIdValue));
  }

  function isDustOpenOffer(offer: SwapOfferLike): boolean {
    return isDustOpenOfferPure(
      offer,
      MIN_ORDER_NOTIONAL_USD,
      (tokenIdValue) => activeXlnFunctions?.getTokenInfo?.(tokenIdValue),
    );
  }

  $: routeFilteredOpenOffers = (Array.isArray(activeOffers) ? activeOffers : []).filter((offer: SwapOfferLike) => {
    if (orderRouteFilter === 'all') return true;
    const isCross = Boolean(offer.crossJurisdiction);
    return orderRouteFilter === 'cross' ? isCross : !isCross;
  });
  $: openOrders = [...(Array.isArray(routeFilteredOpenOffers) ? routeFilteredOpenOffers : [])].sort((a: SwapOfferLike, b: SwapOfferLike) => {
    const aDust = isDustOpenOffer(a);
    const bDust = isDustOpenOffer(b);
    if (aDust !== bDust) return aDust ? 1 : -1;
    const aCreated = BigInt(a.createdHeight);
    const bCreated = BigInt(b.createdHeight);
    if (aCreated === bCreated) return compareStableText(String(a.offerId), String(b.offerId));
    return aCreated > bCreated ? -1 : 1;
  });
  $: ownOrderbookEntityIds = Array.from(new Set([
    sourceEntityIdValue,
    ...(selectedCrossTarget?.targetEntityId ? [selectedCrossTarget.targetEntityId] : []),
  ].map((id) => String(id || '').trim().toLowerCase()).filter(Boolean)));

  function accountMachines(): Array<{ accountId: string; account: AccountMachine }> {
    if (!(currentReplica?.state?.accounts instanceof Map)) return [];
    return Array.from(currentReplica.state.accounts.entries()).map(([accountId, account]) => ({
      accountId: String(accountId),
      account,
    }));
  }

  function collectOfferLifecyclesFrom(
    selectSource: (account: AccountMachine) => Map<string, unknown> | undefined,
  ): OfferLifecycle[] {
    return collectOfferLifecyclesFromPure(accountMachines(), selectSource, computeSwapPriceTicksSafe);
  }

  $: {
    currentReplica;
    activeXlnFunctions;
    offerLifecycles = collectOfferLifecyclesFrom((account) => account.swapOrderHistory);
    closedOfferLifecycles = collectOfferLifecyclesFrom((account) => account.swapClosedOrders);
  }

  $: closedOrderViews = buildClosedOrderViews(closedOfferLifecycles, {
    ...orderHistoryDeps(),
    tokenSymbol,
    filledDisplayPpmThreshold: FILLED_DISPLAY_PPM_THRESHOLD,
  });
  $: filteredClosedOrderViews = closedOrderStatusFilter === 'all'
    ? (Array.isArray(closedOrderViews) ? closedOrderViews : [])
    : (Array.isArray(closedOrderViews) ? closedOrderViews : []).filter((order) => order.status === closedOrderStatusFilter);
  $: offerPriceImprovementByKey = buildOfferPriceImprovementByKey(offerLifecycles, orderHistoryDeps());
  $: totalPriceImprovementSummary = buildTotalPriceImprovementSummary(offerLifecycles, {
    ...orderHistoryDeps(),
    formatAmount,
    tokenSymbol,
  });
  $: if (pendingSwapFeedbackOfferId) {
    const closed = closedOrderViews.find((order) => order.offerId === pendingSwapFeedbackOfferId);
    if (closed) {
      const stpBlockingOrderId = extractStpBlockingOrderId(closed.closeComment);
      if (closed.status === 'filled' && closed.filledPercent >= 99.99) {
        swapCompletionModal = {
          offerId: closed.offerId,
          side: closed.side,
          pairLabel: closed.pairLabel,
          filledGiveAmount: closed.filledGiveAmount,
          filledWantAmount: closed.filledWantAmount,
          giveTokenId: closed.giveTokenId,
          wantTokenId: closed.wantTokenId,
          priceImprovementAmount: closed.priceImprovementAmount,
          priceImprovementTokenId: closed.priceImprovementTokenId,
          feeAmount: closed.feeAmount,
          feeTokenId: closed.feeTokenId,
        };
        const improvementNote = closed.priceImprovementAmount > 0n
          ? ` with ${formatPriceImprovement(closed.priceImprovementAmount, closed.priceImprovementTokenId)} price improvement`
          : '';
        const feeNote = closed.feeAmount > 0n
          ? `. Fee: ${formatSwapFee(closed.feeAmount, closed.feeTokenId)}`
          : '';
        toasts.success(`Order placed and fully filled${improvementNote}${feeNote}`);
      } else if (closed.status === 'partial') {
        if (stpBlockingOrderId) {
          const feeNote = closed.feeAmount > 0n
            ? ` Fee: ${formatSwapFee(closed.feeAmount, closed.feeTokenId)}.`
            : '';
          toasts.info(`Swap partially filled (${closed.filledPercent.toFixed(2)}%). Remaining quantity was canceled to avoid matching your own order ${stpBlockingOrderId.slice(-8)}.${feeNote}`);
        } else {
          const improvementNote = closed.priceImprovementAmount > 0n
            ? ` Price improvement: ${formatPriceImprovement(closed.priceImprovementAmount, closed.priceImprovementTokenId)}.`
            : '';
          const feeNote = closed.feeAmount > 0n
            ? ` Fee: ${formatSwapFee(closed.feeAmount, closed.feeTokenId)}.`
            : '';
          toasts.info(`Swap partially filled (${closed.filledPercent.toFixed(2)}%) and closed the remainder.${improvementNote}${feeNote}`);
        }
      } else if (closed.status === 'canceled') {
        if (stpBlockingOrderId) {
          toasts.info(`Swap was canceled to avoid matching your own order ${stpBlockingOrderId.slice(-8)}.`);
        } else {
          toasts.info('Swap was canceled without a fill.');
        }
      }
      pendingSwapFeedbackOfferId = '';
    }
  }

  async function placeSwapOffer() {
    if (placingSwapOffer) return;
    const placementStartedAt = performance.now();
    placingSwapOffer = true;
    submitError = '';
    try {
      if (!activeIsLive) throw new Error('Swap actions are only available in LIVE mode');
      const sourceEntityId = sourceEntityIdValue;
      if (!sourceEntityId) throw new Error('No source entity selected');
      const signerId = sourceSignerIdValue || resolveSignerId(sourceEntityId);
      if (!signerId) throw new Error('No signer available for selected entity');

      const resolvedCounterparty = resolveCounterpartyId(activeOrderAccountId);
      if (!resolvedCounterparty) {
        throw new Error('Select counterparty from your account list');
      }

      const giveToken = Number.parseInt(giveTokenId, 10);
      const wantToken = Number.parseInt(wantTokenId, 10);
      if (giveAmount <= 0n || wantAmount <= 0n) {
        throw new Error('Enter amount and limit price');
      }
      const clickedPrepared = selectedOrderLevel
        ? requantizeAtLimitPrice(
            giveToken,
            wantToken,
            giveAmount,
            selectedOrderLevel.inputPriceTicks || selectedOrderLevel.priceTicks,
          )
        : null;
      const prepared = clickedPrepared ?? prepareCanonicalOrder(giveAmount, wantAmount);
      if (!prepared) throw new Error('Order does not fit canonical lot/tick constraints');
      let effectiveGiveAmount = prepared.effectiveGive;
      let effectiveWantAmount = prepared.effectiveWant;
      const explicitSubmitPriceTicks = parseDisplayPriceTicks(
        priceRatioInput,
        selectedOrderLevel?.inputPriceTicks || prepared.priceTicks,
      );
      let canonicalPriceTicks = explicitSubmitPriceTicks;

      if (effectiveGiveAmount <= 0n || effectiveWantAmount <= 0n) {
        throw new Error('Quantized order too small');
      }
      if (!Number.isFinite(giveToken) || !allowedSwapTokenIds.has(giveToken)) {
        throw new Error('Invalid give token');
      }
      if (!Number.isFinite(wantToken) || !allowedSwapTokenIds.has(wantToken)) {
        throw new Error('Invalid want token');
      }
      if (giveToken === wantToken && swapRouteMode === 'same') {
        throw new Error('Give token and want token must be different');
      }
      const liveValidation = buildSwapValidationInput(
        resolvedCounterparty,
        giveToken,
        wantToken,
        effectiveGiveAmount,
        effectiveWantAmount,
        canonicalPriceTicks,
      );
      const liveValidationReason = swapRouteMode === 'cross'
        ? validateCrossSwapForm(liveValidation, selectedCrossTarget, canAutoPrepareCrossInboundCapacity, canAutoOpenCrossTargetAccount)
        : validateSwapForm(liveValidation);
      if (
        liveValidationReason
        && !(swapRouteMode === 'same' && isInboundCapacityValidationError(liveValidationReason) && canAutoPrepareInboundCapacity)
      ) {
        throw new Error(liveValidationReason);
      }

      const { logicalTimestamp: logicalNow, logicalHeight } = resolveSwapLogicalClock(currentReplica);
      const offerId = buildSwapOfferId({
        logicalTimestamp: logicalNow,
        logicalHeight,
        sourceEntityId,
        counterpartyEntityId: resolvedCounterparty,
        sellToken: giveToken,
        buyToken: wantToken,
        sellAmount: effectiveGiveAmount,
        buyAmount: effectiveWantAmount,
        priceTicks: canonicalPriceTicks,
        routeValue: liveSelectedRouteValue,
      });
      const minFillRatio = 0;
      const requiredInboundCreditLimit = computeAutoInboundCreditTarget(
        resolvedCounterparty,
        wantToken,
        effectiveWantAmount,
      );
      const currentInboundCreditLimit = readPeerCreditLimit(resolvedCounterparty, wantToken);
      const shouldAutoPrepareInbound = (
        swapRouteMode === 'same'
        &&
        requiredInboundCreditLimit !== null
        && requiredInboundCreditLimit > currentInboundCreditLimit
        && isInboundCapacityValidationError(liveValidationReason)
      );
      const targetRoute = selectedCrossTarget;
      const targetReplica = targetRoute ? findReplicaByEntityId(targetRoute.targetEntityId) : null;
      const requiredTargetInboundAmount = effectiveWantAmount;
      const requiredTargetInboundCreditLimit = targetRoute
        ? computeCrossTargetCreditLimit(targetRoute, targetReplica, wantToken, requiredTargetInboundAmount)
        : null;
      const targetAccountExists = Boolean(targetRoute && hasReplicaAccount(targetReplica, targetRoute.targetHubEntityId));
      const currentTargetInboundCreditLimit = targetRoute && targetAccountExists
        ? readPeerCreditLimitForReplica(targetReplica, targetRoute.targetEntityId, targetRoute.targetHubEntityId, wantToken)
        : 0n;
      const shouldAutoOpenCrossTargetAccount = Boolean(
        swapRouteMode === 'cross'
        && targetRoute
        && !targetAccountExists,
      );
      const shouldAutoPrepareCrossInbound = Boolean(
        swapRouteMode === 'cross'
        && requiredTargetInboundCreditLimit !== null
        && requiredTargetInboundCreditLimit > currentTargetInboundCreditLimit,
      );
      const now = logicalNow;
      const crossJurisdiction = (() => {
        if (swapRouteMode !== 'cross') return null;
        if (!targetRoute) throw new Error('Select target jurisdiction account.');
        const sourceJurisdiction = getReplicaJurisdictionName(currentReplica);
        const sourceJurisdictionRef = getReplicaJurisdictionRef(currentReplica);
        if (!sourceJurisdiction) throw new Error('Source jurisdiction is not available.');
        if (!sourceJurisdictionRef) throw new Error('Source jurisdiction stack is not available.');
        if (!targetRoute.targetJurisdiction) throw new Error('Target jurisdiction is not available.');
        if (!targetRoute.targetJurisdictionRef) throw new Error('Target jurisdiction stack is not available.');
        if (sourceJurisdictionRef === targetRoute.targetJurisdictionRef) {
          throw new Error('Cross-j route requires different jurisdictions.');
        }
        const bookOwnerEntityId = deriveCanonicalCrossJurisdictionBookOwnerForLegs(
          sourceJurisdictionRef,
          resolvedCounterparty,
          targetRoute.targetJurisdictionRef,
          targetRoute.targetHubEntityId,
        );
        const sourceHubSignerId = resolveSignerId(resolvedCounterparty);
        const targetHubSignerId = resolveSignerId(targetRoute.targetHubEntityId);
        const bookHubSignerId = bookOwnerEntityId.toLowerCase() === resolvedCounterparty.toLowerCase()
          ? sourceHubSignerId
          : bookOwnerEntityId.toLowerCase() === targetRoute.targetHubEntityId.toLowerCase()
            ? targetHubSignerId
            : resolveSignerId(bookOwnerEntityId);
        return {
          orderId: offerId,
          bookOwnerEntityId,
          venueId: deriveCanonicalCrossJurisdictionVenueIdForLegs(sourceJurisdictionRef, giveToken, targetRoute.targetJurisdictionRef, wantToken),
          makerEntityId: sourceEntityId,
          hubEntityId: bookOwnerEntityId,
          sourceSignerId: signerId,
          sourceHubSignerId,
          targetHubSignerId,
          targetSignerId: targetRoute.targetSignerId,
          bookHubSignerId,
          source: {
            jurisdiction: sourceJurisdictionRef,
            entityId: sourceEntityId,
            counterpartyEntityId: resolvedCounterparty,
            tokenId: giveToken,
            amount: effectiveGiveAmount,
          },
          target: {
            jurisdiction: targetRoute.targetJurisdictionRef,
            entityId: targetRoute.targetHubEntityId,
            counterpartyEntityId: targetRoute.targetEntityId,
            tokenId: wantToken,
            amount: effectiveWantAmount,
          },
          priceTicks: canonicalPriceTicks,
          priceImprovementMode: 'source_savings',
          status: 'intent',
          createdAt: now,
          updatedAt: now,
          expiresAt: now + 24 * 60 * 60 * 1000,
        } satisfies CrossJurisdictionSwapRoute;
      })();
      const entityTxs: EntityTx[] = [];
      if (shouldAutoPrepareInbound) {
        entityTxs.push({
          type: 'extendCredit' as const,
          data: {
            counterpartyEntityId: resolvedCounterparty,
            tokenId: wantToken,
            amount: requiredInboundCreditLimit,
          },
        });
      }

      if (crossJurisdiction && targetRoute) {
        const crossSubmitStartedAt = performance.now();
        performance.measure('xln.cross_j.handler_to_plan', {
          start: placementStartedAt,
          end: crossSubmitStartedAt,
        });
        const crossInputPlan = buildCrossSwapRuntimeInputPlan({
          sourceEntityId,
          sourceSignerId: signerId,
          route: crossJurisdiction,
          targetEntityId: targetRoute.targetEntityId,
          targetSignerId: targetRoute.targetSignerId,
          targetHubEntityId: targetRoute.targetHubEntityId,
          tokenId: wantToken,
          requiredCreditLimit: requiredTargetInboundCreditLimit,
          shouldOpenTargetAccount: shouldAutoOpenCrossTargetAccount,
          shouldExtendTargetCredit: shouldAutoPrepareCrossInbound,
        });
        if (crossInputPlan.targetSetupTxs.length > 0) {
          const prewarmStartedAt = performance.now();
          await prewarmCounterpartyProfiles(runtimeEnv, [targetRoute.targetHubEntityId]);
          performance.measure('xln.cross_j.profile_prewarm', {
            start: prewarmStartedAt,
            end: performance.now(),
          });
        }
        const runtimeSubmitStartedAt = performance.now();
        await submitRuntimeInput(crossInputPlan.input);
        performance.measure('xln.cross_j.runtime_submit', {
          start: runtimeSubmitStartedAt,
          end: performance.now(),
        });
        performance.measure('xln.cross_j.submit_total', {
          start: crossSubmitStartedAt,
          end: performance.now(),
        });
      } else {
        entityTxs.push({
          type: 'placeSwapOffer' as const,
          data: {
            offerId,
            counterpartyEntityId: resolvedCounterparty,
            giveTokenId: giveToken,
            giveAmount: effectiveGiveAmount,
            wantTokenId: wantToken,
            wantAmount: effectiveWantAmount,
            priceTicks: canonicalPriceTicks,
            minFillRatio,
          },
        });
        await submitEntityInputs([{
          entityId: sourceEntityId,
          signerId,
          entityTxs,
        }]);
      }

      orderbookRefreshNonce += 1;
      pendingSwapFeedbackOfferId = offerId;
      if (crossJurisdiction) {
        toasts.success('Cross-j swap preparation submitted');
      }

      // Reset form
      orderPercent = 100;
      selectedOrderLevel = null;
      setOrderAmountInputValue('');
      priceRatioInput = '';
    } catch (error) {
      logSwapDiagnostic('Swap offer placement failed', error);
      submitError = `Failed to place swap: ${toErrorMessage(error)}`;
    } finally {
      placingSwapOffer = false;
    }
  }

  async function cancelSwapOffer(offerId: string, accountId: string) {
    const sourceEntityId = sourceEntityIdValue;
    if (!sourceEntityId) return;

    try {
      if (!activeIsLive) throw new Error('Swap actions are only available in LIVE mode');
      const signerId = sourceSignerIdValue || resolveSignerId(sourceEntityId);
      if (!signerId) throw new Error('No signer available for selected entity');

      await submitEntityInputs([{
        entityId: sourceEntityId,
        signerId,
        entityTxs: [{
          type: 'proposeCancelSwap',
          data: {
            offerId,
            counterpartyEntityId: accountId,
          }
        }]
      }]);

      orderbookRefreshNonce += 1;
      toasts.info('Cancel request sent');
    } catch (error) {
      logSwapDiagnostic('Swap cancel request failed', error, { offerId, cancelAccountId: accountId });
      const message = toErrorMessage(error);
      submitError = `Failed to cancel: ${message}`;
      toasts.error(`Cancel failed: ${message}`);
    }
  }

  async function requestCrossClear(offerId: string, cancelRemainder = false) {
    const sourceEntityId = sourceEntityIdValue;
    if (!sourceEntityId) return;

    try {
      if (!activeIsLive) throw new Error('Swap actions are only available in LIVE mode');
      const signerId = sourceSignerIdValue || resolveSignerId(sourceEntityId);
      if (!signerId) throw new Error('No signer available for selected entity');

      await submitEntityInputs([{
        entityId: sourceEntityId,
        signerId,
        entityTxs: [{
          type: 'requestCrossJurisdictionClear',
          data: {
            orderId: offerId,
            cancelRemainder,
          },
        }],
      }]);

      orderbookRefreshNonce += 1;
      toasts.info(cancelRemainder ? 'Cross-j cancel + clear requested' : 'Cross-j clear requested');
    } catch (error) {
      logSwapDiagnostic('Cross-j swap clear request failed', error, { offerId, cancelRemainder });
      const message = toErrorMessage(error);
      submitError = `Failed to clear cross-j swap: ${message}`;
      toasts.error(`Clear failed: ${message}`);
    }
  }

  // Format BigInt for display
  function formatAmount(amount: bigint, tokenIdValue: number): string {
    return formatSwapTokenAmount(amount, getTokenDecimals(tokenIdValue));
  }

  function formatAmountForInput(amount: bigint, tokenIdValue: number): string {
    return formatSwapTokenAmountForInput(amount, getTokenDecimals(tokenIdValue));
  }

  function requantizeAtLimitPrice(
    activeGiveTokenId: number,
    activeWantTokenId: number,
    remainingGiveAmount: bigint,
    priceTicks: bigint,
  ): PreparedSwapOrderLike | null {
    if (!activeXlnFunctions?.isReady) return null;
    const quantized = activeXlnFunctions.requantizeRemainingSwapAtPrice(
      activeGiveTokenId,
      activeWantTokenId,
      remainingGiveAmount,
      priceTicks,
    );
    return quantized ? {
      priceTicks,
      effectiveGive: quantized.effectiveGive,
      effectiveWant: quantized.effectiveWant,
      unspentGiveAmount: quantized.releasedGiveDust,
    } : null;
  }

  function parseDisplayPriceTicks(displayPrice: string, fallbackPriceTicks: bigint): bigint {
    return parseSwapDisplayPriceTicks(displayPrice, fallbackPriceTicks);
  }

  function stepPrice(direction: 1 | -1): void {
    const current = parseDecimalAmountToBigInt(priceRatioInput || '0', ORDERBOOK_PRICE_DECIMALS);
    const step = 1n; // 1 tick = 0.0001
    const next = current + BigInt(direction) * step;
    if (next <= 0n) return;
    priceRatioInput = formatPriceTicks(next);
    hasUserEditedPriceInput = true;
    selectedOrderLevel = null;
  }

  function useMarketPrice(): void {
    const ticks = marketPriceTicks;
    if (!ticks || ticks <= 0n) return;
    priceRatioInput = formatPriceTicks(ticks);
    hasUserEditedPriceInput = true;
    selectedOrderLevel = null;
    submitError = '';
  }

</script>

<svelte:window on:click={handleSwapWindowClick} on:keydown={handleSwapWindowKeydown} />

<div
  class="swap-panel"
  bind:this={swapPanelRoot}
  on:input|capture={handleSwapPanelAmountSync}
  on:change|capture={handleSwapPanelAmountSync}
>
  <div class="trade-grid" class:book-open={showOrderbook}>
    <SwapTradeTicket
      bind:showOrderbook
      {swapRouteMode}
      {sourceAssetLabel}
      {targetAssetLabel}
      {swapRouteTitle}
      {selectedSourceEntity}
      bind:selectedSourceEntityValue
      {selectedSourceEntityLabel}
      {sourceEntityIdValue}
      {sourceJurisdictionLabel}
      {sourceMenuOpen}
      {sourceEntityOptions}
      {toggleSourceMenu}
      {handleSourceEntityChange}
      {selectSourceEntityOption}
      {accountLabel}
      {entityAvatarSrc}
      bind:orderAmountInput
      bind:orderAmountInputElement
      {handleOrderAmountInput}
      {openTokenMenu}
      {toggleTokenMenu}
      {tokenClass}
      {tokenIconText}
      bind:giveTokenId
      {giveToken}
      {giveTokenSymbol}
      {giveTokenOptions}
      {handleGiveTokenChange}
      {selectGiveTokenOption}
      {formattedAvailableGive}
      {formattedAvailableGiveAmount}
      {flipSwapTokens}
      {routeMenuButtonAction}
      {routeMenuOpenStore}
      {routeMenuToggleCount}
      {routeMenuNativeClickCount}
      {routeMenuSetCount}
      {routeMenuLastSetReason}
      {selectedRouteLabel}
      {selectedRouteEntityId}
      {selectedRouteEntityName}
      {selectedRouteJurisdictionLabel}
      bind:routeSelectElement
      bind:selectedRouteValue
      {liveSelectedRouteValue}
      {committedRouteSelectionValue}
      {routeSelectionCommitNonce}
      {visibleRouteOptions}
      {handleRouteSelectChange}
      {selectRouteOption}
      {wantAmount}
      {wantToken}
      bind:wantTokenId
      {wantTokenSymbol}
      {wantTokenOptions}
      {handleWantTokenChange}
      {selectWantTokenOption}
      {targetAccountReady}
      {formattedTargetCapacityAmount}
      {targetCapacityLabel}
      bind:priceRatioInput
      bind:createOrderAccountId
      {quoteTokenSymbol}
      {marketPriceTicks}
      {marketPriceSideLabel}
      {marketPriceLabel}
      {bookVenueLabel}
      {hubMenuOpen}
      {activeOrderAccountId}
      {selectedHubDisplayLabel}
      {selectedHubLabel}
      {selectedHubJurisdictionLabel}
      {selectedHubOptions}
      {orderPercent}
      {handlePriceRatioInput}
      {stepPrice}
      {useMarketPrice}
      {toggleHubMenu}
      {handleSelectedHubChange}
      {selectHubOption}
      {hubJurisdictionLabel}
      {applyOrderPercent}
      {liveOrderAmountInput}
      {latestOrderAmountDomValue}
      {hasLatestOrderAmountDomValue}
      {orderAmountRevision}
      {orderAmountDomRevision}
      {giveTokenDecimals}
      {giveAmount}
      {canonicalGiveAmount}
      {routeSummaryLabel}
      {routePathLabel}
      {routeVenueDisplayLabel}
      {routeSummaryAssetsLabel}
      bind:routeDetailsOpen
      {routePathSourceLabel}
      {routePathTargetLabel}
      {sourceRouteEntityLabel}
      {targetRouteEntityLabel}
      {showManualRouteRecommendation}
      {routedRouteRecommendations}
      {manualRouteEstimateLabel}
      {capacityWarning}
      {autoCapacityNote}
      {crossSwapSetupSteps}
      {selectedOrderLevel}
      {formatPriceTicks}
      {formatAmount}
      {orderMode}
      {placingSwapOffer}
      {swapActionDisabledReason}
      {placeSwapOffer}
      {swapSubmitLabel}
      {submitError}
    />

    {#if showOrderbook}
      <SwapOrderbookSection
        {activeBookHubId}
        {orderbookHubIds}
        {activeOrderAccountId}
        {selectedBookAccountId}
        {createOrderAccountId}
        selectedRouteSourceHub={selectedRouteOption?.sourceHubEntityId || ''}
        selectedRouteTargetHub={selectedRouteOption?.targetHubEntityId || ''}
        selectedCrossTargetHub={selectedCrossTarget?.targetHubEntityId || ''}
        {swapRouteMode}
        {orderbookPairSelectValue}
        {lastOrderbookPairSelectValue}
        {lastOrderbookPairSelectMode}
        {lastOrderbookPairSelectRoute}
        {lastOrderbookPairSelectCommit}
        {orderbookPairDisplayLabel}
        {orderbookPairOptions}
        {orderbookScopeMode}
        {visibleOrderbookHubIds}
        {activeOrderbookRelayUrl}
        {orderbookPairId}
        {orderbookDepth}
        {orderbookSourceLabels}
        {orderbookSourceAvatars}
        {ownOrderbookEntityIds}
        orderbookPriceScale={Number(ORDERBOOK_PRICE_SCALE)}
        {orderbookSizeDisplayScale}
        {orderMode}
        {orderbookRefreshNonce}
        {handleOrderbookPairSelectChange}
        {toggleOrderbookScope}
        {handleOrderbookLevelClick}
        {handleOrderbookSnapshot}
      />
    {/if}
  </div>

  <SwapOrderList
    bind:orderListTab
    bind:orderRouteFilter
    bind:closedOrderStatusFilter
    {openOrders}
    {closedOrderViews}
    {filteredClosedOrderViews}
    {totalPriceImprovementSummary}
    {offerPriceImprovementByKey}
    minOrderNotionalUsd={MIN_ORDER_NOTIONAL_USD}
    {tokenSymbol}
    {resolvePairOrientation}
    {offerLifecycleKey}
    {offerSideLabel}
    {offerPriceTicks}
    {isDustOpenOffer}
    {remainingOfferUsd}
    {formatPriceTicks}
    {formatAmount}
    {formatPriceImprovement}
    {formatCloseComment}
    {formatOrderTime}
    {closedOrderStatusLabel}
    {closedOrderStatusTone}
    {cancelSwapOffer}
    {requestCrossClear}
  />

  {#if swapCompletionModal}
    <SwapCompletionDialog
      modal={swapCompletionModal}
      {formatAmount}
      {tokenSymbol}
      {formatPriceImprovement}
      {formatSwapFee}
      on:close={() => (swapCompletionModal = null)}
    />
  {/if}
</div>
