  <script lang="ts">
    import type { AccountMachine, EntityReplica, Tab } from '$lib/types/ui';
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

  export let replica: EntityReplica | null;
  export let tab: Tab;
  export let env: Env | EnvSnapshot;
  export let isLive: boolean;

  // Props
  export let counterpartyId: string = '';
  let orderbookScopeMode: 'aggregated' | 'selected' = 'selected';
  let createOrderAccountId = '';
  let selectedBookAccountId = '';
  let activeOrderAccountId = '';
  let showOrderbook = true;
  const AGGREGATED_ORDERBOOK_DEPTH = 10;
  const SELECTED_ORDERBOOK_DEPTH = 10;
  const ORDERBOOK_PRICE_SCALE = 10_000n;
  const ORDERBOOK_LOT_SCALE = 10n ** 12n;
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
  type SnapshotLevel = { price: bigint; size: number; total: number };
  type OrderbookLevelClickDetail = {
    side: BookSide;
    priceTicks: string;
    size: number;
    accountIds: string[];
    displayPrice?: string;
  };
  type OrderbookSnapshot = {
    pairId: string;
    bids: SnapshotLevel[];
    asks: SnapshotLevel[];
    spread: bigint | null;
    spreadPercent: string;
    sourceCount: number;
    updatedAt: number;
  };
  type FrameLike = Env | EnvSnapshot | EntityState | null | undefined;
  type ClosedOrderStatus = 'filled' | 'partial' | 'canceled' | 'closed';
  type ResolveRecord = {
    fillRatio: number;
    cancelRemainder: boolean;
    height: number;
    executionGiveAmount: bigint | null;
    executionWantAmount: bigint | null;
    feeTokenId: number | null;
    feeAmount: bigint | null;
    comment: string;
  };
  type OfferLifecycle = {
    key: string;
    offerId: string;
    accountId: string;
    giveTokenId: number;
    wantTokenId: number;
    giveAmount: bigint;
    wantAmount: bigint;
    priceTicks: bigint;
    createdAt: number;
    resolves: ResolveRecord[];
    cancelRequested: boolean;
  };
  type ClosedOrderView = {
    offerId: string;
    accountId: string;
    side: 'Ask' | 'Bid';
    pairLabel: string;
    priceTicks: bigint;
    giveTokenId: number;
    wantTokenId: number;
    giveAmount: bigint;
    wantAmount: bigint;
    filledGiveAmount: bigint;
    filledWantAmount: bigint;
    filledBaseAmount: bigint;
    targetBaseAmount: bigint;
    filledPercent: number;
    priceImprovementAmount: bigint;
    priceImprovementTokenId: number | null;
    feeAmount: bigint;
    feeTokenId: number | null;
    status: ClosedOrderStatus;
    closeComment: string;
    createdAt: number;
    closedAt: number;
  };
  type SwapCompletionModal = {
    offerId: string;
    side: 'Ask' | 'Bid';
    pairLabel: string;
    filledGiveAmount: bigint;
    filledWantAmount: bigint;
    giveTokenId: number;
    wantTokenId: number;
    priceImprovementAmount: bigint;
    priceImprovementTokenId: number | null;
    feeAmount: bigint;
    feeTokenId: number | null;
  };
  let selectedOrderLevel: ClickedOrderLevel | null = null;
  let orderbookSnapshot: OrderbookSnapshot = {
    pairId: '1/2',
    bids: [],
    asks: [],
    spread: null,
    spreadPercent: '-',
    sourceCount: 0,
    updatedAt: 0,
  };
  let orderbookPairId = '1/2';
  let orderbookViewKey = '';
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
  let priceRatioInput = '';
  let giveAmount: bigint = 0n;
  let wantAmount: bigint = 0n;
  let preparedOrder: PreparedSwapOrderLike | null = null;
  let parsedOrderbookPair: { baseTokenId: number; quoteTokenId: number } | null = null;
  let orderMode: 'buy-base' | 'sell-base' | 'none' = 'none';
  let limitPriceTicks: bigint | null = null;
  let orderListTab: 'open' | 'closed' = 'open';
  let orderRouteFilter: 'all' | 'same' | 'cross' = 'all';
  let closedOrderStatusFilter: 'all' | ClosedOrderStatus = 'all';
  let offerLifecycles: OfferLifecycle[] = [];
  let closedOfferLifecycles: OfferLifecycle[] = [];
  let closedOrderViews: ClosedOrderView[] = [];
  let wantTokenPresentInAccount = false;
  let availableGiveCapacity = 0n;
  let availableWantInCapacity = 0n;
  let autoInboundCreditTarget: bigint | null = null;
  let currentPeerCreditLimit = 0n;
  let formattedAvailableGive = '0';
  let formattedAvailableWantIn = '0';
  let autoInboundCreditIncrease = 0n;
  let canAutoPrepareInboundCapacity = false;
  let swapRouteMode: 'same' | 'cross' = 'same';
  let selectedRouteValue = 'same';
  let selectedCrossTargetValue = '';
  let crossTargetOptions: CrossTargetOption[] = [];
  let routeOptions: SwapRouteOption[] = [];
  let selectedCrossTarget: CrossTargetOption | null = null;
  let autoExtendCrossInbound = true;
  let crossPriceImprovementMode: 'source_savings' | 'target_bonus' = 'source_savings';
  let selectedSourceEntityValue = '';
  let routeDetailsOpen = false;
  let openTokenMenu: 'give' | 'want' | '' = '';
  let sourceMenuOpen = false;
  let routeMenuOpen = false;
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
  $: hubAccountIds = accountIds.filter((id) => isHubAccount(id)).slice(0, 10);
  $: hiddenAccountCount = Math.max(0, accountIds.length - hubAccountIds.length);
  $: if (!selectedBookAccountId || !hubAccountIds.includes(selectedBookAccountId)) {
    selectedBookAccountId = counterpartyId && hubAccountIds.includes(counterpartyId)
      ? counterpartyId
      : (hubAccountIds[0] || '');
  }
  $: if (!createOrderAccountId || !hubAccountIds.includes(createOrderAccountId)) {
    createOrderAccountId = selectedBookAccountId || '';
  }
  $: if (orderbookScopeMode === 'selected' && selectedBookAccountId) {
    createOrderAccountId = selectedBookAccountId;
  }
  $: currentHubSelection = orderbookScopeMode === 'aggregated'
    ? createOrderAccountId
    : selectedBookAccountId;
  $: activeOrderAccountId = orderbookScopeMode === 'aggregated'
    ? createOrderAccountId
    : selectedBookAccountId;
  $: activeBookHubId = (() => {
    const sourceHubId = String(activeOrderAccountId || '').trim().toLowerCase();
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
  $: orderbookDepth = orderbookScopeMode === 'aggregated'
    ? AGGREGATED_ORDERBOOK_DEPTH
    : SELECTED_ORDERBOOK_DEPTH;
  $: orderbookViewKey = `${orderbookPairId}|${orderbookScopeMode}|${selectedBookAccountId}|${orderbookHubIds.join(',')}|${orderbookRefreshNonce}`;

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

  function formatEntityNetworkLabel(name: string, jurisdiction: string): string {
    const cleanName = String(name || '').trim() || 'Unknown';
    const cleanJurisdiction = String(jurisdiction || '').trim();
    return cleanJurisdiction ? `${cleanName} (${cleanJurisdiction})` : cleanName;
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
    const clean = String(jurisdiction || '').trim().replace(/[^a-zA-Z0-9\s._-]/g, ' ');
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
  $: selectedHubOption = selectedHubOptions.find((hub) => hub.value === createOrderAccountId) || null;
  $: crossTargetOptions = buildCrossTargetOptions(activeFrame, sourceEntityIdValue, currentReplica);
  $: routeOptions = buildRouteOptions(sourceEntityIdValue, currentReplica, activeOrderAccountId, crossTargetOptions);
  $: if (!routeOptions.some((option) => option.value === selectedRouteValue)) {
    selectedRouteValue = 'same';
  }
  $: if (selectedRouteValue !== 'same' && routeOptions.find((option) => option.value === selectedRouteValue)?.disabled) {
    selectedRouteValue = 'same';
  }
  $: swapRouteMode = selectedRouteValue === 'same' ? 'same' : 'cross';
  $: selectedCrossTargetValue = swapRouteMode === 'cross' ? selectedRouteValue : '';
  $: selectedCrossTarget = crossTargetOptions.find((option) => option.value === selectedCrossTargetValue) || null;
  $: sourceJurisdictionLabel = getReplicaJurisdictionName(currentReplica) || 'Current';
  $: targetJurisdictionLabel = swapRouteMode === 'cross' && selectedCrossTarget
    ? selectedCrossTarget.targetJurisdiction
    : sourceJurisdictionLabel;
  $: sourceRouteEntityLabel = `${accountLabel(sourceEntityIdValue)} -> ${accountLabel(String(activeOrderAccountId || ''))}`;
  $: targetRouteEntityLabel = swapRouteMode === 'cross' && selectedCrossTarget
    ? `${accountLabel(selectedCrossTarget.targetHubEntityId)} -> ${accountLabel(selectedCrossTarget.targetEntityId)}`
    : `${accountLabel(String(activeOrderAccountId || ''))} -> ${accountLabel(sourceEntityIdValue)}`;
  $: sourceChainLabel = selectedSourceEntity?.jurisdiction || sourceJurisdictionLabel;
  $: selectedRouteOption = routeOptions.find((option) => option.value === selectedRouteValue) || routeOptions[0] || null;
  $: selectedRouteUnavailableReason = selectedRouteOption?.disabled ? selectedRouteOption.disabledReason || 'Selected route is unavailable.' : '';
  $: routeVenueLabel = activeOrderAccountId ? accountLabel(activeOrderAccountId) : 'Select venue';
  $: bookVenueLabel = activeBookHubId ? accountLabel(activeBookHubId) : routeVenueLabel;
  $: selectedSourceEntityLabel = selectedSourceEntity?.label || sourceChainLabel || '';
  $: selectedRouteLabel = selectedRouteOption?.label || '';
  $: selectedHubLabel = selectedHubOption?.label || routeVenueLabel || '';
  $: selectedHubJurisdictionLabel = hubJurisdictionLabel(createOrderAccountId) || sourceJurisdictionLabel;
  $: selectedHubDisplayLabel = createOrderAccountId
    ? formatEntityNetworkLabel(selectedHubLabel, selectedHubJurisdictionLabel)
    : 'Select hub';
  $: routePathLabel = swapRouteMode === 'cross'
    ? `${sourceJurisdictionLabel} -> ${targetJurisdictionLabel}`
    : sourceJurisdictionLabel;
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
  type OfferLike = {
    giveTokenId: number;
    wantTokenId: number;
    giveAmount?: bigint;
    wantAmount?: bigint;
    priceTicks?: bigint;
  };

  type CrossMarketView = {
    venueId: string;
    sourceIsBase: boolean;
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
    if (byConfig) return byConfig;
    const byPosition = String(candidate?.position?.jurisdiction || '').trim();
    if (byPosition) return byPosition;
    return '';
  }

  function getReplicaJurisdictionRef(candidate: EntityReplica | null | undefined): string {
    const state = candidate?.state as {
      config?: { jurisdiction?: { chainId?: unknown; depositoryAddress?: unknown; name?: unknown } };
    } | undefined;
    const stackId = getJurisdictionStackId(state?.config?.jurisdiction);
    if (stackId) return stackId;
    return getReplicaJurisdictionName(candidate);
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
    return String(profile?.metadata?.jurisdiction?.name || '').trim();
  }

  function getHubProfile(entityIdValue: string): GossipProfile | null {
    const normalized = String(entityIdValue || '').trim().toLowerCase();
    if (!normalized) return null;
    return getGossipProfiles().find((profile) =>
      profile?.metadata?.isHub === true
      && String(profile?.entityId || '').trim().toLowerCase() === normalized
    ) || null;
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
        label: compatible ? recipientLabel : `Try another hub (${target.targetJurisdiction})`,
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
        disabled: !compatible,
        disabledReason,
      });
    }
    return options;
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

  function buildPairOptions(): PairOption[] {
    const runtimeRequiredPairs = activeXlnFunctions?.getDefaultSwapTradingPairs?.() || [];
    const requiredPairs = runtimeRequiredPairs.length > 0
      ? runtimeRequiredPairs.map((pair) => resolvePairOrientation(Number(pair.baseTokenId), Number(pair.quoteTokenId)))
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

  $: pairOptions = buildPairOptions();
  $: allowedSwapTokenIds = (() => {
    const tokenIds = new Set<number>();
    for (const pair of pairOptions) {
      tokenIds.add(pair.baseTokenId);
      tokenIds.add(pair.quoteTokenId);
    }
    return tokenIds;
  })();
  $: swapTokenOptions = Array.from(allowedSwapTokenIds)
    .sort((a, b) => compareStableText(tokenSymbol(a), tokenSymbol(b)))
    .map((tokenId) => ({ tokenId, symbol: tokenSymbol(tokenId) }));
  $: giveToken = Number.parseInt(giveTokenId, 10);
  $: wantToken = Number.parseInt(wantTokenId, 10);
  $: derivedTokenPairValue = (() => {
    if (!Number.isFinite(giveToken) || !Number.isFinite(wantToken) || giveToken <= 0 || wantToken <= 0 || giveToken === wantToken) return '';
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
    const fallback = swapTokenOptions.find((token) => token.tokenId !== tokenIdValue);
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
    if (nextGiveToken === nextWantToken && selectedRouteValue === 'same') {
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
    routeMenuOpen = false;
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

  function tokenIconText(symbol: string): string {
    const text = String(symbol || '').trim();
    return text.slice(0, 1).toUpperCase() || '?';
  }

  function tokenClass(symbol: string): string {
    return String(symbol || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'token';
  }

  function toggleTokenMenu(menu: 'give' | 'want'): void {
    sourceMenuOpen = false;
    routeMenuOpen = false;
    hubMenuOpen = false;
    openTokenMenu = openTokenMenu === menu ? '' : menu;
  }

  function toggleSourceMenu(): void {
    openTokenMenu = '';
    routeMenuOpen = false;
    hubMenuOpen = false;
    sourceMenuOpen = !sourceMenuOpen;
  }

  function toggleRouteMenu(): void {
    sourceMenuOpen = false;
    openTokenMenu = '';
    hubMenuOpen = false;
    routeMenuOpen = !routeMenuOpen;
  }

  function toggleHubMenu(): void {
    sourceMenuOpen = false;
    openTokenMenu = '';
    routeMenuOpen = false;
    hubMenuOpen = !hubMenuOpen;
  }

  function selectGiveTokenOption(tokenIdValue: number): void {
    setSwapTokens(tokenIdValue, wantToken);
    sourceMenuOpen = false;
    openTokenMenu = '';
    routeMenuOpen = false;
    hubMenuOpen = false;
  }

  function selectWantTokenOption(tokenIdValue: number): void {
    setSwapTokens(giveToken, tokenIdValue);
    sourceMenuOpen = false;
    openTokenMenu = '';
    routeMenuOpen = false;
    hubMenuOpen = false;
  }

  function handleRouteSelectChange(event: Event): void {
    const nextValue = String((event.currentTarget as HTMLSelectElement | null)?.value || '');
    selectRouteOption(nextValue);
  }

  function selectRouteOption(value: string): void {
    const option = routeOptions.find((candidate) => candidate.value === value);
    if (!option || option.disabled) return;
    selectedRouteValue = option.value;
    sourceMenuOpen = false;
    openTokenMenu = '';
    routeMenuOpen = false;
    hubMenuOpen = false;
    submitError = '';
  }

  function closeSwapMenus(): void {
    sourceMenuOpen = false;
    openTokenMenu = '';
    routeMenuOpen = false;
    hubMenuOpen = false;
  }

  function handleSwapWindowClick(event: MouseEvent): void {
    const target = event.target as HTMLElement | null;
    if (target?.closest?.('[data-swap-menu-root]')) return;
    closeSwapMenus();
  }

  function handleSwapWindowKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') closeSwapMenus();
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

  $: activeOffers = currentReplica ? activeXlnFunctions.listOpenSwapOffers(currentReplica.state) : [];

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

  function findReplicaByEntityId(entityId: string): EntityReplica | null {
    const normalized = String(entityId || '').trim().toLowerCase();
    if (!normalized) return null;
    return localEntityReplicas().find((candidate) =>
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
    crossAutoInboundCreditTarget = selectedCrossTarget
      ? computeAutoInboundCreditTargetForReplica(
          targetReplica,
          selectedCrossTarget.targetEntityId,
          selectedCrossTarget.targetHubEntityId,
          wantToken,
          canonicalWantAmount,
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
  $: formattedAvailableGive = Number.isFinite(giveToken) && giveToken > 0
    ? `${formatAmount(availableGiveCapacity, giveToken)} ${giveTokenSymbol}`
    : availableGiveCapacity.toString();
  $: formattedAvailableWantIn = Number.isFinite(wantToken) && wantToken > 0
    ? `${formatAmount(availableWantInCapacity, wantToken)} ${wantTokenSymbol}`
    : availableWantInCapacity.toString();
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
    if (!(activeFrame?.eReplicas instanceof Map) || !hubEntityId) return null;
    const normalizedHubId = String(hubEntityId).trim().toLowerCase();
    if (!normalizedHubId) return null;
    for (const [key, replica] of activeFrame.eReplicas.entries()) {
      const entityId = String(key || '').split(':')[0]?.trim().toLowerCase();
      if (entityId !== normalizedHubId) continue;
      return replica?.state?.orderbookExt?.books?.get?.(orderbookPairId) || null;
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
  $: if (selectedOrderLevel && orderbookScopeMode !== 'aggregated' && selectedOrderLevel.accountId !== selectedBookAccountId) {
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
      orderAmountInput = formatAmountForInput(fillGive, giveToken);
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

    orderAmountInput = formatAmountForInput(fillGive, levelGiveTokenId);
    priceRatioInput = selectedOrderLevel.displayPrice
      ? normalizeDisplayPriceForInput(selectedOrderLevel.displayPrice)
      : formatPriceTicks(selectedOrderLevel.priceTicks);
  }

  function readLogicalNumber(value: unknown): number {
    const numeric = Number(value ?? 0);
    return Number.isFinite(numeric) ? Math.max(0, Math.floor(numeric)) : 0;
  }

  function stableIdHash(input: string): string {
    let hash = 0xcbf29ce484222325n;
    for (let i = 0; i < input.length; i += 1) {
      hash ^= BigInt(input.charCodeAt(i));
      hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
    }
    return hash.toString(36).padStart(13, '0');
  }

  function buildSwapOfferId(
    logicalTimestamp: number,
    logicalHeight: number,
    sourceEntityId: string,
    counterpartyEntityId: string,
    sellToken: number,
    buyToken: number,
    sellAmount: bigint,
    buyAmount: bigint,
    priceTicks: bigint,
    routeValue: string,
  ): string {
    const seed = [
      logicalTimestamp,
      logicalHeight,
      sourceEntityId,
      counterpartyEntityId,
      sellToken,
      buyToken,
      sellAmount.toString(),
      buyAmount.toString(),
      priceTicks.toString(),
      routeValue,
    ].join('|');
    return `swap-${logicalTimestamp.toString(36)}-${logicalHeight.toString(36)}-${stableIdHash(seed)}`;
  }

  function handleOrderbookSnapshot(event: CustomEvent<OrderbookSnapshot>) {
    orderbookSnapshot = event.detail;
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
    routeMenuOpen = false;
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

  function setOrderListTab(nextTab: 'open' | 'closed'): void {
    if (orderListTab === nextTab) return;
    orderListTab = nextTab;
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
      // Cross-j book owner can be the target hub. Source capacity still
      // belongs to activeOrderAccountId, so do not rewrite createOrderAccountId.
    } else if (orderbookScopeMode === 'aggregated') {
      createOrderAccountId = clickedAccountId;
    } else {
      selectedBookAccountId = clickedAccountId;
      createOrderAccountId = clickedAccountId;
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
    return Number.isFinite(decimals) && decimals >= 0 ? decimals : 18;
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
  $: baseTokenId = parsedOrderbookPair?.baseTokenId ?? giveToken;
  $: quoteTokenId = parsedOrderbookPair?.quoteTokenId ?? wantToken;
  $: baseTokenSymbol = tokenSymbol(baseTokenId);
  $: quoteTokenSymbol = tokenSymbol(quoteTokenId);
  $: baseTokenDecimals = getTokenDecimals(baseTokenId);
  $: quoteTokenDecimals = getTokenDecimals(quoteTokenId);
  $: orderbookSizeDisplayScale = baseTokenDecimals > 12 ? 10 ** Math.max(0, baseTokenDecimals - 12) : 1;
  $: giveTokenDecimals = getTokenDecimals(giveToken);
  $: limitPriceTicks = parseDisplayPriceTicks(priceRatioInput, 0n);
  $: giveAmount = parseDecimalAmountToBigInt(orderAmountInput, giveTokenDecimals);
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
  function offerSideLabel(offer: OfferLike): 'Ask' | 'Bid' {
    const give = Number(offer.giveTokenId || 0);
    const want = Number(offer.wantTokenId || 0);
    const pair = resolvePairOrientation(give, want);
    return give === pair.baseTokenId ? 'Ask' : 'Bid';
  }

  function offerPriceTicks(offer: OfferLike): bigint {
    const explicitPriceTicks = toBigIntSafe(offer.priceTicks);
    if (explicitPriceTicks && explicitPriceTicks > 0n) return explicitPriceTicks;
    const giveToken = Number(offer.giveTokenId || 0);
    const wantToken = Number(offer.wantTokenId || 0);
    const give = toBigIntSafe(offer.giveAmount) ?? 0n;
    const want = toBigIntSafe(offer.wantAmount) ?? 0n;
    if (!Number.isFinite(giveToken) || !Number.isFinite(wantToken)) return 0n;
    if (giveToken <= 0 || wantToken <= 0) return 0n;
    if (give <= 0n || want <= 0n) return 0n;
    return activeXlnFunctions.computeSwapPriceTicks(giveToken, wantToken, give, want);
  }

  function remainingOfferUsd(offer: SwapOfferLike): number {
    const giveToken = Number(offer.giveTokenId || 0);
    const giveAmountValue = toBigIntSafe(offer.giveAmount) ?? 0n;
    if (!Number.isFinite(giveToken) || giveToken <= 0 || giveAmountValue <= 0n) return 0;
    const info = activeXlnFunctions?.getTokenInfo?.(giveToken);
    const decimals = Number(info?.decimals ?? 18);
    const symbol = String(info?.symbol || '');
    return amountToUsd(giveAmountValue, decimals, symbol);
  }

  function isDustOpenOffer(offer: SwapOfferLike): boolean {
    const remainingUsd = remainingOfferUsd(offer);
    return remainingUsd > 0 && remainingUsd < MIN_ORDER_NOTIONAL_USD;
  }

  $: routeFilteredOpenOffers = activeOffers.filter((offer: SwapOfferLike) => {
    if (orderRouteFilter === 'all') return true;
    const isCross = Boolean(offer.crossJurisdiction);
    return orderRouteFilter === 'cross' ? isCross : !isCross;
  });
  $: openOrders = [...routeFilteredOpenOffers].sort((a: SwapOfferLike, b: SwapOfferLike) => {
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

  function offerLifecycleKey(accountId: string, offerId: string): string {
    return `${String(accountId || '').trim()}:${String(offerId || '').trim()}`;
  }

  function computeFilledPpmFromRatios(resolves: ResolveRecord[]): bigint {
    let remainingPpm = 1_000_000n;
    for (const resolve of resolves) {
      const ratio = BigInt(Math.max(0, Math.min(65535, Math.round(resolve.fillRatio || 0))));
      const filledThisStep = (remainingPpm * ratio) / 65535n;
      remainingPpm = remainingPpm - filledThisStep;
      if (remainingPpm < 0n) remainingPpm = 0n;
      if (resolve.cancelRemainder) break;
    }
    return 1_000_000n - remainingPpm;
  }

  function isBuyLifecycle(lifecycle: OfferLifecycle): boolean {
    return offerSideLabel(lifecycle) === 'Bid';
  }

  function computeOfferExecutionSummary(lifecycle: OfferLifecycle): {
    filledGiveAmount: bigint;
    filledWantAmount: bigint;
    filledBaseAmount: bigint;
    targetBaseAmount: bigint;
    filledPpm: bigint;
    priceImprovementAmount: bigint;
    priceImprovementTokenId: number | null;
    feeAmount: bigint;
    feeTokenId: number | null;
  } {
    const pair = resolvePairOrientation(lifecycle.giveTokenId, lifecycle.wantTokenId);
    const isBuy = isBuyLifecycle(lifecycle);
    const baseDecimals = getTokenDecimals(pair.baseTokenId);
    const quoteDecimals = getTokenDecimals(pair.quoteTokenId);
    const targetBaseAmount = isBuy ? lifecycle.wantAmount : lifecycle.giveAmount;
    let filledGiveAmount = 0n;
    let filledWantAmount = 0n;
    let filledBaseAmount = 0n;
    let priceImprovementAmount = 0n;
    let feeAmount = 0n;
    let feeTokenId: number | null = null;
    let sawExactExecution = false;

    for (const resolve of lifecycle.resolves) {
      const executionGiveAmount = resolve.executionGiveAmount;
      const executionWantAmount = resolve.executionWantAmount;
      if (executionGiveAmount === null || executionWantAmount === null) continue;
      if (executionGiveAmount <= 0n || executionWantAmount <= 0n) continue;

      sawExactExecution = true;
      filledGiveAmount += executionGiveAmount;
      filledWantAmount += executionWantAmount;

      const filledBaseThisStep = isBuy ? executionWantAmount : executionGiveAmount;
      const actualQuoteThisStep = isBuy ? executionGiveAmount : executionWantAmount;
      filledBaseAmount += filledBaseThisStep;

      const limitQuoteThisStep = quoteFromBase(
        filledBaseThisStep,
        lifecycle.priceTicks,
        baseDecimals,
        quoteDecimals,
      );
      if (isBuy) {
        const saved = limitQuoteThisStep - actualQuoteThisStep;
        if (saved > 0n) priceImprovementAmount += saved;
      } else {
        const gained = actualQuoteThisStep - limitQuoteThisStep;
        if (gained > 0n) priceImprovementAmount += gained;
      }

      if ((resolve.feeAmount ?? 0n) > 0n) {
        feeAmount += resolve.feeAmount ?? 0n;
        feeTokenId = resolve.feeTokenId ?? lifecycle.wantTokenId;
      }
    }

    if (!sawExactExecution) {
      const filledPpm = computeFilledPpmFromRatios(lifecycle.resolves);
      return {
        filledGiveAmount: (lifecycle.giveAmount * filledPpm) / 1_000_000n,
        filledWantAmount: (lifecycle.wantAmount * filledPpm) / 1_000_000n,
        filledBaseAmount: (targetBaseAmount * filledPpm) / 1_000_000n,
        targetBaseAmount,
        filledPpm,
        priceImprovementAmount: 0n,
        priceImprovementTokenId: null,
        feeAmount: 0n,
        feeTokenId: null,
      };
    }

    const boundedFilledBase = filledBaseAmount > targetBaseAmount ? targetBaseAmount : filledBaseAmount;
    const filledPpm = targetBaseAmount > 0n
      ? ((boundedFilledBase * 1_000_000n) / targetBaseAmount)
      : 0n;

    return {
      filledGiveAmount,
      filledWantAmount,
      filledBaseAmount: boundedFilledBase,
      targetBaseAmount,
      filledPpm: filledPpm > 1_000_000n ? 1_000_000n : filledPpm,
      priceImprovementAmount,
      priceImprovementTokenId: priceImprovementAmount > 0n ? pair.quoteTokenId : null,
      feeAmount,
      feeTokenId,
    };
  }

  function collectOfferLifecyclesFrom(
    selectSource: (account: AccountMachine) => Map<string, unknown> | undefined,
  ): OfferLifecycle[] {
    const lifecycles: OfferLifecycle[] = [];
    for (const { accountId, account } of accountMachines()) {
      const source = selectSource(account);
      if (!(source instanceof Map)) continue;
      for (const [offerId, rawEntry] of source.entries()) {
        if (!rawEntry || typeof rawEntry !== 'object') continue;
        const entry = rawEntry as {
          giveTokenId?: unknown;
          wantTokenId?: unknown;
          giveAmount?: unknown;
          wantAmount?: unknown;
          priceTicks?: unknown;
          createdHeight?: unknown;
          cancelRequested?: unknown;
          resolves?: unknown;
        };
        const giveTokenId = Number(entry.giveTokenId || 0);
        const wantTokenId = Number(entry.wantTokenId || 0);
        const giveAmount = toBigIntSafe(entry.giveAmount) ?? 0n;
        const wantAmount = toBigIntSafe(entry.wantAmount) ?? 0n;
        if (!Number.isFinite(giveTokenId) || !Number.isFinite(wantTokenId) || giveTokenId <= 0 || wantTokenId <= 0) continue;
        if (giveAmount <= 0n || wantAmount <= 0n) continue;
        const priceTicks = toBigIntSafe(entry.priceTicks)
          ?? (activeXlnFunctions?.computeSwapPriceTicks
            ? activeXlnFunctions.computeSwapPriceTicks(giveTokenId, wantTokenId, giveAmount, wantAmount)
            : 0n);
        const resolves = Array.isArray(entry.resolves)
          ? entry.resolves.map((resolve) => {
              const rawResolve = resolve as {
                fillRatio?: unknown;
                cancelRemainder?: unknown;
                height?: unknown;
                executionGiveAmount?: unknown;
                executionWantAmount?: unknown;
                feeTokenId?: unknown;
                feeAmount?: unknown;
                comment?: unknown;
              };
              const feeTokenId = Number(rawResolve.feeTokenId);
              return {
                fillRatio: Number.isFinite(Number(rawResolve.fillRatio)) ? Number(rawResolve.fillRatio) : 0,
                cancelRemainder: Boolean(rawResolve.cancelRemainder),
                height: Number.isFinite(Number(rawResolve.height)) ? Number(rawResolve.height) : 0,
                executionGiveAmount: toBigIntSafe(rawResolve.executionGiveAmount),
                executionWantAmount: toBigIntSafe(rawResolve.executionWantAmount),
                feeTokenId: Number.isFinite(feeTokenId) ? feeTokenId : null,
                feeAmount: toBigIntSafe(rawResolve.feeAmount),
                comment: typeof rawResolve.comment === 'string' ? rawResolve.comment : '',
              } satisfies ResolveRecord;
            })
          : [];
        lifecycles.push({
          key: offerLifecycleKey(accountId, String(offerId || '')),
          offerId: String(offerId || ''),
          accountId,
          giveTokenId,
          wantTokenId,
          giveAmount,
          wantAmount,
          priceTicks,
          createdAt: Number(entry.createdHeight || 0),
          resolves,
          cancelRequested: Boolean(entry.cancelRequested),
        });
      }
    }
    return lifecycles;
  }

  function classifyClosedStatus(lifecycle: OfferLifecycle): ClosedOrderStatus {
    const summary = computeOfferExecutionSummary(lifecycle);
    const filledPpm = summary.filledPpm;
    if (filledPpm >= FILLED_DISPLAY_PPM_THRESHOLD) return 'filled';
    const hasFill = summary.filledBaseAmount > 0n;
    const hasCancelResolve = lifecycle.resolves.some((resolve) => resolve.cancelRemainder);
    if (hasFill) return 'partial';
    if (hasCancelResolve || lifecycle.cancelRequested) return 'canceled';
    return 'closed';
  }

  function latestResolveComment(lifecycle: OfferLifecycle): string {
    for (let i = lifecycle.resolves.length - 1; i >= 0; i -= 1) {
      const comment = String(lifecycle.resolves[i]?.comment || '').trim();
      if (comment) return comment;
    }
    return '';
  }

  function extractStpBlockingOrderId(comment: string): string {
    return comment.startsWith('STP:') ? comment.slice(4).trim() : '';
  }

  function formatCloseComment(comment: string): string {
    const blockingOrderId = extractStpBlockingOrderId(comment);
    if (!blockingOrderId) return comment;
    return `STP:${blockingOrderId.slice(-8)}`;
  }

  function formatOrderTime(ms: number): string {
    if (!Number.isFinite(ms) || ms <= 0) return '-';
    if (ms < 1_000_000_000_000) return `#${ms}`;
    return new Date(ms).toLocaleTimeString();
  }

  function closedOrderStatusLabel(status: ClosedOrderStatus): string {
    if (status === 'filled') return 'Filled';
    if (status === 'partial') return 'Partial';
    if (status === 'canceled') return 'Canceled';
    return 'Closed';
  }

  function closedOrderStatusTone(status: ClosedOrderStatus): 'bid' | 'ask' | 'neutral' {
    if (status === 'filled') return 'bid';
    if (status === 'partial') return 'ask';
    return 'neutral';
  }

  $: {
    currentReplica;
    activeXlnFunctions;
    offerLifecycles = collectOfferLifecyclesFrom((account) => account.swapOrderHistory);
    closedOfferLifecycles = collectOfferLifecyclesFrom((account) => account.swapClosedOrders);
  }

  $: closedOrderViews = closedOfferLifecycles
    .map((offer) => {
      const side = offerSideLabel(offer);
      const pair = resolvePairOrientation(offer.giveTokenId, offer.wantTokenId);
      const pairLabel = `${tokenSymbol(pair.baseTokenId)}/${tokenSymbol(pair.quoteTokenId)}`;
      const summary = computeOfferExecutionSummary(offer);
      const filledPpm = summary.filledPpm;
      const filledPercent = filledPpm >= FILLED_DISPLAY_PPM_THRESHOLD
        ? 100
        : Number((filledPpm * 10_000n) / 1_000_000n) / 100;
      const latestResolveTs = offer.resolves.length > 0 ? offer.resolves[offer.resolves.length - 1]!.height : offer.createdAt;
      const closeComment = latestResolveComment(offer);
      return {
        offerId: offer.offerId,
        accountId: offer.accountId,
        side,
        pairLabel,
        priceTicks: offer.priceTicks,
        giveTokenId: offer.giveTokenId,
        wantTokenId: offer.wantTokenId,
        giveAmount: offer.giveAmount,
        wantAmount: offer.wantAmount,
        filledGiveAmount: summary.filledGiveAmount,
        filledWantAmount: summary.filledWantAmount,
        filledBaseAmount: summary.filledBaseAmount,
        targetBaseAmount: summary.targetBaseAmount,
        filledPercent,
        priceImprovementAmount: summary.priceImprovementAmount,
        priceImprovementTokenId: summary.priceImprovementTokenId,
        feeAmount: summary.feeAmount,
        feeTokenId: summary.feeTokenId,
        status: classifyClosedStatus(offer),
        closeComment,
        createdAt: offer.createdAt,
        closedAt: latestResolveTs,
      } satisfies ClosedOrderView;
    })
    .sort((a, b) => b.closedAt - a.closedAt);
  $: filteredClosedOrderViews = closedOrderStatusFilter === 'all'
    ? closedOrderViews
    : closedOrderViews.filter((order) => order.status === closedOrderStatusFilter);
  $: offerPriceImprovementByKey = (() => {
    const map = new Map<string, { amount: bigint; tokenId: number | null }>();
    for (const lifecycle of offerLifecycles) {
      const summary = computeOfferExecutionSummary(lifecycle);
      map.set(lifecycle.key, {
        amount: summary.priceImprovementAmount,
        tokenId: summary.priceImprovementTokenId,
      });
    }
    return map;
  })();
  $: totalPriceImprovementSummary = (() => {
    const totals = new Map<number, bigint>();
    for (const lifecycle of offerLifecycles) {
      const summary = computeOfferExecutionSummary(lifecycle);
      const tokenId = summary.priceImprovementTokenId;
      const amount = summary.priceImprovementAmount;
      if (!tokenId || amount <= 0n) continue;
      totals.set(tokenId, (totals.get(tokenId) ?? 0n) + amount);
    }
    const parts = Array.from(totals.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([tokenId, amount]) => `${formatAmount(amount, tokenId)} ${tokenSymbol(tokenId)}`);
    return parts.length > 0 ? parts.join(' · ') : '';
  })();
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
      const offerId = buildSwapOfferId(
        logicalNow,
        logicalHeight,
        sourceEntityId,
        resolvedCounterparty,
        giveToken,
        wantToken,
        effectiveGiveAmount,
        effectiveWantAmount,
        canonicalPriceTicks,
        selectedRouteValue,
      );
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
      const requiredTargetInboundCreditLimit = targetRoute
        ? computeAutoInboundCreditTargetForReplica(
            targetReplica,
            targetRoute.targetEntityId,
            targetRoute.targetHubEntityId,
            wantToken,
            effectiveWantAmount,
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
        return {
          orderId: offerId,
          bookOwnerEntityId,
          venueId: deriveCanonicalCrossJurisdictionVenueIdForLegs(sourceJurisdictionRef, giveToken, targetRoute.targetJurisdictionRef, wantToken),
          makerEntityId: sourceEntityId,
          hubEntityId: bookOwnerEntityId,
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
      orderAmountInput = '';
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

<div class="swap-panel">
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
                  <strong>{selectedSourceEntity?.name || accountLabel(sourceEntityIdValue)}</strong>
                  <small>{selectedSourceEntity?.jurisdiction || sourceJurisdictionLabel}</small>
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
                        <strong>{option.name}</strong>
                        <small>{option.jurisdiction}</small>
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
              inputmode="decimal"
              placeholder="0"
              data-testid="swap-order-amount"
              aria-label="Swap from amount"
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
                value={String(giveToken)}
                data-testid="swap-from-token-select"
                aria-label="Swap from token"
                on:change={handleGiveTokenChange}
              >
                {#each swapTokenOptions as token}
                  <option value={token.tokenId}>{token.symbol}</option>
                {/each}
              </select>
              {#if openTokenMenu === 'give'}
                <div class="token-menu" role="listbox" aria-label="Sell token">
                  {#each swapTokenOptions as token}
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
            <strong>{formattedAvailableGive}</strong>
          </div>
        </div>

        <div class="swap-leg-divider">
          <button
            type="button"
            class="direction-chip"
            on:click={() => setSwapTokens(wantToken, giveToken)}
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
                class="chain-select route-menu-button"
                aria-haspopup="listbox"
                aria-expanded={routeMenuOpen}
                title={selectedRouteLabel}
                on:click|stopPropagation={toggleRouteMenu}
              >
                <span class={`route-glyph ${selectedRouteOption?.mode === 'cross' ? 'cross' : 'same'}`} aria-hidden="true">
                  <span class="route-node route-node-a"></span>
                  {#if selectedRouteOption?.mode === 'cross'}<span class="route-node route-node-b"></span>{/if}
                  <span class="route-arrows">⇄</span>
                </span>
                <span>{selectedRouteLabel || 'Same account'}</span>
                <em aria-hidden="true">⌄</em>
              </button>
              <select
                class="route-select-native"
                value={selectedRouteValue}
                data-testid="swap-route-select"
                aria-label="Swap to network"
                title={selectedRouteLabel}
                on:change={handleRouteSelectChange}
              >
                {#each routeOptions as option}
                  <option value={option.value} disabled={option.disabled} title={option.label}>{option.label}</option>
                {/each}
              </select>
              {#if routeMenuOpen}
                <div class="route-menu" role="listbox" aria-label="Destination account">
                  {#each routeOptions as option}
                    <button
                      type="button"
                      class:selected={option.value === selectedRouteValue}
                      class:disabled={option.disabled}
                      class="route-option"
                      role="option"
                      aria-selected={option.value === selectedRouteValue}
                      disabled={option.disabled}
                      title={option.disabledReason || option.label}
                      on:click|stopPropagation={() => selectRouteOption(option.value)}
                    >
                      <span class={`route-glyph ${option.mode}`} aria-hidden="true">
                        <span class="route-node route-node-a"></span>
                        {#if option.mode === 'cross'}<span class="route-node route-node-b"></span>{/if}
                        <span class="route-arrows">⇄</span>
                      </span>
                      <span class="route-option-copy">
                        <strong>{option.label}</strong>
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
                value={String(wantToken)}
                data-testid="swap-to-token-select"
                aria-label="Swap to token"
                on:change={handleWantTokenChange}
              >
                {#each swapTokenOptions as token}
                  <option value={token.tokenId}>{token.symbol}</option>
                {/each}
              </select>
              {#if openTokenMenu === 'want'}
                <div class="token-menu" role="listbox" aria-label="Buy token">
                  {#each swapTokenOptions as token}
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
            <strong>{targetAccountReady ? estimatedReceiveLabel : 'Account setup required'}</strong>
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
              <strong>{selectedHubLabel}</strong>
              <small>{selectedHubJurisdictionLabel}</small>
            </span>
            <span class="entity-select-chevron" aria-hidden="true">⌄</span>
          </button>
          <select
            class="entity-select-native"
            value={createOrderAccountId}
            data-testid="swap-account-select"
            title={selectedHubDisplayLabel}
            aria-label="Swap venue"
            on:change={(event) => handleSelectedHubChange((event.currentTarget as HTMLSelectElement).value)}
          >
            {#each selectedHubOptions as hub (hub.value)}
              <option value={hub.value} title={formatEntityNetworkLabel(hub.label, hubJurisdictionLabel(hub.value))}>{formatEntityNetworkLabel(hub.label, hubJurisdictionLabel(hub.value))}</option>
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
                    <strong>{hub.label}</strong>
                    <small>{hubJurisdiction}</small>
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

      <div class="route-builder" class:cross-route={swapRouteMode === 'cross'} data-testid="swap-route-picker">
        <button type="button" class="route-summary" title={`${selectedRouteLabel} · ${routeVenueLabel}`} on:click={() => routeDetailsOpen = !routeDetailsOpen}>
          <span>Route</span>
          <strong>{selectedRouteLabel || 'Same account'}</strong>
          <em>{swapTokenPairLabel}</em>
        </button>
        <div class="route-flow" data-testid="swap-route-flow">
          <span title={`${sourceRouteEntityLabel} -> ${targetRouteEntityLabel}`}>{routePathLabel}</span>
          <em>via {routeVenueLabel}</em>
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
            <span>Venue/orderbook: {routeVenueLabel}</span>
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
      <div class="section section-market">
        <div class="book-toolbar">
          <div>
            <span>Orderbook</span>
            <strong>{baseTokenSymbol}/{quoteTokenSymbol}</strong>
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
            {#key orderbookViewKey}
              <OrderbookPanel
                hubIds={orderbookHubIds}
                hubId={activeBookHubId || selectedBookAccountId}
                pairId={orderbookPairId}
                pairLabel={`${baseTokenSymbol}/${quoteTokenSymbol}`}
                depth={orderbookDepth}
                showSources={true}
                sourceLabels={orderbookSourceLabels}
                sourceAvatars={orderbookSourceAvatars}
                compactHeader={true}
                showPriceStepControl={false}
                priceScale={Number(ORDERBOOK_PRICE_SCALE)}
                sizeDisplayScale={orderbookSizeDisplayScale}
                disablePriceAggregation={orderbookScopeMode === 'selected' || swapRouteMode === 'cross'}
                preferredClickSide={orderMode === 'buy-base' ? 'ask' : 'bid'}
                on:levelclick={handleOrderbookLevelClick}
                on:snapshot={handleOrderbookSnapshot}
              />
            {/key}
          </div>
        {:else}
          <div class="orderbook-empty">No connected account orderbooks yet.</div>
        {/if}
      </div>
    {/if}
  </div>

  <div class="section section-orders">
    <div class="orders-toolbar">
      <div class="orders-header-left">
        <h4 class="orders-inline-title">Orders</h4>
        <div class="orders-tabs" role="tablist" aria-label="Swap orders">
          <button
            type="button"
            class="orders-tab-text"
            class:active={orderListTab === 'open'}
            aria-pressed={orderListTab === 'open'}
            data-testid="swap-orders-tab-open"
            on:click={() => setOrderListTab('open')}
          >Open ({openOrders.length})</button>
          <button
            type="button"
            class="orders-tab-text"
            class:active={orderListTab === 'closed'}
            aria-pressed={orderListTab === 'closed'}
            data-testid="swap-orders-tab-closed"
            on:click={() => setOrderListTab('closed')}
          >Closed ({closedOrderViews.length})</button>
        </div>
      </div>
      <label class="closed-status-filter" class:is-hidden={orderListTab !== 'open'}>
        <span>Route</span>
        <select bind:value={orderRouteFilter} disabled={orderListTab !== 'open'} data-testid="swap-orders-route-filter">
          <option value="all">All</option>
          <option value="same">Same</option>
          <option value="cross">Cross-j</option>
        </select>
      </label>
      <label class="closed-status-filter" class:is-hidden={orderListTab !== 'closed'}>
        <span>Status</span>
        <select bind:value={closedOrderStatusFilter} disabled={orderListTab !== 'closed'}>
          <option value="all">All</option>
          <option value="filled">Filled</option>
          <option value="partial">Partial</option>
          <option value="canceled">Canceled</option>
          <option value="closed">Closed</option>
        </select>
      </label>
    </div>
    {#if orderListTab === 'closed' && totalPriceImprovementSummary}
      <p class="improvement-summary">Total price improvement: <strong>{totalPriceImprovementSummary}</strong></p>
    {/if}

    {#if orderListTab === 'open'}
      {#if openOrders.length === 0}
        <div class="orders-empty">No open orders yet.</div>
      {:else}
        <div class="orders-table-wrap">
          <table class="orders-table" data-testid="swap-open-orders">
            <thead>
              <tr>
                <th>Side</th>
                <th>Pair</th>
                <th>Price</th>
                <th>Remaining</th>
                <th>Price Improvement</th>
                <th>Hub</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {#each openOrders as offer (offerLifecycleKey(String(offer.accountId || ''), String(offer.offerId || '')))}
                {@const side = offerSideLabel(offer)}
                {@const pairView = resolvePairOrientation(offer.giveTokenId, offer.wantTokenId)}
                {@const isDust = isDustOpenOffer(offer)}
                {@const remainingUsd = remainingOfferUsd(offer)}
                {@const offerImprovement = offerPriceImprovementByKey.get(offerLifecycleKey(String(offer.accountId || ''), String(offer.offerId || ''))) || { amount: 0n, tokenId: null }}
                <tr data-testid="swap-open-order-row">
                  <td>
                    <span class:side-ask={side === 'Ask'} class:side-bid={side === 'Bid'} class="side-badge">{side}</span>
                  </td>
                  <td>
                    <span>{tokenSymbol(pairView.baseTokenId)}/{tokenSymbol(pairView.quoteTokenId)}</span>
                    {#if offer.crossJurisdiction}
                      <span class="route-badge">Cross-j</span>
                    {/if}
                  </td>
                  <td>{formatPriceTicks(offerPriceTicks(offer))}</td>
                  <td>
                    {#if isDust}
                      <div class="remaining-cell">
                        <span class="dust-label">Dust (&lt;${MIN_ORDER_NOTIONAL_USD})</span>
                        <span class="dust-amount">
                          {formatAmount(toBigIntSafe(offer.giveAmount) ?? 0n, Number(offer.giveTokenId || 0))} {tokenSymbol(Number(offer.giveTokenId || 0))}
                          {#if remainingUsd > 0}
                            · ~${remainingUsd.toFixed(2)}
                          {/if}
                        </span>
                      </div>
                    {:else}
                      {formatAmount(toBigIntSafe(offer.giveAmount) ?? 0n, Number(offer.giveTokenId || 0))} {tokenSymbol(Number(offer.giveTokenId || 0))}
                    {/if}
                    {#if offer.crossJurisdiction}
                      {@const route = offer.crossJurisdiction}
                      {@const pendingAmount = toBigIntSafe(route.filledSourceAmount ?? route.sourceClaimed ?? 0n) ?? 0n}
                      {@const settledAmount = String(route.status || '') === 'settled' ? pendingAmount : 0n}
                      <div class="cross-fill-meta">
                        <span>{String(route.status || 'resting').replace(/_/g, ' ')}</span>
                        <span>pending {formatAmount(pendingAmount, Number(offer.giveTokenId || 0))}</span>
                        <span>settled {formatAmount(settledAmount, Number(offer.giveTokenId || 0))}</span>
                      </div>
                    {/if}
                  </td>
                  <td>{formatPriceImprovement(offerImprovement.amount, offerImprovement.tokenId)}</td>
                  <td>{String(offer.accountId || '').slice(0, 10)}...</td>
                  <td>
                    {#if offer.crossJurisdiction}
                      <div class="cross-order-actions">
                        <button class="cancel-btn" data-testid="cross-swap-clear" on:click={() => requestCrossClear(String(offer.offerId || ''), true)}>
                          Clear + Close
                        </button>
                      </div>
                    {:else}
                      <button class="cancel-btn" data-testid="swap-open-order-cancel" on:click={() => cancelSwapOffer(String(offer.offerId || ''), String(offer.accountId || ''))}>
                        Request Cancel
                      </button>
                    {/if}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    {:else}
      {#if filteredClosedOrderViews.length === 0}
        <div class="orders-empty">No closed orders for selected filter.</div>
      {:else}
        <div class="orders-table-wrap">
          <table class="orders-table" data-testid="swap-closed-orders">
            <thead>
              <tr>
                <th>Status</th>
                <th>Pair</th>
                <th>Price</th>
                <th>Filled</th>
                <th>Price Improvement</th>
                <th>Closed At</th>
                <th>Hub</th>
              </tr>
            </thead>
            <tbody>
              {#each filteredClosedOrderViews as order (offerLifecycleKey(order.accountId, order.offerId))}
                {@const pairView = resolvePairOrientation(order.giveTokenId, order.wantTokenId)}
                <tr data-testid="swap-closed-order-row">
                  <td>
                    <span class:side-ask={closedOrderStatusTone(order.status) === 'ask'} class:side-bid={closedOrderStatusTone(order.status) === 'bid'} class="side-badge">
                      {closedOrderStatusLabel(order.status)}
                    </span>
                    {#if order.closeComment}
                      <div class="close-comment">{formatCloseComment(order.closeComment)}</div>
                    {/if}
                  </td>
                  <td>{order.pairLabel}</td>
                  <td>{formatPriceTicks(order.priceTicks)}</td>
                  <td>
                    {order.filledPercent.toFixed(2)}%
                    ({formatAmount(order.filledBaseAmount, pairView.baseTokenId)} {tokenSymbol(pairView.baseTokenId)})
                  </td>
                  <td>{formatPriceImprovement(order.priceImprovementAmount, order.priceImprovementTokenId)}</td>
                  <td>{formatOrderTime(order.closedAt)}</td>
                  <td>{order.accountId.slice(0, 10)}...</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    {/if}
  </div>

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
          <button class="scope-btn active" on:click={() => (swapCompletionModal = null)}>Close</button>
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .swap-panel {
    padding: 0;
    border-radius: 10px;
  }

  h3 {
    margin: 0 0 16px 0;
    color: #f3f4f6;
    font-size: 16px;
    font-weight: 700;
  }

  h4 {
    margin: 0 0 12px 0;
    color: #e5e7eb;
    font-size: 14px;
    font-weight: 600;
  }

  .section {
    margin-bottom: 0;
    padding: 12px;
    background: #131419;
    border-radius: 6px;
    border: 1px solid #1e2028;
  }

  .trade-grid {
    display: grid;
    grid-template-columns: minmax(340px, 620px);
    justify-content: center;
    gap: 12px;
    align-items: start;
  }

  .trade-grid.book-open {
    grid-template-columns: minmax(340px, 560px) minmax(420px, 1fr);
    justify-content: stretch;
    gap: 14px;
  }

  .trade-grid > .section {
    margin-bottom: 0;
    min-width: 0;
  }

  .section-market {
    height: auto;
    min-width: 0;
    max-width: 100%;
    overflow: visible;
  }

  .section-order {
    height: auto;
    min-width: 0;
    max-width: 100%;
    overflow: visible;
    background: #0a0c11;
    border-color: #242936;
    box-shadow: 0 14px 42px rgba(0, 0, 0, 0.22);
  }

  .section-orders {
    margin-top: 14px;
  }

  .close-comment {
    margin-top: 4px;
    color: #7c8597;
    font-size: 11px;
    line-height: 1.2;
  }

  .input-label {
    color: #6b7280;
    font-size: 12px;
    font-weight: 500;
    min-width: 48px;
    flex-shrink: 0;
  }

  .swap-mode-bar {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 10px;
    min-height: 32px;
    margin-bottom: 10px;
    color: #8b94a7;
    font-size: 11px;
    font-weight: 800;
    text-transform: uppercase;
  }

  .swap-mode-bar strong {
    min-width: 0;
    overflow: hidden;
    color: #f3f4f6;
    font-size: 12px;
    font-weight: 900;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-transform: none;
  }

  .book-toggle {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 72px;
    height: 28px;
    padding: 0 10px;
    border-radius: 7px;
    border: 1px solid #2b3040;
    background: #11141b;
    color: #a7afbd;
    font-size: 11px;
    font-weight: 800;
    cursor: pointer;
  }

  .book-toggle.active {
    border-color: rgba(251, 191, 36, 0.55);
    background: rgba(251, 191, 36, 0.12);
    color: #f8d36f;
  }

  .anyswap-builder {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 0;
    margin-bottom: 10px;
  }

  .swap-leg-card {
    display: grid;
    gap: 8px;
    padding: 12px;
    background: linear-gradient(180deg, #11141b 0%, #0d0f15 100%);
    border: 1px solid #252a36;
    border-radius: 8px;
  }

  .swap-leg-card:focus-within {
    border-color: rgba(251, 191, 36, 0.55);
    box-shadow: 0 0 0 1px rgba(251, 191, 36, 0.1);
  }

  .leg-header,
  .leg-main,
  .leg-meta,
  .venue-row,
  .quote-row {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .leg-header {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 10px;
    align-items: center;
  }

  .leg-header > span,
  .venue-row > span {
    color: #8b94a7;
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    line-height: 1.2;
  }

  .chain-select,
  .entity-select-native,
  .token-select-native,
  .venue-row select {
    min-width: 0;
    border: 1px solid #232631;
    border-radius: 7px;
    background: #090b10;
    color: #e5e7eb;
    font-size: 12px;
    font-weight: 700;
    color-scheme: dark;
    line-height: 1.25;
    text-overflow: ellipsis;
    white-space: nowrap;
    box-sizing: border-box;
  }

  .chain-select {
    width: 100%;
    max-width: none;
    min-width: 0;
    min-height: 34px;
    padding: 0 34px 0 10px;
    justify-self: end;
  }

  .entity-select-wrap {
    position: relative;
    min-width: 0;
    width: 100%;
  }

  .entity-select-button {
    display: grid;
    grid-template-columns: 32px minmax(0, 1fr) auto;
    align-items: center;
    gap: 9px;
    width: 100%;
    min-height: 42px;
    padding: 4px 10px 4px 7px;
    border: 1px solid #232631;
    border-radius: 8px;
    background: #090b10;
    color: #e5e7eb;
    box-sizing: border-box;
    cursor: pointer;
    text-align: left;
  }

  .entity-select-button:hover,
  .entity-option:hover {
    border-color: rgba(251, 191, 36, 0.45);
    background: #0c0f16;
  }

  .entity-avatar-wrap {
    position: relative;
    width: 30px;
    height: 30px;
    flex: 0 0 auto;
  }

  .entity-avatar-mini {
    width: 30px;
    height: 30px;
    border-radius: 8px;
    border: 1px solid rgba(255, 255, 255, 0.14);
    object-fit: cover;
    box-sizing: border-box;
  }

  .entity-avatar-mini.placeholder {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: #172033;
    color: #dbeafe;
    font-size: 10px;
    font-weight: 900;
  }

  .jurisdiction-mini-badge {
    position: absolute;
    right: -5px;
    bottom: -4px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 17px;
    height: 17px;
    padding: 0 3px;
    border-radius: 6px;
    border: 1px solid rgba(251, 191, 36, 0.45);
    background: #171107;
    color: #f8d36f;
    font-size: 8px;
    font-weight: 900;
    line-height: 1;
    box-sizing: border-box;
  }

  .entity-select-copy {
    display: grid;
    gap: 1px;
    min-width: 0;
  }

  .entity-select-copy strong,
  .entity-select-copy small {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .entity-select-copy strong {
    color: #f3f4f6;
    font-size: 13px;
    font-weight: 900;
    line-height: 1.15;
  }

  .entity-select-copy small {
    color: #8b94a7;
    font-size: 10px;
    font-weight: 700;
    line-height: 1.1;
  }

  .entity-select-chevron {
    color: #cbd5e1;
    font-size: 16px;
    line-height: 1;
  }

  .entity-select-native {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    opacity: 0;
    pointer-events: none;
  }

  .token-select-wrap {
    position: relative;
    width: 132px;
    min-width: 112px;
    min-height: 42px;
    box-sizing: border-box;
    flex-shrink: 0;
  }

  .token-select-button {
    display: grid;
    grid-template-columns: 24px minmax(48px, 1fr) auto;
    align-items: center;
    gap: 8px;
    width: 100%;
    min-height: 42px;
    padding: 0 10px;
    border: 1px solid #232631;
    border-radius: 7px;
    background: #090b10;
    color: #e5e7eb;
    box-sizing: border-box;
    cursor: pointer;
  }

  .token-select-button:hover,
  .route-menu-button:hover {
    border-color: rgba(251, 191, 36, 0.45);
    background: #0c0f16;
  }

  .token-dot {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    border: 1px solid rgba(255, 255, 255, 0.16);
    background: #1f2937;
    color: #f8fafc;
    font-size: 11px;
    font-weight: 900;
    line-height: 1;
  }

  .token-usdc {
    background: #2563eb;
  }

  .token-usdt {
    background: #059669;
  }

  .token-weth,
  .token-eth {
    background: #64748b;
  }

  .token-select-visible,
  .token-option span:last-child {
    min-width: 0;
    overflow: hidden;
    color: #e5e7eb;
    font-size: 13px;
    font-weight: 900;
    line-height: 1.2;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .token-select-chevron {
    color: #cbd5e1;
    font-size: 16px;
    line-height: 1;
    pointer-events: none;
  }

  .token-select-native {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    opacity: 0;
    pointer-events: none;
  }

  .token-select-wrap:focus-within .token-select-button {
    border-color: rgba(251, 191, 36, 0.65);
  }

  .entity-menu,
  .token-menu,
  .route-menu {
    position: absolute;
    z-index: 40;
    right: 0;
    top: calc(100% + 6px);
    display: grid;
    gap: 4px;
    padding: 6px;
    border: 1px solid rgba(255, 255, 255, 0.14);
    border-radius: 12px;
    background: rgba(18, 19, 24, 0.98);
    box-shadow: 0 18px 42px rgba(0, 0, 0, 0.42);
  }

  .token-menu {
    min-width: 150px;
  }

  .entity-menu {
    left: 0;
    right: 0;
  }

  .hub-menu {
    top: calc(100% + 6px);
  }

  .entity-option,
  .token-option,
  .route-option {
    border: 0;
    border-radius: 9px;
    background: transparent;
    color: #e5e7eb;
    cursor: pointer;
    text-align: left;
  }

  .entity-option {
    display: grid;
    grid-template-columns: 32px minmax(0, 1fr);
    gap: 10px;
    align-items: center;
    min-height: 46px;
    padding: 7px 9px;
    border: 1px solid transparent;
  }

  .entity-option.selected {
    border-color: rgba(251, 191, 36, 0.28);
    background: rgba(251, 191, 36, 0.12);
  }

  .token-option {
    display: grid;
    grid-template-columns: 24px minmax(0, 1fr);
    align-items: center;
    gap: 10px;
    min-height: 40px;
    padding: 0 10px;
    font-size: 13px;
    font-weight: 900;
  }

  .token-option:hover,
  .route-option:hover {
    background: rgba(255, 255, 255, 0.07);
  }

  .token-option.selected,
  .route-option.selected {
    background: rgba(251, 191, 36, 0.14);
    color: #fde68a;
  }

  .route-select-wrap {
    position: relative;
    min-width: 0;
  }

  .route-menu-button {
    display: grid;
    grid-template-columns: 30px minmax(0, 1fr) auto;
    gap: 8px;
    align-items: center;
    text-align: left;
  }

  .route-menu-button > span:not(.route-glyph) {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-transform: none;
  }

  .route-menu-button em {
    color: #cbd5e1;
    font-style: normal;
  }

  .route-select-native {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    opacity: 0;
    pointer-events: none;
  }

  .route-menu {
    left: 0;
    right: 0;
  }

  .route-option {
    display: grid;
    grid-template-columns: 30px minmax(0, 1fr);
    gap: 10px;
    align-items: center;
    min-height: 44px;
    padding: 8px 10px;
  }

  .route-option.disabled {
    opacity: 0.52;
    cursor: not-allowed;
  }

  .route-glyph {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    color: #93c5fd;
  }

  .route-node {
    position: absolute;
    width: 20px;
    height: 20px;
    border-radius: 7px;
    border: 1px solid rgba(96, 165, 250, 0.38);
    background: rgba(96, 165, 250, 0.11);
    box-sizing: border-box;
  }

  .route-glyph.same .route-node-a {
    left: 4px;
    top: 4px;
  }

  .route-glyph.cross .route-node-a {
    left: 1px;
    top: 5px;
  }

  .route-glyph.cross .route-node-b {
    right: 1px;
    top: 5px;
    border-color: rgba(251, 191, 36, 0.42);
    background: rgba(251, 191, 36, 0.12);
  }

  .route-arrows {
    position: relative;
    z-index: 1;
    color: #dbeafe;
    font-size: 13px;
    font-weight: 900;
    line-height: 1;
  }

  .route-option-copy {
    display: grid;
    gap: 2px;
    min-width: 0;
    text-transform: none;
  }

  .route-option-copy strong,
  .route-option-copy small {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .route-option-copy strong {
    color: #e5e7eb;
    font-size: 13px;
    font-weight: 900;
  }

  .route-option-copy small {
    color: #8b94a7;
    font-size: 11px;
  }

  .leg-main input {
    flex: 1;
    min-width: 0;
    height: 48px;
    padding: 0;
    border: none;
    background: transparent;
    color: #f3f4f6;
    font-size: 26px;
    font-weight: 800;
    text-align: left;
  }

  .leg-main input:focus {
    outline: none;
  }

  .leg-main .receive-amount {
    color: #9ca3af;
  }

  .leg-meta {
    justify-content: space-between;
    color: #7c8597;
    font-size: 11px;
    min-height: 16px;
  }

  .leg-meta span,
  .leg-meta strong {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .leg-meta strong {
    color: #d1d5db;
    font-weight: 700;
    text-align: right;
  }

  .swap-leg-divider {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-height: 36px;
    margin: -4px 0;
    position: relative;
    z-index: 1;
  }

  .direction-chip {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: 28px;
    border-radius: 7px;
    border: 1px solid #252936;
    background: #10131a;
    color: #a7afbd;
    font-size: 11px;
    font-weight: 800;
    cursor: pointer;
  }

  .direction-chip {
    width: 34px;
    color: #fbbf24;
    background: #171b24;
    border-color: rgba(251, 191, 36, 0.35);
  }

  .quote-row,
  .venue-row {
    min-height: 36px;
    padding: 0 10px;
    margin-bottom: 8px;
    background: #0d0f15;
    border: 1px solid #202431;
    border-radius: 8px;
    box-sizing: border-box;
  }

  .quote-row input {
    flex: 1;
    min-width: 0;
    height: 100%;
    border: none;
    background: transparent;
    color: #e5e7eb;
    text-align: right;
    font-size: 14px;
    font-weight: 700;
  }

  .quote-row input:focus {
    outline: none;
  }

  .venue-row {
    display: grid;
    grid-template-columns: minmax(80px, auto) minmax(0, 1fr);
    justify-content: stretch;
  }

  .venue-row select {
    width: 100%;
    max-width: none;
    min-width: 0;
    min-height: 42px;
    padding: 0 34px 0 10px;
  }

  .input-suffix {
    color: #6b7280;
    font-size: 12px;
    font-weight: 600;
    flex-shrink: 0;
    min-width: 40px;
    text-align: right;
  }

  .input-steppers {
    display: flex;
    flex-direction: column;
    margin-left: 4px;
    flex-shrink: 0;
  }

  .market-strip {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(120px, auto);
    align-items: center;
    gap: 8px;
    min-width: 0;
    margin-bottom: 8px;
  }

  .market-price-btn {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    align-items: center;
    gap: 8px;
    min-width: 0;
    min-height: 34px;
    padding: 0 10px;
    border-radius: 8px;
    border: 1px solid rgba(251, 191, 36, 0.28);
    background: rgba(251, 191, 36, 0.08);
    color: #f3f4f6;
    cursor: pointer;
  }

  .market-price-btn:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

  .market-price-btn span {
    color: #9ca3af;
    font-size: 11px;
    font-weight: 800;
    text-transform: uppercase;
  }

  .market-price-btn strong,
  .book-owner-label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .market-price-btn strong {
    color: #f8d36f;
    font-size: 12px;
    font-weight: 900;
    text-align: right;
  }

  .book-owner-label {
    color: #7c8597;
    font-size: 11px;
    font-weight: 700;
    text-align: right;
  }

  .book-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    min-height: 32px;
    margin-bottom: 8px;
  }

  .book-toolbar div {
    display: grid;
    min-width: 0;
    gap: 2px;
  }

  .book-toolbar span {
    color: #7c8597;
    font-size: 10px;
    font-weight: 800;
    text-transform: uppercase;
  }

  .book-toolbar strong {
    min-width: 0;
    overflow: hidden;
    color: #f3f4f6;
    font-size: 13px;
    font-weight: 900;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .route-builder {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 7px;
    margin-bottom: 10px;
    padding: 8px;
    background: #0d0f15;
    border: 1px solid #202431;
    border-radius: 8px;
  }

  .route-builder.cross-route {
    border-color: rgba(96, 165, 250, 0.28);
  }

  .route-summary {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 8px;
    min-height: 30px;
    padding: 0;
    background: transparent;
    border: none;
    border-radius: 0;
    color: #d1d5db;
    text-align: left;
  }

  .route-summary span {
    color: #7c8597;
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
  }

  .route-summary strong,
  .route-summary em {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12px;
  }

  .route-summary em {
    color: #9ca3af;
    font-style: normal;
    text-align: right;
  }

  .route-select-row {
    display: grid;
    grid-template-columns: minmax(120px, auto) minmax(0, 1fr);
    align-items: center;
    gap: 8px;
    padding: 0 10px;
    min-height: 36px;
    background: #090b10;
    border: 1px solid #202431;
    border-radius: 8px;
    box-sizing: border-box;
  }

  .route-select-row span {
    color: #7c8597;
    font-size: 12px;
    font-weight: 600;
  }

  .route-select {
    width: 100%;
    min-height: 38px;
    min-width: 0;
    padding: 0 34px 0 12px;
    color: #d1d5db;
    background: #080a0f;
    border: 1px solid #232631;
    border-radius: 7px;
    font-size: 12px;
    box-sizing: border-box;
    color-scheme: dark;
  }

  .entity-select-native option,
  .token-select-native option,
  .route-select-native option,
  .venue-row select option,
  .route-select option {
    background: #0f1117;
    color: #f3f4f6;
  }

  .route-flow {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: 7px;
    min-height: 30px;
    padding: 0 10px;
    background: #090b10;
    border: 1px solid #1d2230;
    border-radius: 8px;
  }

  .route-flow span,
  .route-flow em {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .route-flow span {
    color: #9ca3af;
    font-size: 11px;
    font-weight: 700;
  }

  .route-flow em {
    color: #fbbf24;
    font-size: 11px;
    font-style: normal;
    font-weight: 700;
    text-align: right;
  }

  .route-checkbox {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    color: #9ca3af;
    font-size: 12px;
    min-height: 24px;
  }

  .route-checkbox input {
    width: 14px;
    height: 14px;
    margin: 0;
    accent-color: #fbbf24;
  }

  .route-details {
    display: grid;
    gap: 4px;
    padding: 8px 10px;
    background: #0c0d12;
    border: 1px solid #1e2028;
    border-radius: 6px;
    color: #8b94a7;
    font-size: 11px;
  }

  .secondary-setup-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 34px;
    margin-top: 8px;
    border-radius: 7px;
    border: 1px solid rgba(251, 191, 36, 0.35);
    background: rgba(251, 191, 36, 0.12);
    color: #fde68a;
    font-size: 12px;
    font-weight: 800;
  }

  .step-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 18px;
    padding: 0;
    border: 1px solid #1e2028 !important;
    background: #181a20 !important;
    color: #6b7280;
    font-size: 8px;
    line-height: 1;
    cursor: pointer;
    user-select: none;
  }

  .step-btn:first-child {
    border-radius: 3px 3px 0 0;
    border-bottom: none;
  }

  .step-btn:last-child {
    border-radius: 0 0 3px 3px;
  }

  .step-btn:hover {
    color: #f3f4f6;
    background: #252830 !important;
  }

  .step-btn:active {
    background: #353842 !important;
  }

  .size-slider-row {
    position: relative;
    margin-bottom: 10px;
    width: 100%;
    min-width: 0;
    max-width: 100%;
    padding: 6px 0 0;
    box-sizing: border-box;
  }

  .diamond-slider {
    width: 100%;
    min-width: 0;
    max-width: 100%;
    cursor: pointer;
    margin: 0;
  }

  .slider-marks {
    display: flex;
    justify-content: space-between;
    margin-top: 4px;
    pointer-events: none;
    padding: 0 calc(var(--xln-slider-thumb-size, 14px) / 2);
    min-width: 0;
    max-width: 100%;
    box-sizing: border-box;
  }

  .slider-mark-group {
    display: flex;
    flex-direction: column;
    align-items: center;
    cursor: pointer;
    pointer-events: auto;
    user-select: none;
    gap: 1px;
  }

  .slider-diamond {
    font-size: 9px;
    color: #353942;
    line-height: 1;
    transition: color 100ms;
  }

  .slider-pct {
    font-size: 8px;
    color: #4b5563;
    line-height: 1;
    transition: color 100ms;
  }

  .slider-mark-group.filled .slider-diamond {
    color: #fbbf24;
  }

  .slider-mark-group.filled .slider-pct {
    color: #fbbf24;
  }

  .avbl-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 12px;
    color: #6b7280;
    margin-bottom: 10px;
    padding: 0 2px;
    gap: 10px;
  }

  .avbl-row strong {
    color: #d1d5db;
  }

  .capacity-warn {
    min-width: 0;
    overflow: hidden;
    color: #f59e0b;
    font-size: 11px;
    text-align: right;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .route-badge {
    display: inline-flex;
    align-items: center;
    height: 18px;
    margin-left: 6px;
    padding: 0 6px;
    border-radius: 999px;
    border: 1px solid rgba(96, 165, 250, 0.35);
    background: rgba(59, 130, 246, 0.1);
    color: #93c5fd;
    font-size: 10px;
    font-weight: 700;
    vertical-align: middle;
  }

  .cross-fill-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 4px;
    color: #8b93a5;
    font-size: 10px;
    text-transform: capitalize;
  }

  .scope-btn {
    padding: 0 12px;
    border-radius: 8px;
    border: 1px solid #353942;
    background: #111217;
    color: #9ca3af;
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
  }

  .scope-btn.active {
    color: #fbbf24;
    border-color: #fbbf24;
    background: rgba(251, 191, 36, 0.08);
  }

  .scope-btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .orderbook-empty {
    border: 1px dashed #3f434d;
    border-radius: 8px;
    padding: 10px 12px;
    color: #9ca3af;
    font-size: 12px;
  }

  select, input:not([type="range"]):not([type="checkbox"]) {
    padding: 8px;
    width: 100%;
    min-width: 0;
    box-sizing: border-box;
    background: #0c0d11;
    border: 1px solid #303442;
    border-radius: 8px;
    color: #f3f4f6;
    font-size: 13px;
    font-family: 'JetBrains Mono', monospace;
  }

  select {
    color-scheme: dark;
  }

  select option {
    background: #0f1117;
    color: #f3f4f6;
  }

  select:focus, input:not([type="range"]):not([type="checkbox"]):focus {
    outline: none;
    border-color: rgba(251, 191, 36, 0.65);
  }



  .readonly-input {
    color: #9ca3af;
    cursor: default;
  }

  .primary-btn {
    width: 100%;
    min-height: 44px;
    padding: 0 12px;
    background: linear-gradient(180deg, rgba(251, 191, 36, 0.18), rgba(217, 119, 6, 0.12)) !important;
    border: 1px solid rgba(251, 191, 36, 0.55) !important;
    border-radius: 8px;
    color: #fde68a;
    font-size: 14px;
    font-weight: 900;
    cursor: pointer;
    transition: all 0.2s;
  }

  .primary-btn.buy-action {
    background: #16a34a !important;
    border-color: #16a34a !important;
    color: #fff;
  }

  .primary-btn.buy-action:hover {
    background: #15803d !important;
  }

  .primary-btn.sell-action {
    background: #dc2626 !important;
    border-color: #dc2626 !important;
    color: #fff;
  }

  .primary-btn.sell-action:hover {
    background: #b91c1c !important;
  }

  .primary-btn:disabled {
    opacity: 0.48;
    cursor: not-allowed;
  }




  .size-hint {
    margin: 8px 0 0;
    color: #9ca3af;
    font-size: 11px;
    line-height: 1.4;
  }

  .form-error {
    margin: 8px 0 0;
    color: #fda4af;
    font-size: 12px;
    line-height: 1.4;
    font-weight: 600;
  }

  .auto-capacity-note {
    margin: 8px 0;
    padding: 8px 10px;
    color: #a7f3d0;
    background: rgba(34, 197, 94, 0.08);
    border: 1px solid rgba(34, 197, 94, 0.18);
    border-radius: 8px;
    font-size: 12px;
    line-height: 1.4;
  }

  .orders-toolbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 10px;
    margin-bottom: 6px;
    flex-wrap: wrap;
  }

  .orders-header-left {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .orders-inline-title {
    font-size: 13px;
    font-weight: 600;
    color: #e5e7eb;
    margin: 0;
  }

  .orders-tabs {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 3px;
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 10px;
    background: rgba(255, 255, 255, 0.02);
  }

  .orders-tab-text {
    min-width: 58px;
    min-height: 30px;
    padding: 0 12px;
    border: 1px solid transparent;
    border-radius: 8px;
    background: transparent;
    font-size: 12px;
    color: #6b7280;
    cursor: pointer;
    user-select: none;
    transition: color 100ms, border-color 100ms, background 100ms;
  }

  .orders-tab-text:hover {
    color: #d1d5db;
  }

  .orders-tab-text.active {
    color: #e5e7eb;
    border-color: rgba(251, 191, 36, 0.22);
    background: rgba(251, 191, 36, 0.08);
  }

  .closed-status-filter {
    display: inline-flex;
    flex-direction: column;
    gap: 4px;
    color: #9ca3af;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    min-width: 148px;
    transition: opacity 120ms ease;
  }

  .closed-status-filter.is-hidden {
    display: none;
  }

  .closed-status-filter select {
    min-width: 180px;
    height: 34px;
    border-radius: 10px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: #111217;
    color: #f3f4f6;
    font-family: inherit;
    font-size: 12px;
    font-weight: 600;
    padding: 0 10px;
    color-scheme: dark;
  }

  @media (max-width: 720px) {
    .leg-header {
      grid-template-columns: minmax(0, 1fr);
      align-items: stretch;
    }

    .chain-select,
    .venue-row select,
    .route-select {
      min-width: 0;
      width: 100%;
    }

    .venue-row {
      align-items: stretch;
      flex-direction: column;
      padding: 8px 10px;
    }
  }

  .orders-empty {
    border: 1px dashed #3f434d;
    border-radius: 8px;
    padding: 10px 12px;
    color: #9ca3af;
    font-size: 12px;
  }

  .remaining-cell {
    display: inline-flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
  }

  .dust-label {
    color: #fbbf24;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .dust-amount {
    color: #a1a1aa;
    font-size: 12px;
  }

  .orders-table-wrap {
    overflow: auto;
  }

  .orders-table {
    width: 100%;
    border-collapse: collapse;
    min-width: 680px;
  }

  .orders-table th {
    text-align: left;
    font-size: 11px;
    color: #9ca3af;
    font-weight: 600;
    padding: 8px;
    border-bottom: 1px solid #2b2f39;
  }

  .orders-table td {
    padding: 8px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    color: #e5e7eb;
    font-size: 12px;
    font-family: 'JetBrains Mono', monospace;
  }

  .side-badge {
    border-radius: 999px;
    padding: 2px 8px;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.03em;
    border: 1px solid #4b5563;
    color: #d1d5db;
    background: rgba(75, 85, 99, 0.12);
  }

  .side-ask {
    background: rgba(239, 68, 68, 0.16);
    color: #fca5a5;
    border: 1px solid rgba(239, 68, 68, 0.35);
  }

  .side-bid {
    background: rgba(34, 197, 94, 0.16);
    color: #86efac;
    border: 1px solid rgba(34, 197, 94, 0.35);
  }

  .orderbook-wrap :global(.orderbook-panel) {
    width: 100%;
    min-width: 0;
  }

  .cancel-btn {
    padding: 4px 8px;
    background: rgba(239, 68, 68, 0.12);
    border: 1px solid rgba(239, 68, 68, 0.4);
    border-radius: 6px;
    color: #fca5a5;
    font-size: 11px;
    cursor: pointer;
    transition: all 0.2s;
  }

  .cancel-btn:hover {
    background: rgba(239, 68, 68, 0.18);
    border-color: rgba(239, 68, 68, 0.6);
  }

  .cross-order-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    justify-content: flex-end;
  }

  .cross-order-actions .cancel-btn:first-child {
    background: rgba(34, 197, 94, 0.1);
    border-color: rgba(34, 197, 94, 0.35);
    color: #86efac;
  }

  .improvement-summary {
    margin: 0 0 12px;
    color: #c7b27a;
    font-size: 12px;
  }

  .improvement-summary strong {
    color: #f3d17a;
    font-weight: 700;
  }

  .swap-modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(6, 8, 12, 0.78);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
    z-index: 50;
    backdrop-filter: blur(8px);
  }

  .swap-modal {
    width: min(420px, 100%);
    border-radius: 16px;
    border: 1px solid rgba(243, 209, 122, 0.24);
    background:
      radial-gradient(circle at top, rgba(243, 209, 122, 0.14), transparent 45%),
      #121317;
    box-shadow: 0 18px 60px rgba(0, 0, 0, 0.38);
    padding: 20px;
  }

  .swap-modal-kicker {
    color: #f3d17a;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    font-size: 11px;
    font-weight: 700;
    margin-bottom: 8px;
  }

  .swap-modal-copy,
  .swap-modal-improvement {
    margin: 0;
    color: #d7d9df;
    font-size: 13px;
    line-height: 1.5;
  }

  .swap-modal-improvement {
    margin-top: 10px;
    color: #c7b27a;
  }

  .swap-modal-actions {
    margin-top: 18px;
    display: flex;
    justify-content: flex-end;
  }

  @media (max-width: 1100px) {
    .trade-grid {
      grid-template-columns: 1fr;
      gap: 12px;
    }

    .section-orders {
      margin-top: 6px;
    }
  }

  @media (max-width: 720px) {
    .leg-header,
    .route-select-row {
      grid-template-columns: 1fr;
      align-items: stretch;
    }

    .chain-select,
    .route-select,
    .venue-row select {
      width: 100%;
    }

    .leg-main {
      flex-wrap: wrap;
    }

    .token-select-wrap {
      flex: 1 1 120px;
      width: auto;
    }

    .route-flow {
      grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
    }

    .route-flow em {
      grid-column: 1 / -1;
      text-align: left;
    }
  }

</style>
