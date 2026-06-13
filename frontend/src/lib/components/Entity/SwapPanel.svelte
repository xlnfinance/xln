  <script lang="ts">
  import { flushSync, onMount, tick } from 'svelte';
    import type { AccountMachine, EntityReplica, Tab } from '$lib/types/ui';
  import { writable } from 'svelte/store';
  import type { BookState, CrossJurisdictionSwapRoute, Delta, EntityState, Env, EnvSnapshot, RoutedEntityInput } from '@xln/runtime/xln-api';
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
  import { enqueueEntityInputs, xlnFunctions } from '../../stores/xlnStore';
  import { toasts } from '../../stores/toastStore';
  import { requireSignerIdForEntity } from '$lib/utils/entityReplica';
  import { unwrapLiveRuntimeEnv } from '$lib/utils/liveRuntimeEnv';
  import { prewarmCounterpartyProfiles } from '$lib/utils/p2pPrefetch';
  import { amountToUsd } from '$lib/utils/assetPricing';
  import OrderbookPanel from '../Trading/OrderbookPanel.svelte';
  import { resolveEntityName } from '$lib/utils/entityNaming';
  import { formatEntityId } from '$lib/utils/format';
  import {
    compareStableText,
    decimalPlacesFromScale,
    normalizeDecimalInput,
    normalizeDisplayPriceForInput,
    parseDecimalAmountToBigInt,
    toBigIntSafe,
  } from './swap-formatting';
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
  import './SwapPanel.css';

  export let replica: EntityReplica | null;
  export let tab: Tab;
  export let env: Env | EnvSnapshot;
  export let isLive: boolean;

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
  const AGGREGATED_ORDERBOOK_DEPTH = 10;
  const SELECTED_ORDERBOOK_DEPTH = 10;
  const ORDERBOOK_PRICE_SCALE = 10_000n;
  const ORDERBOOK_LOT_SCALE = 10n ** 12n;
  const ORDERBOOK_SNAPSHOT_FRESH_MS = 10_000;
  const ENABLE_MULTIHOP_SWAP_UI = false;
  type PreparedSwapOrderLike = {
    side: 0 | 1;
    priceTicks: bigint;
    effectiveGive: bigint;
    effectiveWant: bigint;
    unspentGiveAmount: bigint;
  };
  const ORDERBOOK_PRICE_DECIMALS = decimalPlacesFromScale(ORDERBOOK_PRICE_SCALE);
  const MAX_PRICE_DEVIATION_BPS = 3000n; // 30%
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
  type OrderbookLevelClickDetail = {
    side: BookSide;
    priceTicks: string;
    size: number;
    accountIds: string[];
    displayPrice?: string;
  };
  type FrameLike = Env | EnvSnapshot | EntityState | null | undefined;
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
  let orderbookBaseJurisdictionLabel = '';
  let orderbookQuoteJurisdictionLabel = '';
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
  let autoExtendCrossInbound = true;
  let crossPriceImprovementMode: 'source_savings' | 'target_bonus' = 'target_bonus';
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
  let crossAutoInboundCreditTarget: bigint | null = null;
  let crossCurrentPeerCreditLimit = 0n;
  let canAutoPrepareCrossInboundCapacity = false;
  let placingSwapOffer = false;
  const MIN_ORDER_NOTIONAL_USD = 10;
  const FILLED_DISPLAY_PPM_THRESHOLD = 999_950n;

    $: activeXlnFunctions = $xlnFunctions;
    $: activeFrame = env;
    $: runtimeEnv = unwrapLiveRuntimeEnv(activeFrame);
    $: activeIsLive = isLive;
    $: sourceEntityOptions = buildSourceEntityOptions(activeFrame, tab.entityId);
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
  const getGossipProfiles = (): GossipProfile[] => {
    if (!activeFrame?.gossip) return [];
    if ('getProfiles' in activeFrame.gossip && typeof activeFrame.gossip.getProfiles === 'function') {
      return activeFrame.gossip.getProfiles();
    }
    return Array.isArray(activeFrame.gossip.profiles) ? activeFrame.gossip.profiles : [];
  };
  function isHubAccount(accountIdValue: string): boolean {
    const normalized = String(accountIdValue || '').trim().toLowerCase();
    if (!normalized) return false;
    const profile = getGossipProfiles().find((entry) => String(entry?.entityId || '').trim().toLowerCase() === normalized);
    return profile?.metadata?.isHub === true;
  }
  function normalizeEntityId(value: string): string {
    return String(value || '').trim().toLowerCase();
  }
  function resolveHubIdCandidate(candidate: string, knownHubIds: string[]): string {
    const normalized = normalizeEntityId(candidate);
    if (!normalized) return '';
    const matchedAccount = knownHubIds.find((id) => normalizeEntityId(id) === normalized);
    if (matchedAccount) return matchedAccount;
    return isHubAccount(normalized) ? normalized : '';
  }
  function firstAvailableHubId(knownHubIds: string[], candidates: string[]): string {
    for (const candidate of candidates) {
      const resolved = resolveHubIdCandidate(candidate, knownHubIds);
      if (resolved) return resolved;
    }
    return knownHubIds[0] || '';
  }
  $: hubAccountIds = accountIds.filter((id) => isHubAccount(id)).slice(0, 10);
  $: hiddenAccountCount = Math.max(0, accountIds.length - hubAccountIds.length);
  $: fallbackHubAccountId = firstAvailableHubId(hubAccountIds, [
    counterpartyId,
  ]);
  $: if (!resolveHubIdCandidate(selectedBookAccountId, hubAccountIds) && fallbackHubAccountId) {
    selectedBookAccountId = fallbackHubAccountId;
  }
  $: if (!resolveHubIdCandidate(createOrderAccountId, hubAccountIds) && fallbackHubAccountId) {
    createOrderAccountId = fallbackHubAccountId;
  }
  $: if (orderbookScopeMode === 'selected' && selectedBookAccountId) {
    createOrderAccountId = selectedBookAccountId;
  }
  $: currentHubSelection = orderbookScopeMode === 'aggregated'
    ? (resolveHubIdCandidate(createOrderAccountId, hubAccountIds) || fallbackHubAccountId)
    : (resolveHubIdCandidate(selectedBookAccountId, hubAccountIds) || resolveHubIdCandidate(createOrderAccountId, hubAccountIds) || fallbackHubAccountId);
  $: activeOrderAccountId = orderbookScopeMode === 'aggregated'
    ? (resolveHubIdCandidate(createOrderAccountId, hubAccountIds) || fallbackHubAccountId)
    : (resolveHubIdCandidate(selectedBookAccountId, hubAccountIds) || resolveHubIdCandidate(createOrderAccountId, hubAccountIds) || fallbackHubAccountId);
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
      giveToken,
      sourceHubId,
      selectedCrossTarget.targetJurisdictionRef,
      wantToken,
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
    const resolved = resolveEntityName(accountIdValue, activeFrame);
    return resolved || formatEntityId(accountIdValue);
  }

  function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function stripJurisdictionSuffix(name: string, jurisdiction: string): string {
    const cleanName = String(name || '').trim();
    const cleanJurisdiction = normalizeJurisdictionDisplayName(jurisdiction);
    if (!cleanName || !cleanJurisdiction) return cleanName;
    return cleanName
      .replace(new RegExp(`\\s*\\(${escapeRegExp(cleanJurisdiction)}\\)\\s*$`, 'i'), '')
      .replace(new RegExp(`\\s+${escapeRegExp(cleanJurisdiction)}\\s*$`, 'i'), '')
      .trim() || cleanName;
  }

  function formatEntityNetworkLabel(name: string, jurisdiction: string): string {
    const cleanName = stripJurisdictionSuffix(String(name || '').trim() || 'Unknown', jurisdiction);
    const cleanJurisdiction = normalizeJurisdictionDisplayName(jurisdiction);
    return cleanJurisdiction ? `${cleanName} (${cleanJurisdiction})` : cleanName;
  }

  function normalizeJurisdictionDisplayName(value: unknown): string {
    const name = String(value || '').trim();
    const normalized = name.toLowerCase();
    if (
      normalized === 'arrakis'
      || normalized === 'arrakis (shared anvil)'
      || normalized === 'shared anvil'
      || normalized === 'wakanda'
    ) {
      return 'Testnet';
    }
    return name;
  }

  function parseCrossAssetKey(value: string): { jurisdictionRef: string; tokenId: number } | null {
    const match = String(value || '').trim().match(/^(.+):(\d+)$/);
    if (!match) return null;
    const tokenIdValue = Number(match[2]);
    if (!Number.isFinite(tokenIdValue) || tokenIdValue <= 0) return null;
    return {
      jurisdictionRef: String(match[1] || '').trim(),
      tokenId: Math.floor(tokenIdValue),
    };
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

  function tokenNetworkLabel(tokenIdValue: number, jurisdiction: string): string {
    const cleanJurisdiction = normalizeJurisdictionDisplayName(jurisdiction);
    return cleanJurisdiction ? `${tokenSymbol(tokenIdValue)} (${cleanJurisdiction})` : tokenSymbol(tokenIdValue);
  }

  function entityAvatarSrc(entityIdValue: string): string {
    const normalized = String(entityIdValue || '').trim();
    if (!normalized || !activeXlnFunctions?.isReady) return '';
    return activeXlnFunctions.generateEntityAvatar?.(normalized) || '';
  }

  function entityInitials(entityIdValue: string, fallbackLabel = ''): string {
    const label = String(fallbackLabel || '').trim();
    if (label) return label.slice(0, 2).toUpperCase();
    return formatEntityId(entityIdValue).slice(0, 2).toUpperCase();
  }

  function jurisdictionBadgeText(jurisdiction: string): string {
    const clean = normalizeJurisdictionDisplayName(jurisdiction).replace(/[^a-zA-Z0-9\s._-]/g, ' ');
    if (!clean) return 'J';
    const words = clean.split(/[\s._-]+/).map((word) => word.replace(/[^a-zA-Z0-9]/g, '')).filter(Boolean);
    if (words.length >= 2) return `${words[0]?.[0] || ''}${words[1]?.[0] || ''}`.toUpperCase();
    return (words[0] || clean).slice(0, 2).toUpperCase();
  }

  function hubJurisdictionLabel(entityIdValue: string): string {
    const profileJurisdiction = getProfileJurisdictionName(getHubProfile(entityIdValue));
    return profileJurisdiction || sourceJurisdictionLabel;
  }
  $: selectedHubOptions = hubAccountIds.map((id) => ({ value: id, label: accountLabel(id) }));
  $: selectedHubOption = selectedHubOptions.find((hub) => hub.value === (createOrderAccountId || activeOrderAccountId)) || null;
  $: crossTargetOptions = buildCrossTargetOptions(activeFrame, sourceEntityIdValue, currentReplica);
  $: routeOptions = buildRouteOptions(sourceEntityIdValue, currentReplica, activeOrderAccountId, crossTargetOptions);
  $: visibleRouteOptions = selectedRouteOptionOverride
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
    || (selectedRouteOptionOverride?.value === liveSelectedRouteValue ? selectedRouteOptionOverride : null)
    || visibleRouteOptions[0]
    || null;
  $: swapRouteMode = selectedRouteOption?.mode === 'cross' ? 'cross' : 'same';
  $: selectedCrossTargetValue = swapRouteMode === 'cross' && selectedRouteOption ? selectedRouteOption.value : '';
  $: selectedCrossTarget = crossTargetOptions.find((option) => option.value === selectedCrossTargetValue)
    || (selectedCrossTargetOverride?.value === selectedCrossTargetValue ? selectedCrossTargetOverride : null)
    || null;
  $: routedRouteRecommendations = !ENABLE_MULTIHOP_SWAP_UI
    ? buildRoutedRouteCandidates(
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
        .slice(0, 3)
    : [];
  $: showManualRouteRecommendation = (
    swapRouteMode === 'cross'
    && !ENABLE_MULTIHOP_SWAP_UI
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
    ? `${tokenNetworkLabel(giveToken, sourceJurisdictionLabel)} -> ${tokenNetworkLabel(wantToken, targetJurisdictionLabel)}`
    : `${giveTokenSymbol} -> ${wantTokenSymbol}`;
  $: swapTokenPairLabel = `${giveTokenSymbol} -> ${wantTokenSymbol}`;
  $: targetAccountReady = swapRouteMode !== 'cross' || Boolean(selectedCrossTarget && hasReplicaAccount(
    findReplicaByEntityId(selectedCrossTarget.targetEntityId),
    selectedCrossTarget.targetHubEntityId,
  ));
  $: canCreateTargetAccount = Boolean(
    swapRouteMode === 'cross'
    && selectedCrossTarget
    && selectedCrossTarget.targetHubEntityId
    && !targetAccountReady
    && activeIsLive
  );
  $: orderbookSourceLabels = Object.fromEntries(
    orderbookHubIds.map((id) => [id, accountLabel(id)]),
  );
  $: orderbookSourceAvatars = Object.fromEntries(
    orderbookHubIds.map((id) => [id, activeXlnFunctions?.isReady ? (activeXlnFunctions.generateEntityAvatar?.(id) || '') : '']),
  );

  type TokenKeyedMap<V> = Map<number, V> | Map<string, V>;
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
    baseKey: string;
    quoteKey: string;
  };

  function getTokenMapValue<V>(map: TokenKeyedMap<V> | undefined, tokenIdValue: number): V | undefined {
    if (!(map instanceof Map) || !Number.isFinite(tokenIdValue)) return undefined;
    const byNumber = (map as Map<number, V>).get(tokenIdValue);
    if (byNumber !== undefined) return byNumber;
    return (map as Map<string, V>).get(String(tokenIdValue));
  }

  function nonNegative(value: bigint): bigint {
    return value < 0n ? 0n : value;
  }

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

  function localEntityReplicas(frame: FrameLike = activeFrame): EntityReplica[] {
    if (!frame || !('eReplicas' in frame) || !(frame.eReplicas instanceof Map)) return [];
    const seen = new Set<string>();
    const out: EntityReplica[] = [];
    for (const [key, candidate] of frame.eReplicas.entries()) {
      if (!candidate?.state) continue;
      const entityId = String(candidate.entityId || key.split(':')[0] || candidate.state.entityId || '').trim().toLowerCase();
      if (!entityId || seen.has(entityId)) continue;
      seen.add(entityId);
      out.push(candidate);
    }
    return out;
  }

  function buildSourceEntityOptions(
    frame: FrameLike = activeFrame,
    currentEntityId = String(tab.entityId || '').trim().toLowerCase(),
  ): SourceEntityOption[] {
    const options = localEntityReplicas(frame)
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
    const normalized = String(entityIdValue || '').trim().toLowerCase();
    if (!normalized) return null;
    return getGossipProfiles().find((profile) =>
      profile?.metadata?.isHub === true
      && String(profile?.entityId || '').trim().toLowerCase() === normalized
    ) || null;
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
    const profiles = getGossipProfiles()
      .filter((profile) => profile?.metadata?.isHub === true)
      .filter((profile) => getProfileJurisdictionName(profile).toLowerCase() === normalized);
    return profiles.sort((a, b) => compareStableText(String(a.name || a.entityId), String(b.name || b.entityId)))[0] || null;
  }

  function buildCrossTargetOptions(
    frame: FrameLike = activeFrame,
    sourceEntityId = sourceEntityIdValue,
    sourceReplica: EntityReplica | null | undefined = currentReplica,
  ): CrossTargetOption[] {
    const sourceJurisdiction = getReplicaJurisdictionName(sourceReplica);
    const sourceJurisdictionRef = getReplicaJurisdictionRef(sourceReplica);
    if (!sourceEntityId || !sourceJurisdiction || !sourceJurisdictionRef) return [];
    const options: CrossTargetOption[] = [];
    for (const candidate of localEntityReplicas(frame)) {
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
      const targetHubIds = accountHubIds.length > 0 ? accountHubIds : (fallbackHub ? [fallbackHub] : []);
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

  function setSwapTokens(nextGiveToken: number, nextWantToken: number): void {
    if (!Number.isFinite(nextGiveToken) || !Number.isFinite(nextWantToken)) return;
    if (nextGiveToken <= 0 || nextWantToken <= 0) {
      giveTokenId = String(nextGiveToken || '');
      wantTokenId = String(nextWantToken || '');
      selectedOrderLevel = null;
      submitError = '';
      return;
    }
    if (nextGiveToken === nextWantToken && liveSelectedRouteValue === 'same') {
      const fallbackWantToken = fallbackCounterToken(nextGiveToken);
      if (!fallbackWantToken || fallbackWantToken === nextGiveToken) {
        submitError = 'Sell token and Buy token must be different.';
        return;
      }
      nextWantToken = fallbackWantToken;
    }
    const oriented = resolvePairOrientation(nextGiveToken, nextWantToken);
    tradeSide = nextGiveToken === oriented.baseTokenId ? 'sell-base' : 'buy-base';
    giveTokenId = String(nextGiveToken);
    wantTokenId = String(nextWantToken);
    selectedOrderLevel = null;
    submitError = '';
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
    const currentPriceTicks = selectedOrderLevel?.inputPriceTicks && selectedOrderLevel.inputPriceTicks > 0n
      ? selectedOrderLevel.inputPriceTicks
      : (selectedOrderLevel?.priceTicks && selectedOrderLevel.priceTicks > 0n ? selectedOrderLevel.priceTicks : limitPriceTicks);
    const nextPriceInput = currentPriceTicks && currentPriceTicks > 0n ? formatPriceTicks(currentPriceTicks) : priceRatioInput;
    preservePriceOnNextContextChange = true;
    setSwapTokens(nextGiveToken, nextWantToken);
    if (nextPriceInput) {
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
  function syncOrderAmountInputFromContainer(node: HTMLElement): void {
    const input = node.closest('.swap-panel')?.querySelector<HTMLInputElement>('[data-testid="swap-order-amount"]') || null;
    if (!input) return;
    const previousValue = String(node.dataset['orderAmountActionValue'] || '');
    const ticks = Number(node.dataset['orderAmountActionTicks'] || 0) + 1;
    node.dataset['orderAmountActionTicks'] = String(ticks);
    node.dataset['orderAmountActionValue'] = input.value;
    if (previousValue !== input.value) {
      node.dispatchEvent(new Event('input', { bubbles: true }));
    }
    routedOrderAmountInput.set(input.value);
    setOrderAmountInputValue(input.value);
  }
  function handleSwapPanelAmountSync(event: Event): void {
    const panel = event.currentTarget as HTMLElement | null;
    const input = panel?.querySelector<HTMLInputElement>('[data-testid="swap-order-amount"]') || null;
    if (!input) return;
    setOrderAmountInputValue(input.value);
  }
  function syncOrderAmountContainerAction(node: HTMLElement): { update: () => void; destroy: () => void } {
    const sync = () => syncOrderAmountInputFromContainer(node);
    sync();
    window.addEventListener('input', sync, true);
    window.addEventListener('change', sync, true);
    window.addEventListener('keyup', sync, true);
    const interval = window.setInterval(sync, 100);
    return {
      update: sync,
      destroy() {
        window.removeEventListener('input', sync, true);
        window.removeEventListener('change', sync, true);
        window.removeEventListener('keyup', sync, true);
        window.clearInterval(interval);
      },
    };
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

  function syncRouteSelectDomValue(): void {
    const node = routeSelectElement;
    if (!node) return;
    node.dataset['routeDomSyncTicks'] = String(Number(node.dataset['routeDomSyncTicks'] || 0) + 1);
    const nextValue = String(node.value || '');
    if (!nextValue || nextValue === liveSelectedRouteValue) return;
    node.dataset['routeDomSyncValue'] = nextValue;
    const selection = buildCommittedRouteSelectionFromDom(node, nextValue);
    if (!selection) return;
    dispatchRouteCommit(node, selection.route.value);
  }

  function syncRouteSelectAction(node: HTMLSelectElement): { update: () => void; destroy: () => void } {
    let lastDispatchedValue = '';
    const sync = () => {
      node.dataset['routeActionTicks'] = String(Number(node.dataset['routeActionTicks'] || 0) + 1);
      const nextValue = String(node.value || '');
      if (nextValue && nextValue !== liveSelectedRouteValue) {
        node.dataset['routeSyncValue'] = nextValue;
        const selection = buildCommittedRouteSelectionFromDom(node, nextValue);
        node.dataset['routeSyncKnown'] = selection ? 'true' : 'false';
        node.dataset['routeSyncDisabled'] = selection?.route.disabled ? 'true' : 'false';
        if (selection && selection.route.value !== lastDispatchedValue) {
          lastDispatchedValue = selection.route.value;
          dispatchRouteCommit(node, selection.route.value);
          node.dataset['routeCommitNonce'] = String(Number(node.dataset['routeCommitNonce'] || 0) + 1);
        }
      }
    };
    sync();
    node.addEventListener('change', sync);
    node.addEventListener('input', sync);
    const interval = window.setInterval(sync, 100);
    return {
      update: sync,
      destroy() {
        node.removeEventListener('change', sync);
        node.removeEventListener('input', sync);
        window.clearInterval(interval);
      },
    };
  }

  onMount(() => {
    const interval = window.setInterval(syncRouteSelectDomValue, 100);
    return () => window.clearInterval(interval);
  });

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

  function lotsToBaseWei(sizeLots: number): bigint {
    const lots = Math.max(0, Math.floor(Number(sizeLots) || 0));
    return BigInt(lots) * ORDERBOOK_LOT_SCALE;
  }

  function tokenSymbol(tokenIdValue: number): string {
    if (!Number.isFinite(tokenIdValue) || tokenIdValue <= 0) return 'Token';
    const info = activeXlnFunctions?.getTokenInfo?.(tokenIdValue);
    return String(info?.symbol || `Token #${tokenIdValue}`).trim();
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

  function findReplicaByEntityId(entityId: string, frame: FrameLike = activeFrame): EntityReplica | null {
    const normalized = String(entityId || '').trim().toLowerCase();
    if (!normalized) return null;
    return localEntityReplicas(frame).find((candidate) =>
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

  function withCrossTargetInboundBuffer(amount: bigint): bigint {
    if (amount <= 0n) return amount;
    return amount + ((amount + 99n) / 100n);
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

  $: giveTokenSymbol = tokenSymbol(giveToken);
  $: wantTokenSymbol = tokenSymbol(wantToken);
  $: {
    currentReplica;
    wantTokenPresentInAccount = hasTokenInAccount(activeOrderAccountId, wantToken);
    availableGiveCapacity = readOutCapacity(activeOrderAccountId, giveToken);
    availableWantInCapacity = readInCapacity(activeOrderAccountId, wantToken);
    autoInboundCreditTarget = computeAutoInboundCreditTarget(activeOrderAccountId, wantToken, canonicalWantAmount);
    currentPeerCreditLimit = readPeerCreditLimit(activeOrderAccountId, wantToken);
  }
  $: {
    const targetReplica = selectedCrossTarget ? findReplicaByEntityId(selectedCrossTarget.targetEntityId) : null;
    crossTargetInCapacity = selectedCrossTarget
      ? readInCapacityForReplica(targetReplica, selectedCrossTarget.targetEntityId, selectedCrossTarget.targetHubEntityId, wantToken)
      : 0n;
    const desiredCrossInboundAmount = crossPriceImprovementMode === 'target_bonus'
      ? withCrossTargetInboundBuffer(canonicalWantAmount)
      : canonicalWantAmount;
    crossAutoInboundCreditTarget = selectedCrossTarget
      ? computeAutoInboundCreditTargetForReplica(
          targetReplica,
          selectedCrossTarget.targetEntityId,
          selectedCrossTarget.targetHubEntityId,
          wantToken,
          desiredCrossInboundAmount,
        )
      : null;
    crossCurrentPeerCreditLimit = selectedCrossTarget
      ? readPeerCreditLimitForReplica(targetReplica, selectedCrossTarget.targetEntityId, selectedCrossTarget.targetHubEntityId, wantToken)
      : 0n;
    canAutoPrepareCrossInboundCapacity = Boolean(
      swapRouteMode === 'cross'
      && selectedCrossTarget
      && crossAutoInboundCreditTarget !== null
      && crossAutoInboundCreditTarget > crossCurrentPeerCreditLimit,
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

  type SwapFormValidationInput = {
    isLive: boolean;
    entityId: string;
    counterpartyId: string;
    accountIds: string[];
    giveToken: number;
    wantToken: number;
    giveAmount: bigint;
    limitPriceTicks: bigint | null;
    wantAmount: bigint;
    wantTokenPresentInAccount: boolean;
    availableGiveCapacity: bigint;
    availableWantInCapacity: bigint;
    formattedAvailableGive: string;
    formattedAvailableWantIn: string;
    notionalUsd: number;
    referencePriceTicks: bigint | null;
  };

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
    if (!(activeFrame?.eReplicas instanceof Map) || !hubEntityId) return null;
    const normalizedHubId = String(hubEntityId).trim().toLowerCase();
    if (!normalizedHubId) return null;
    const normalizedPairId = String(pairIdValue || '').trim();
    if (!normalizedPairId) return null;
    for (const [key, replica] of activeFrame.eReplicas.entries()) {
      const entityId = String(key || '').split(':')[0]?.trim().toLowerCase();
      if (entityId !== normalizedHubId) continue;
      return replica?.state?.orderbookExt?.books?.get?.(normalizedPairId) || null;
    }
    return null;
  }

  function computePriceDeviationBps(limitTicks: bigint, referenceTicks: bigint): bigint {
    if (limitTicks <= 0n || referenceTicks <= 0n) return 0n;
    const delta = limitTicks > referenceTicks ? limitTicks - referenceTicks : referenceTicks - limitTicks;
    return (delta * 10_000n) / referenceTicks;
  }

  function validateSwapForm(input: SwapFormValidationInput): string {
    if (!input.isLive) return 'Switch to LIVE mode to place swap orders.';
    if (!input.entityId) return 'Entity is not selected.';
    if (!input.counterpartyId) return 'Select account (hub) first.';
    const hasCounterparty = input.accountIds.some(
      (id) => String(id || '').toLowerCase() === String(input.counterpartyId || '').toLowerCase(),
    );
    if (!hasCounterparty) return 'Selected account is not active.';
    if (!Number.isFinite(input.giveToken) || !Number.isFinite(input.wantToken) || input.giveToken <= 0 || input.wantToken <= 0) {
      return 'Select valid Sell and Buy tokens.';
    }
    if (input.giveToken === input.wantToken) return 'Sell token and Buy token must be different.';
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
    if (!input.wantTokenPresentInAccount) {
      return 'Inbound token is not active in this account. Add token capacity first.';
    }
    if (input.giveAmount > input.availableGiveCapacity) {
      return `Insufficient outbound capacity (${input.formattedAvailableGive}).`;
    }
    if (input.wantAmount > input.availableWantInCapacity) {
      return `Insufficient inbound capacity (${input.formattedAvailableWantIn}).`;
    }
    return '';
  }

  function validateCrossSwapForm(
    input: SwapFormValidationInput,
    target: CrossTargetOption | null,
    allowAutoPrepareTargetInbound: boolean,
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
      return 'Target entity must already have an account with the hub.';
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
          autoExtendCrossInbound && canAutoPrepareCrossInboundCapacity,
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
  $: crossAutoCapacityNote = (() => {
    if (swapRouteMode !== 'cross' || !selectedCrossTarget || !canAutoPrepareCrossInboundCapacity) return '';
    const targetLabel = formatAmount(crossAutoInboundCreditTarget ?? 0n, wantToken);
    const increase = (crossAutoInboundCreditTarget ?? 0n) > crossCurrentPeerCreditLimit
      ? (crossAutoInboundCreditTarget ?? 0n) - crossCurrentPeerCreditLimit
      : 0n;
    const increaseLabel = formatAmount(increase, wantToken);
    return `Auto: extend target inbound to ${targetLabel} ${wantTokenSymbol} on ${selectedCrossTarget.targetJurisdiction} (+${increaseLabel}).`;
  })();
  $: showCrossAutoCapacityNote = Boolean(crossAutoCapacityNote && autoExtendCrossInbound && !hasSourceCapacityShortfall);
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
    const requantized = requantizeAtLimitPrice(rawGive, explicitPriceTicks);
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

  async function prepareSelectedTargetAccount(): Promise<void> {
    submitError = '';
    try {
      const env = runtimeEnv;
      if (!env) throw new Error('XLN environment not ready');
      if (!activeIsLive) throw new Error('Target account setup requires LIVE mode');
      const target = selectedCrossTarget;
      if (!target) throw new Error('Select target network first');
      if (!target.targetHubEntityId) throw new Error('No hub is available for target network');
      const targetReplica = findReplicaByEntityId(target.targetEntityId);
      if (!targetReplica) throw new Error('Target sibling entity is not available in this runtime');
      const targetSignerId = String(target.targetSignerId || targetReplica.signerId || '').trim().toLowerCase();
      if (!targetSignerId) throw new Error('Target signer is not available');
      const desiredCredit = crossAutoInboundCreditTarget && crossAutoInboundCreditTarget > 0n
        ? crossAutoInboundCreditTarget
        : defaultCreditLimitForToken(wantToken);
      await prewarmCounterpartyProfiles(env, [target.targetHubEntityId]);
      await enqueueEntityInputs(env, [{
        entityId: target.targetEntityId,
        signerId: targetSignerId,
        entityTxs: [{
          type: 'openAccount' as const,
          data: {
            targetEntityId: target.targetHubEntityId,
            tokenId: wantToken,
            creditAmount: desiredCredit,
          },
        }],
      }]);
      toasts.success(`Target account setup queued on ${target.targetJurisdiction}`);
    } catch (error) {
      const message = (error as Error)?.message || 'Unknown error';
      submitError = `Target account setup failed: ${message}`;
      toasts.error(submitError);
    }
  }

  function handleOrderbookLevelClick(event: CustomEvent<OrderbookLevelClickDetail>) {
    submitError = '';
    const pair = parsedOrderbookPair;
    if (!pair) {
      submitError = 'Select valid swap route first.';
      return;
    }

    const side = event.detail?.side;
    const rawSize = Number(event.detail?.size || 0);
    const parsedPriceTicks = toBigIntSafe(event.detail?.priceTicks);
    if (
      (side !== 'ask' && side !== 'bid')
      || parsedPriceTicks === null
      || parsedPriceTicks <= 0n
      || !Number.isFinite(rawSize)
      || rawSize <= 0
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
    if (swapRouteMode !== 'cross') {
      setSwapTokens(nextGiveToken, nextWantToken);
    }

    const priceTicks = parsedPriceTicks;
    const sizeBaseWei = lotsToBaseWei(rawSize);
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
    if (runtimeEnv && activeXlnFunctions?.resolveEntityProposerId) {
      const proposerId = activeXlnFunctions.resolveEntityProposerId(runtimeEnv, entityId, 'swap-panel');
      if (proposerId) return proposerId;
    }
    return requireSignerIdForEntity(runtimeEnv, entityId, 'swap-panel');
  }

  function getTokenDecimals(tokenIdValue: number): number {
    const info = activeXlnFunctions?.getTokenInfo?.(tokenIdValue);
    const decimals = Number(info?.decimals);
    return Number.isFinite(decimals) && decimals > 0 ? Math.floor(decimals) : 18;
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
        const requantized = requantizeAtLimitPrice(rawGiveAmount, explicitPriceTicks);
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
    return deriveCanonicalCrossJurisdictionMarketForLegs(
      getReplicaJurisdictionRef(currentReplica),
      giveToken,
      selectedCrossTarget.targetJurisdictionRef,
      wantToken,
    ) as CrossMarketView;
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
  $: orderbookBaseJurisdictionLabel = swapRouteMode === 'cross' && activeCrossMarket
    ? jurisdictionLabelForAssetKey(activeCrossMarket.baseKey)
    : sourceJurisdictionLabel;
  $: orderbookQuoteJurisdictionLabel = swapRouteMode === 'cross' && activeCrossMarket
    ? jurisdictionLabelForAssetKey(activeCrossMarket.quoteKey)
    : sourceJurisdictionLabel;
  $: orderbookPairDisplayLabel = `${tokenNetworkLabel(baseTokenId, orderbookBaseJurisdictionLabel)}/${tokenNetworkLabel(quoteTokenId, orderbookQuoteJurisdictionLabel)}`;
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
        toasts.success(`Swap fully filled${improvementNote}${feeNote}`);
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
    placingSwapOffer = true;
    submitError = '';
    try {
      const env = runtimeEnv;
      if (!env) throw new Error('XLN environment not ready');
      if (!activeIsLive) throw new Error('Swap actions are only available in LIVE mode');
      const sourceEntityId = sourceEntityIdValue;
      const signerId = sourceSignerIdValue || resolveSignerId(sourceEntityId);
      if (!signerId) throw new Error('No signer available for selected entity');
      if (!sourceEntityId) throw new Error('No source entity selected');

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
        ? requantizeAtLimitPrice(giveAmount, selectedOrderLevel.inputPriceTicks || selectedOrderLevel.priceTicks)
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
      ? validateCrossSwapForm(liveValidation, selectedCrossTarget, autoExtendCrossInbound && canAutoPrepareCrossInboundCapacity)
        : validateSwapForm(liveValidation);
      if (
        liveValidationReason
        && !(swapRouteMode === 'same' && isInboundCapacityValidationError(liveValidationReason) && canAutoPrepareInboundCapacity)
      ) {
        throw new Error(liveValidationReason);
      }

      const logicalNow = readLogicalNumber(currentReplica?.state?.timestamp || env.timestamp);
      const logicalHeight = readLogicalNumber(currentReplica?.state?.height || env.height);
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
      const requiredTargetInboundAmount = crossPriceImprovementMode === 'target_bonus'
        ? withCrossTargetInboundBuffer(effectiveWantAmount)
        : effectiveWantAmount;
      const requiredTargetInboundCreditLimit = targetRoute
        ? computeAutoInboundCreditTargetForReplica(
            targetReplica,
            targetRoute.targetEntityId,
            targetRoute.targetHubEntityId,
            wantToken,
            requiredTargetInboundAmount,
          )
        : null;
      const currentTargetInboundCreditLimit = targetRoute
        ? readPeerCreditLimitForReplica(targetReplica, targetRoute.targetEntityId, targetRoute.targetHubEntityId, wantToken)
        : 0n;
      const shouldAutoPrepareCrossInbound = Boolean(
        swapRouteMode === 'cross'
        && autoExtendCrossInbound
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
          giveToken,
          resolvedCounterparty,
          targetRoute.targetJurisdictionRef,
          wantToken,
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
          priceImprovementMode: crossPriceImprovementMode,
          status: 'intent',
          createdAt: now,
          updatedAt: now,
          expiresAt: now + 24 * 60 * 60 * 1000,
        } satisfies CrossJurisdictionSwapRoute;
      })();
      const entityTxs = [];
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
        const inputs: RoutedEntityInput[] = [];
        const targetEntityTxs = [];
        if (shouldAutoPrepareCrossInbound && requiredTargetInboundCreditLimit !== null) {
          targetEntityTxs.push({
            type: 'extendCredit' as const,
            data: {
              counterpartyEntityId: targetRoute.targetHubEntityId,
              tokenId: wantToken,
              amount: requiredTargetInboundCreditLimit,
            },
          });
        }
        if (targetEntityTxs.length > 0) {
          inputs.push({
            entityId: targetRoute.targetEntityId,
            signerId: targetRoute.targetSignerId,
            entityTxs: targetEntityTxs,
          });
        }
        inputs.push({
          entityId: sourceEntityId,
          signerId,
          entityTxs: [{
            type: 'requestCrossJurisdictionSwap' as const,
            data: { route: crossJurisdiction },
          }],
        });
        await enqueueEntityInputs(env, inputs);
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
        await enqueueEntityInputs(env, [{
          entityId: sourceEntityId,
          signerId,
          entityTxs,
        }]);
      }

      orderbookRefreshNonce += 1;
      pendingSwapFeedbackOfferId = offerId;
      toasts.success(crossJurisdiction ? 'Cross-j swap preparation submitted' : 'Swap offer submitted');

      // Reset form
      orderPercent = 100;
      selectedOrderLevel = null;
      setOrderAmountInputValue('');
      priceRatioInput = '';
    } catch (error) {
      console.error('Failed to place swap offer:', error);
      submitError = `Failed to place swap: ${(error as Error)?.message || 'Unknown error'}`;
    } finally {
      placingSwapOffer = false;
    }
  }

  async function cancelSwapOffer(offerId: string, accountId: string) {
    const sourceEntityId = sourceEntityIdValue;
    if (!sourceEntityId) return;

    try {
      const env = runtimeEnv;
      if (!env) throw new Error('XLN environment not ready');
      if (!activeIsLive) throw new Error('Swap actions are only available in LIVE mode');
      const signerId = sourceSignerIdValue || resolveSignerId(sourceEntityId);
      if (!signerId) throw new Error('No signer available for selected entity');

      await enqueueEntityInputs(env, [{
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
      console.error('Failed to cancel swap:', error);
      const message = (error as Error)?.message || 'Unknown error';
      submitError = `Failed to cancel: ${message}`;
      toasts.error(`Cancel failed: ${message}`);
    }
  }

  async function requestCrossClear(offerId: string, cancelRemainder = false) {
    const sourceEntityId = sourceEntityIdValue;
    if (!sourceEntityId) return;

    try {
      const env = runtimeEnv;
      if (!env) throw new Error('XLN environment not ready');
      if (!activeIsLive) throw new Error('Swap actions are only available in LIVE mode');
      const signerId = sourceSignerIdValue || resolveSignerId(sourceEntityId);
      if (!signerId) throw new Error('No signer available for selected entity');

      await enqueueEntityInputs(env, [{
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
      console.error('Failed to clear cross-j swap:', error);
      const message = (error as Error)?.message || 'Unknown error';
      submitError = `Failed to clear cross-j swap: ${message}`;
      toasts.error(`Clear failed: ${message}`);
    }
  }

  // Format BigInt for display
  function formatAmount(amount: bigint, tokenIdValue: number): string {
    const decimals = BigInt(getTokenDecimals(tokenIdValue));
    const ONE = 10n ** decimals;
    const whole = amount / ONE;
    const frac = amount % ONE;
    if (frac === 0n) return whole.toString();
    return `${whole}.${frac.toString().padStart(Number(decimals), '0').replace(/0+$/, '')}`;
  }

  function formatAmountForInput(amount: bigint, tokenIdValue: number): string {
    const full = formatAmount(amount, tokenIdValue);
    const dotIndex = full.indexOf('.');
    if (dotIndex < 0) return full;
    const maxDecimals = Math.min(6, Math.max(0, getTokenDecimals(tokenIdValue)));
    if (maxDecimals <= 0) return full.slice(0, dotIndex);
    const whole = full.slice(0, dotIndex);
    const frac = full.slice(dotIndex + 1, dotIndex + 1 + maxDecimals).replace(/0+$/, '');
    return frac.length > 0 ? `${whole}.${frac}` : whole;
  }

  function requantizeAtLimitPrice(remainingGiveAmount: bigint, priceTicks: bigint): PreparedSwapOrderLike | null {
    if (remainingGiveAmount <= 0n || priceTicks <= 0n) return null;
    const activeMode = orderMode !== 'none' ? orderMode : tradeSide;
    const side = activeMode === 'sell-base' ? 1 : 0;
    if (side === 1) {
      const quantizedBaseAmount = (remainingGiveAmount / ORDERBOOK_LOT_SCALE) * ORDERBOOK_LOT_SCALE;
      if (quantizedBaseAmount <= 0n) return null;
      const quantizedQuoteAmount = (quantizedBaseAmount * priceTicks) / ORDERBOOK_PRICE_SCALE;
      if (quantizedQuoteAmount <= 0n) return null;
      return {
        side,
        priceTicks,
        effectiveGive: quantizedBaseAmount,
        effectiveWant: quantizedQuoteAmount,
        unspentGiveAmount: remainingGiveAmount - quantizedBaseAmount,
      };
    }
    const quantizedBaseAmount = ((remainingGiveAmount * ORDERBOOK_PRICE_SCALE) / priceTicks / ORDERBOOK_LOT_SCALE) * ORDERBOOK_LOT_SCALE;
    if (quantizedBaseAmount <= 0n) return null;
    const quantizedQuoteAmount = (quantizedBaseAmount * priceTicks) / ORDERBOOK_PRICE_SCALE;
    if (quantizedQuoteAmount <= 0n) return null;
    return {
      side,
      priceTicks,
      effectiveGive: quantizedQuoteAmount,
      effectiveWant: quantizedBaseAmount,
      unspentGiveAmount: remainingGiveAmount > quantizedQuoteAmount ? remainingGiveAmount - quantizedQuoteAmount : 0n,
    };
  }

  function parseDisplayPriceTicks(displayPrice: string, fallbackPriceTicks: bigint): bigint {
    const normalized = normalizeDisplayPriceForInput(displayPrice);
    const ticks = parseDecimalAmountToBigInt(normalized, ORDERBOOK_PRICE_DECIMALS);
    if (ticks <= 0n) return fallbackPriceTicks;
    return ticks > 0n ? ticks : fallbackPriceTicks;
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
              bind:value={orderAmountInput}
              bind:this={orderAmountInputElement}
              inputmode="decimal"
              placeholder="0"
              data-testid="swap-order-amount"
              aria-label="Swap from amount"
              on:input={handleOrderAmountInput}
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
                <span class="token-select-visible" data-testid="swap-from-token-label">{giveTokenSymbol}</span>
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
                  <option value={String(token.tokenId)}>{token.symbol}</option>
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
                      <span>{token.symbol}</span>
                    </button>
                  {/each}
                </div>
              {/if}
            </div>
          </div>
          <div class="leg-meta">
            <span>{sourceAssetLabel}</span>
            <strong title={`Available ${formattedAvailableGive}`}>{formattedAvailableGiveAmount}</strong>
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
                <span class="token-select-visible" data-testid="swap-to-token-label">{wantTokenSymbol}</span>
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
                  <option value={String(token.tokenId)}>{token.symbol}</option>
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
                      <span>{token.symbol}</span>
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

      <div class="quote-row">
        <span class="input-label">Limit rate</span>
        <input
          type="text"
          bind:value={priceRatioInput}
          inputmode="decimal"
          data-testid="swap-order-price"
          aria-label="Swap limit rate"
          on:input={handlePriceRatioInput}
        />
        <span class="input-suffix">{quoteTokenSymbol}</span>
        <div class="input-steppers">
          <button type="button" class="step-btn" on:click={() => stepPrice(1)}>▲</button>
          <button type="button" class="step-btn" on:click={() => stepPrice(-1)}>▼</button>
        </div>
      </div>

      <div class="market-strip">
        <button
          type="button"
          class="market-price-btn"
          data-testid="swap-use-market-price"
          disabled={!marketPriceTicks || marketPriceTicks <= 0n}
          on:click={useMarketPrice}
        >
          <span>{marketPriceSideLabel}</span>
          <strong>{marketPriceLabel}</strong>
        </button>
        <span class="book-owner-label" title={bookVenueLabel}>{bookVenueLabel}</span>
      </div>

      <div class="venue-row">
        <span>Hub</span>
        <div class="entity-select-wrap hub-select-wrap" data-swap-menu-root>
          <button
            type="button"
            class="entity-select-button"
            aria-haspopup="listbox"
            aria-expanded={hubMenuOpen}
            title={selectedHubDisplayLabel}
            on:click|stopPropagation={toggleHubMenu}
          >
            <span class="entity-avatar-wrap">
              {#if createOrderAccountId && entityAvatarSrc(createOrderAccountId)}
                <img class="entity-avatar-mini" src={entityAvatarSrc(createOrderAccountId)} alt="" />
              {:else}
                <span class="entity-avatar-mini placeholder">{entityInitials(createOrderAccountId, selectedHubLabel)}</span>
              {/if}
              <span class="jurisdiction-mini-badge">{jurisdictionBadgeText(selectedHubJurisdictionLabel)}</span>
            </span>
            <span class="entity-select-copy">
              <strong>{formatEntityNetworkLabel(selectedHubLabel, selectedHubJurisdictionLabel)}</strong>
            </span>
            <span class="entity-select-chevron" aria-hidden="true">⌄</span>
          </button>
          <select
            class="entity-select-native"
	            bind:value={createOrderAccountId}
	            data-testid="swap-account-select"
	            data-active-order-account-id={activeOrderAccountId}
	            title={selectedHubDisplayLabel}
	            aria-label="Swap venue"
	            on:change={(event) => handleSelectedHubChange((event.currentTarget as HTMLSelectElement).value)}
	          >
	            {#each selectedHubOptions as hub (hub.value)}
	              <option
	                value={hub.value}
	                selected={hub.value === activeOrderAccountId}
	                title={formatEntityNetworkLabel(hub.label, hubJurisdictionLabel(hub.value))}
	              >
	                {formatEntityNetworkLabel(hub.label, hubJurisdictionLabel(hub.value))}
	              </option>
	            {/each}
	          </select>
          {#if hubMenuOpen}
            <div class="entity-menu hub-menu" role="listbox" aria-label="Hub">
              {#each selectedHubOptions as hub (hub.value)}
                {@const hubJurisdiction = hubJurisdictionLabel(hub.value)}
                <button
                  type="button"
                  class:selected={hub.value === createOrderAccountId}
                  class="entity-option"
                  role="option"
                  aria-selected={hub.value === createOrderAccountId}
                  title={formatEntityNetworkLabel(hub.label, hubJurisdiction)}
                  on:click|stopPropagation={() => selectHubOption(hub.value)}
                >
                  <span class="entity-avatar-wrap">
                    {#if entityAvatarSrc(hub.value)}
                      <img class="entity-avatar-mini" src={entityAvatarSrc(hub.value)} alt="" />
                    {:else}
                      <span class="entity-avatar-mini placeholder">{entityInitials(hub.value, hub.label)}</span>
                    {/if}
                    <span class="jurisdiction-mini-badge">{jurisdictionBadgeText(hubJurisdiction)}</span>
                  </span>
                  <span class="entity-select-copy">
                    <strong>{formatEntityNetworkLabel(hub.label, hubJurisdiction)}</strong>
                  </span>
                </button>
              {/each}
            </div>
          {/if}
        </div>
      </div>

      <div class="size-slider-row">
        <input
          type="range"
          class="diamond-slider"
          min="0"
          max="100"
          step="1"
          style="--xln-slider-progress: {orderPercent}%"
          value={orderPercent}
          on:input={(e) => applyOrderPercent(Number((e.currentTarget).value))}
        />
        <div class="slider-marks">
          {#each [0, 25, 50, 75, 100] as mark}
            <span
              class="slider-mark-group"
              class:filled={orderPercent >= mark}
              on:click={() => applyOrderPercent(mark)}
              on:keydown={(e) => e.key === 'Enter' && applyOrderPercent(mark)}
              role="button"
              tabindex="0"
            ><span class="slider-diamond">&#9671;</span><span class="slider-pct">{mark}%</span></span>
          {/each}
        </div>
      </div>

      <div
        class="route-builder"
        class:cross-route={swapRouteMode === 'cross'}
        use:syncOrderAmountContainerAction
        data-testid="swap-route-picker"
        data-order-amount-input={liveOrderAmountInput}
        data-order-amount-state={orderAmountInput}
        data-order-amount-dom={latestOrderAmountDomValue}
        data-order-amount-has-dom={hasLatestOrderAmountDomValue ? 'true' : 'false'}
        data-order-amount-revision={orderAmountRevision}
        data-order-amount-dom-revision={orderAmountDomRevision}
        data-order-amount-node={String(orderAmountInputElement?.value ?? '')}
        data-give-token={giveToken}
        data-want-token={wantToken}
        data-give-decimals={giveTokenDecimals}
        data-give-amount={giveAmount.toString()}
        data-canonical-give-amount={canonicalGiveAmount.toString()}
      >
        <button type="button" class="route-summary" title={`${routeSummaryLabel} · ${routePathLabel} · ${routeVenueDisplayLabel}`} on:click={() => routeDetailsOpen = !routeDetailsOpen}>
          <span>Route</span>
          <strong>{routeSummaryLabel}</strong>
          <em>{routeSummaryAssetsLabel}</em>
        </button>
        <div
          class="route-flow"
          data-testid="swap-route-flow"
          data-selected-route-value={liveSelectedRouteValue}
          data-route-mode={swapRouteMode}
          data-source-jurisdiction={routePathSourceLabel}
          data-target-jurisdiction={routePathTargetLabel}
          data-route-venue={routeVenueDisplayLabel}
          data-selected-route-label={selectedRouteLabel}
        >
          <span title={`${sourceRouteEntityLabel} -> ${targetRouteEntityLabel}`}>{routePathLabel}</span>
          <em>via {routeVenueDisplayLabel}</em>
        </div>
        {#if swapRouteMode === 'cross' && canAutoPrepareCrossInboundCapacity}
          <label class="route-checkbox" data-testid="swap-cross-auto-extend">
            <input type="checkbox" bind:checked={autoExtendCrossInbound} />
            <span>Auto-extend target inbound capacity</span>
          </label>
        {/if}
        {#if swapRouteMode === 'cross'}
          <label class="route-select-row" data-testid="swap-cross-improvement-mode">
            <span>Price improvement</span>
            <select class="route-select" bind:value={crossPriceImprovementMode} title="Price improvement">
              <option value="source_savings">Spend less source</option>
              <option value="target_bonus">Receive more target</option>
            </select>
          </label>
        {/if}
        {#if routeDetailsOpen}
          <div class="route-details">
            <span>Source account: {sourceRouteEntityLabel}</span>
            <span>Target account: {targetRouteEntityLabel}</span>
            <span>Venue/orderbook: {routeVenueDisplayLabel}</span>
          </div>
        {/if}
        {#if showManualRouteRecommendation}
          <div class="manual-route-card" data-testid="swap-route-recommendation">
            <div class="manual-route-head">
              <span>No direct orderbook</span>
              <strong>Manual route candidates</strong>
            </div>
            {#each routedRouteRecommendations as route (route.id)}
              <div
                class="manual-route-row"
                data-testid="swap-route-recommendation-row"
                data-route-id={route.id}
                data-hop-count={route.hops.length}
              >
                <span>{route.label}</span>
                <strong>{manualRouteEstimateLabel(route)}</strong>
                <em>{route.summary}</em>
              </div>
            {/each}
          </div>
        {/if}
      </div>

      <div class="avbl-row size-stats">
        <span data-testid="swap-available-stat">Available: <strong>{formattedAvailableGive}</strong></span>
        {#if capacityWarning}
          <span class="capacity-warn">{capacityWarning}</span>
        {/if}
      </div>

      {#if autoCapacityNote}
        <p class="auto-capacity-note" data-testid="swap-auto-capacity-note">{autoCapacityNote}</p>
      {/if}
      {#if showCrossAutoCapacityNote}
        <p class="auto-capacity-note" data-testid="swap-cross-auto-capacity-note">{crossAutoCapacityNote}</p>
      {/if}

      {#if selectedOrderLevel}
        <p class="size-hint" data-testid="swap-size-hint">
          Filled from book level at {formatPriceTicks(selectedOrderLevel.inputPriceTicks > 0n
            ? selectedOrderLevel.inputPriceTicks
            : selectedOrderLevel.priceTicks)}
          from {accountLabel(selectedOrderLevel.accountId)}
        </p>
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
      {#if canCreateTargetAccount}
        <button
          type="button"
          class="secondary-setup-btn"
          data-testid="swap-create-target-account"
          on:click={prepareSelectedTargetAccount}
        >
          Create target account
        </button>
      {/if}
      {#if swapActionDisabledReason || submitError}
        <p class="form-error" data-testid="swap-form-error">{submitError || swapActionDisabledReason}</p>
      {/if}
    </div>

    {#if showOrderbook}
      <div
        class="section section-market"
        data-testid="swap-market-section"
        data-active-book-hub-id={activeBookHubId}
        data-orderbook-hub-ids={orderbookHubIds.join(',')}
        data-active-order-account-id={activeOrderAccountId}
        data-selected-book-account-id={selectedBookAccountId}
        data-create-order-account-id={createOrderAccountId}
        data-selected-route-source-hub={selectedRouteOption?.sourceHubEntityId || ''}
        data-selected-route-target-hub={selectedRouteOption?.targetHubEntityId || ''}
        data-selected-cross-target-hub={selectedCrossTarget?.targetHubEntityId || ''}
        data-route-mode={swapRouteMode}
      >
        <div class="book-toolbar">
          <div>
            <span>Orderbook</span>
            <strong>{orderbookPairDisplayLabel}</strong>
          </div>
          <button
            type="button"
            class="scope-btn"
            class:active={orderbookScopeMode === 'aggregated'}
            data-testid="swap-scope-toggle"
            data-scope-mode={orderbookScopeMode}
            disabled={swapRouteMode === 'cross'}
            on:click={toggleOrderbookScope}
          >
            {orderbookScopeMode === 'aggregated' ? 'All hubs' : 'Selected'}
          </button>
        </div>
        {#if orderbookHubIds.length > 0}
          <div class="orderbook-wrap" data-testid="swap-orderbook">
            <OrderbookPanel
              hubIds={visibleOrderbookHubIds}
              hubId={activeBookHubId || selectedBookAccountId}
              relayUrl={activeOrderbookRelayUrl}
              pairId={orderbookPairId}
              pairLabel={orderbookPairDisplayLabel}
              depth={orderbookDepth}
              showSources={true}
              sourceLabels={orderbookSourceLabels}
              sourceAvatars={orderbookSourceAvatars}
              compactHeader={true}
              showPriceStepControl={false}
              priceScale={Number(ORDERBOOK_PRICE_SCALE)}
              sizeDisplayScale={orderbookSizeDisplayScale}
              disablePriceAggregation={true}
              preferredClickSide={orderMode === 'buy-base' ? 'ask' : 'bid'}
              refreshNonce={orderbookRefreshNonce}
              on:levelclick={handleOrderbookLevelClick}
              on:snapshot={handleOrderbookSnapshot}
            />
          </div>
        {:else}
          <div class="orderbook-empty" data-testid="swap-orderbook-empty">No connected account orderbooks yet.</div>
        {/if}
      </div>
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
    <div class="swap-modal-overlay">
      <div class="swap-modal">
        <div class="swap-modal-kicker">Swap Filled</div>
        <h3>{swapCompletionModal.side} {swapCompletionModal.pairLabel}</h3>
        <p class="swap-modal-copy">
          {formatAmount(swapCompletionModal.filledGiveAmount, swapCompletionModal.giveTokenId)} {tokenSymbol(swapCompletionModal.giveTokenId)}
          → {formatAmount(swapCompletionModal.filledWantAmount, swapCompletionModal.wantTokenId)} {tokenSymbol(swapCompletionModal.wantTokenId)}
        </p>
        {#if swapCompletionModal.priceImprovementAmount > 0n}
          <p class="swap-modal-improvement">
            Price Improvement: <strong>{formatPriceImprovement(swapCompletionModal.priceImprovementAmount, swapCompletionModal.priceImprovementTokenId)}</strong>
          </p>
        {/if}
        {#if swapCompletionModal.feeAmount > 0n}
          <p class="swap-modal-improvement">
            Fee: <strong>{formatSwapFee(swapCompletionModal.feeAmount, swapCompletionModal.feeTokenId)}</strong>
          </p>
        {/if}
        <div class="swap-modal-actions">
          <button
            class="scope-btn active"
            data-testid="swap-completion-close"
            on:click={() => (swapCompletionModal = null)}
          >Close</button>
        </div>
      </div>
    </div>
  {/if}
</div>
