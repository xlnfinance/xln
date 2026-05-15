  <script lang="ts">
    import type { AccountMachine, EntityReplica, Tab } from '$lib/types/ui';
  import type { CrossJurisdictionSwapRoute, Delta, EntityState, Env, EnvSnapshot, RoutedEntityInput } from '@xln/runtime/xln-api';
  import { getBestAsk, getBestBid } from '@xln/runtime/xln-api';
  import type { Profile as GossipProfile } from '@xln/runtime/xln-api';
  import type { SwapBookEntry } from '@xln/runtime/xln-api';
  import { enqueueEntityInputs, xlnFunctions } from '../../stores/xlnStore';
  import { toasts } from '../../stores/toastStore';
  import { requireSignerIdForEntity } from '$lib/utils/entityReplica';
  import { amountToUsd } from '$lib/utils/assetPricing';
  import OrderbookPanel from '../Trading/OrderbookPanel.svelte';
  import SwapPairToolbar from './SwapPairToolbar.svelte';
  import { resolveEntityName } from '$lib/utils/entityNaming';
  import { formatEntityId } from '$lib/utils/format';

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
  function decimalPlacesFromScale(scale: bigint): number {
    const s = scale.toString();
    return /^10*$/.test(s) ? Math.max(0, s.length - 1) : 0;
  }
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
  let selectedPairValue = '';
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
  let selectedSourceEntityValue = '';
  let routeDetailsOpen = false;
  let crossTargetInCapacity = 0n;
  let crossAutoInboundCreditTarget: bigint | null = null;
  let crossCurrentPeerCreditLimit = 0n;
  let canAutoPrepareCrossInboundCapacity = false;
  const MIN_ORDER_NOTIONAL_USD = 10;
  const FILLED_DISPLAY_PPM_THRESHOLD = 999_950n;

    $: activeXlnFunctions = $xlnFunctions;
    $: activeFrame = env;
    $: runtimeEnv = isRuntimeEnv(activeFrame) ? activeFrame : null;
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
  $: orderbookHubIds = orderbookScopeMode === 'aggregated'
    ? hubAccountIds
    : (selectedBookAccountId ? [selectedBookAccountId] : []);
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
  $: selectedHubOptions = hubAccountIds.map((id) => ({ value: id, label: accountLabel(id) }));
  $: crossTargetOptions = buildCrossTargetOptions(activeFrame, sourceEntityIdValue, currentReplica);
  $: routeOptions = buildRouteOptions(sourceEntityIdValue, currentReplica, activeOrderAccountId, crossTargetOptions);
  $: if (!routeOptions.some((option) => option.value === selectedRouteValue)) {
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
  $: routeVenueLabel = activeOrderAccountId ? accountLabel(activeOrderAccountId) : 'Select venue';
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
    hasTargetAccount: boolean;
  };
  type SourceEntityOption = {
    value: string;
    label: string;
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
    targetLabel: string;
    disabled?: boolean;
  };
  type OfferLike = {
    giveTokenId: number;
    wantTokenId: number;
    giveAmount?: bigint;
    wantAmount?: bigint;
    priceTicks?: bigint;
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
        return {
          value: entityId,
          label: `${jurisdiction} · ${accountLabel(entityId)}`,
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
    if (!sourceEntityId || !sourceJurisdiction) return [];
    const options: CrossTargetOption[] = [];
    for (const candidate of localEntityReplicas(frame)) {
      const targetEntityId = String(candidate.entityId || candidate.state?.entityId || '').trim().toLowerCase();
      if (!targetEntityId || targetEntityId === sourceEntityId) continue;
      const targetJurisdiction = getReplicaJurisdictionName(candidate);
      if (!targetJurisdiction || targetJurisdiction === sourceJurisdiction) continue;
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
    const sourceHubEntityId = String(selectedHubEntityId || '').trim().toLowerCase();
    const sameLabel = sourceHubEntityId
      ? `${sourceJurisdiction} · ${accountLabel(sourceHubEntityId)}`
      : `${sourceJurisdiction} · select hub`;
    const options: SwapRouteOption[] = [{
      value: 'same',
      label: `Same account · ${sameLabel}`,
      mode: 'same',
      sourceJurisdiction,
      targetJurisdiction: sourceJurisdiction,
      sourceEntityId,
      sourceHubEntityId,
      targetEntityId: sourceEntityId,
      targetHubEntityId: sourceHubEntityId,
      targetLabel: sameLabel,
    }];

    for (const target of targets) {
      options.push({
        value: target.value,
        label: `Cross-j · ${sourceJurisdiction} -> ${target.targetJurisdiction} · ${accountLabel(target.targetHubEntityId)}`,
        mode: 'cross',
        sourceJurisdiction,
        targetJurisdiction: target.targetJurisdiction,
        sourceEntityId,
        sourceHubEntityId,
        targetEntityId: target.targetEntityId,
        targetHubEntityId: target.targetHubEntityId,
        targetLabel: target.label,
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
    .sort((a, b) => tokenSymbol(a).localeCompare(tokenSymbol(b)))
    .map((tokenId) => ({ tokenId, symbol: tokenSymbol(tokenId) }));
  $: if (pairOptions.length > 0) {
    const hasSelected = pairOptions.some((option) => option.value === selectedPairValue);
    if (!hasSelected) {
      selectedPairValue = pairOptions[0]!.value;
    }
  }
  $: selectedPair = pairOptions.find((option) => option.value === selectedPairValue) || null;

  function setTradeSide(next: 'buy-base' | 'sell-base'): void {
    tradeSide = next;
    selectedOrderLevel = null;
  }

  function setSwapTokens(nextGiveToken: number, nextWantToken: number): void {
    if (!Number.isFinite(nextGiveToken) || !Number.isFinite(nextWantToken)) return;
    if (nextGiveToken <= 0 || nextWantToken <= 0 || nextGiveToken === nextWantToken) {
      giveTokenId = String(nextGiveToken || '');
      wantTokenId = String(nextWantToken || '');
      selectedOrderLevel = null;
      submitError = '';
      return;
    }
    const oriented = resolvePairOrientation(nextGiveToken, nextWantToken);
    const pairValue = `${oriented.baseTokenId}/${oriented.quoteTokenId}`;
    if (pairOptions.some((option) => option.value === pairValue)) {
      selectedPairValue = pairValue;
    }
    tradeSide = nextGiveToken === oriented.baseTokenId ? 'sell-base' : 'buy-base';
    giveTokenId = String(nextGiveToken);
    wantTokenId = String(nextWantToken);
    selectedOrderLevel = null;
    submitError = '';
  }

  function handleSourceEntityChange(event: Event): void {
    selectedSourceEntityValue = String((event.currentTarget as HTMLSelectElement | null)?.value || '');
    selectedOrderLevel = null;
    submitError = '';
  }

  function handleGiveTokenChange(event: Event): void {
    const nextGive = Number.parseInt(String((event.currentTarget as HTMLSelectElement | null)?.value || ''), 10);
    setSwapTokens(nextGive, wantToken);
  }

  function handleWantTokenChange(event: Event): void {
    const nextWant = Number.parseInt(String((event.currentTarget as HTMLSelectElement | null)?.value || ''), 10);
    setSwapTokens(giveToken, nextWant);
  }

  $: if (selectedPair) {
    if (tradeSide === 'buy-base') {
      giveTokenId = String(selectedPair.quoteTokenId);
      wantTokenId = String(selectedPair.baseTokenId);
    } else {
      giveTokenId = String(selectedPair.baseTokenId);
      wantTokenId = String(selectedPair.quoteTokenId);
    }
  }

  $: giveToken = Number.parseInt(giveTokenId, 10);
  $: wantToken = Number.parseInt(wantTokenId, 10);
  $: orderbookPairId = selectedPair?.pairId || '1/2';

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

  function parseDecimalAmountToBigInt(raw: string, decimals: number): bigint {
    const trimmed = String(raw || '').trim();
    if (!trimmed) return 0n;
    if (!/^\d+(\.\d+)?$/.test(trimmed)) return 0n;
    const [wholeRaw, fracRaw = ''] = trimmed.split('.');
    const whole = BigInt(wholeRaw || '0');
    const scale = 10n ** BigInt(Math.max(0, Math.floor(decimals || 0)));
    const fracPadded = (fracRaw + '0'.repeat(Math.max(0, decimals))).slice(0, Math.max(0, decimals));
    const frac = fracPadded ? BigInt(fracPadded) : 0n;
    return whole * scale + frac;
  }

  function normalizeDecimalInput(raw: string, maxDecimals: number): string {
    const prepared = String(raw || '').replace(',', '.').replace(/[^\d.]/g, '');
    if (!prepared) return '';
    const dotIndex = prepared.indexOf('.');
    const hasDot = dotIndex >= 0;
    const wholeRaw = hasDot ? prepared.slice(0, dotIndex) : prepared;
    const fracRaw = hasDot ? prepared.slice(dotIndex + 1).replace(/\./g, '') : '';
    const whole = wholeRaw === '' ? '0' : wholeRaw.replace(/^0+(?=\d)/, '');
    const frac = fracRaw.slice(0, Math.max(0, maxDecimals));
    if (hasDot) return `${whole}.${frac}`;
    return whole;
  }

  function compareStableText(left: string, right: string): number {
    if (left === right) return 0;
    return left < right ? -1 : 1;
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
    if (String(orderbookSnapshot?.pairId || '').trim() === String(orderbookPairId || '').trim()) {
      const level = tradeSide === 'buy-base' ? orderbookSnapshot.asks?.[0] : orderbookSnapshot.bids?.[0];
      const price = level?.price ?? 0n;
      if (price > 0n) return price;
    }
    const bookSide: BookSide = tradeSide === 'buy-base' ? 'ask' : 'bid';
    return readCurrentHubBestPriceTicks(bookSide, activeOrderAccountId);
  }

  function readCurrentHubPairBook(hubEntityId: string): any | null {
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
  ): string {
    if (!target) return 'Select target jurisdiction account.';
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
      return `Insufficient source outbound capacity (${input.formattedAvailableGive}).`;
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
  $: crossAutoCapacityNote = (() => {
    if (swapRouteMode !== 'cross' || !selectedCrossTarget || !canAutoPrepareCrossInboundCapacity) return '';
    const targetLabel = formatAmount(crossAutoInboundCreditTarget ?? 0n, wantToken);
    const increase = (crossAutoInboundCreditTarget ?? 0n) > crossCurrentPeerCreditLimit
      ? (crossAutoInboundCreditTarget ?? 0n) - crossCurrentPeerCreditLimit
      : 0n;
    const increaseLabel = formatAmount(increase, wantToken);
    return `Target side needs inbound capacity. I will extend ${wantTokenSymbol} to ${targetLabel} on ${selectedCrossTarget.targetJurisdiction} before registering the cross-j route (+${increaseLabel}).`;
  })();
  $: leftoverGiveNote = giveAmountLeftover > 0n
    ? `Canonical order leaves ${leftoverGiveLabel} unspent after lot quantization.`
    : '';
  $: capacityWarning = (() => {
    if (!activeOrderAccountId || !Number.isFinite(giveToken) || giveToken <= 0) return '';
    if (availableGiveCapacity <= 0n) return `Observed available ${giveTokenSymbol}: 0 (may update after next frame).`;
    if (giveAmount > 0n && giveAmount > availableGiveCapacity) {
      return `Give amount is above observed available capacity (${formattedAvailableGive}).`;
    }
    return '';
  })();
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
    const selectedLevelAccountId =
      createOrderAccountId
      || selectedBookAccountId
      || selectedOrderLevel.accountIds[0]
      || '';
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

  function handleOrderPercentInput(event: Event) {
    const target = event.currentTarget as HTMLInputElement | null;
    const value = Number.parseInt(String(target?.value || ''), 10);
    applyOrderPercent(Number.isFinite(value) ? value : 0);
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
  }

  function handlePairChange(): void {
    selectedOrderLevel = null;
    submitError = '';
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
    const pair = selectedPair;
    if (!pair) {
      submitError = 'Select valid token pair first.';
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
    const clickedAccountId = orderbookScopeMode === 'aggregated'
      ? String(availableAccountIds.find((id) => hubAccountIds.includes(id)) || activeOrderAccountId || '')
      : String(selectedBookAccountId || availableAccountIds.find((id) => hubAccountIds.includes(id)) || '');
    if (!clickedAccountId) {
      submitError = 'Pick a priced level from a connected account.';
      return;
    }
    if (orderbookScopeMode === 'aggregated') {
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
    if (tradeSide === 'buy-base') {
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

  function isRuntimeEnv(value: unknown): value is Env {
    if (!value || typeof value !== 'object') return false;
    const obj = value as { eReplicas?: unknown; jReplicas?: unknown };
    return obj.eReplicas instanceof Map && obj.jReplicas instanceof Map;
  }

  function toBigIntSafe(value: unknown): bigint | null {
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)) return BigInt(value);
    if (typeof value === 'string' && /^\d+$/.test(value.trim())) return BigInt(value.trim());
    return null;
  }

  $: parsedOrderbookPair = selectedPair
    ? { baseTokenId: selectedPair.baseTokenId, quoteTokenId: selectedPair.quoteTokenId }
    : null;
  $: orderMode = parsedOrderbookPair ? tradeSide : 'none';
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
      if (giveToken === wantToken && swapRouteMode !== 'cross') {
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

      const offerId = `swap-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
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
      const now = Date.now();
      const crossJurisdiction = (() => {
        if (swapRouteMode !== 'cross') return null;
        if (!targetRoute) throw new Error('Select target jurisdiction account.');
        const sourceJurisdiction = getReplicaJurisdictionName(currentReplica);
        if (!sourceJurisdiction) throw new Error('Source jurisdiction is not available.');
        if (!targetRoute.targetJurisdiction) throw new Error('Target jurisdiction is not available.');
        if (sourceJurisdiction === targetRoute.targetJurisdiction) {
          throw new Error('Cross-j route requires different jurisdictions.');
        }
        return {
          orderId: offerId,
          makerEntityId: sourceEntityId,
          hubEntityId: resolvedCounterparty,
          source: {
            jurisdiction: sourceJurisdiction,
            entityId: sourceEntityId,
            counterpartyEntityId: resolvedCounterparty,
            tokenId: giveToken,
            amount: effectiveGiveAmount,
          },
          target: {
            jurisdiction: targetRoute.targetJurisdiction,
            entityId: targetRoute.targetHubEntityId,
            counterpartyEntityId: targetRoute.targetEntityId,
            tokenId: wantToken,
            amount: effectiveWantAmount,
          },
          priceTicks: canonicalPriceTicks,
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

  function normalizeDisplayPriceForInput(value: string): string {
    return String(value || '').replace(/,/g, '').trim();
  }

  function requantizeAtLimitPrice(remainingGiveAmount: bigint, priceTicks: bigint): PreparedSwapOrderLike | null {
    if (remainingGiveAmount <= 0n || priceTicks <= 0n) return null;
    const side = tradeSide === 'sell-base' ? 1 : 0;
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

  function stepAmount(direction: 1 | -1): void {
    const current = parseDecimalAmountToBigInt(orderAmountInput || '0', giveTokenDecimals);
    const step = giveTokenDecimals >= 6 ? 10n ** BigInt(Math.max(0, giveTokenDecimals - 4)) : 1n;
    const next = current + BigInt(direction) * step;
    if (next <= 0n && direction < 0) return;
    orderAmountInput = formatAmountForInput(next > 0n ? next : 0n, giveToken);
  }
</script>

<div class="swap-panel">
  <div class="trade-grid">
    <div class="section section-market">
      <SwapPairToolbar
        pairOptions={pairOptions}
        selectedPairValue={selectedPairValue}
        baseTokenSymbol={baseTokenSymbol}
        quoteTokenSymbol={quoteTokenSymbol}
        orderbookScopeMode={orderbookScopeMode}
        on:pairchange={(event) => {
          selectedPairValue = event.detail;
          handlePairChange();
        }}
        on:togglescope={toggleOrderbookScope}
      />
      {#if orderbookHubIds.length > 0}
        <div class="orderbook-wrap" data-testid="swap-orderbook">
          {#key orderbookViewKey}
            <OrderbookPanel
              hubIds={orderbookHubIds}
              hubId={selectedBookAccountId}
              pairId={orderbookPairId}
              pairLabel={selectedPair?.label || `${baseTokenSymbol}/${quoteTokenSymbol}`}
              depth={orderbookDepth}
              showSources={true}
              sourceLabels={orderbookSourceLabels}
              sourceAvatars={orderbookSourceAvatars}
              compactHeader={true}
              showPriceStepControl={false}
              priceScale={Number(ORDERBOOK_PRICE_SCALE)}
              sizeDisplayScale={orderbookSizeDisplayScale}
              disablePriceAggregation={orderbookScopeMode === 'selected'}
              preferredClickSide={tradeSide === 'buy-base' ? 'ask' : 'bid'}
              on:levelclick={handleOrderbookLevelClick}
              on:snapshot={handleOrderbookSnapshot}
            />
          {/key}
        </div>
      {:else}
        <div class="orderbook-empty">No connected account orderbooks yet.</div>
      {/if}
    </div>
    <div class="section section-order">
      <div class="anyswap-builder" data-testid="swap-any-builder">
        <div class="swap-leg-card">
          <div class="leg-header">
            <span>From</span>
            <select
              class="chain-select"
              value={selectedSourceEntityValue}
              data-testid="swap-from-chain-select"
              on:change={handleSourceEntityChange}
            >
              {#each sourceEntityOptions as option}
                <option value={option.value}>{option.jurisdiction}</option>
              {/each}
            </select>
          </div>
          <div class="leg-main">
            <input
              type="text"
              bind:value={orderAmountInput}
              inputmode="decimal"
              data-testid="swap-order-amount"
              aria-label="Swap from amount"
            />
            <select
              class="token-select"
              value={String(giveToken)}
              data-testid="swap-from-token-select"
              aria-label="Swap from token"
              on:change={handleGiveTokenChange}
            >
              {#each swapTokenOptions as token}
                <option value={token.tokenId}>{token.symbol}</option>
              {/each}
            </select>
          </div>
          <div class="leg-meta">
            <span>{sourceRouteEntityLabel}</span>
            <strong>{formattedAvailableGive}</strong>
          </div>
        </div>

        <div class="swap-leg-divider">
          <button
            type="button"
            class="direction-chip"
            on:click={() => setSwapTokens(wantToken, giveToken)}
            title="Swap selected tokens"
          >⇅</button>
          <button
            type="button"
            class="side-compat"
            data-testid="swap-side-buy"
            on:click={() => setTradeSide('buy-base')}
            title="Use buy-base direction"
          >Buy</button>
          <button
            type="button"
            class="side-compat"
            data-testid="swap-side-sell"
            on:click={() => setTradeSide('sell-base')}
            title="Use sell-base direction"
          >Sell</button>
        </div>

        <div class="swap-leg-card">
          <div class="leg-header">
            <span>To</span>
            <select
              class="chain-select"
              bind:value={selectedRouteValue}
              data-testid="swap-route-select"
              aria-label="Swap to network"
              on:change={() => { submitError = ''; }}
            >
              {#each routeOptions as option}
                <option value={option.value} disabled={option.disabled}>{option.targetJurisdiction}</option>
              {/each}
            </select>
          </div>
          <div class="leg-main">
            <input type="text" readonly value={formatAmount(wantAmount, wantToken)} class="readonly-input receive-amount" aria-label="Estimated receive amount" />
            <select
              class="token-select"
              value={String(wantToken)}
              data-testid="swap-to-token-select"
              aria-label="Swap to token"
              on:change={handleWantTokenChange}
            >
              {#each swapTokenOptions as token}
                <option value={token.tokenId}>{token.symbol}</option>
              {/each}
            </select>
          </div>
          <div class="leg-meta">
            <span>{targetRouteEntityLabel}</span>
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

      <div class="venue-row">
        <span>Venue</span>
        <select
          value={createOrderAccountId}
          data-testid="swap-account-select"
          on:change={(event) => handleSelectedHubChange((event.currentTarget as HTMLSelectElement).value)}
        >
          {#each selectedHubOptions as hub (hub.value)}
            <option value={hub.value}>{hub.label}</option>
          {/each}
        </select>
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

      <div class="route-builder" data-testid="swap-route-picker">
        <button type="button" class="route-summary" on:click={() => routeDetailsOpen = !routeDetailsOpen}>
          <span>Best route</span>
          <strong>{selectedRouteOption?.mode === 'cross' ? 'XLN cross-j' : 'XLN same-j'}</strong>
          <em>{routeVenueLabel}</em>
        </button>
        <div class="route-flow" data-testid="swap-route-flow">
          <div class="route-node">
            <span class="route-node-kicker">Sell</span>
            <strong>{sourceJurisdictionLabel}</strong>
            <span>{sourceRouteEntityLabel}</span>
            <em>{estimatedSpendLabel}</em>
          </div>
          <span class="route-arrow">-&gt;</span>
          <div class="route-node">
            <span class="route-node-kicker">Buy</span>
            <strong>{targetJurisdictionLabel}</strong>
            <span>{targetRouteEntityLabel}</span>
            <em>{estimatedReceiveLabel}</em>
          </div>
        </div>
        {#if swapRouteMode === 'cross' && canAutoPrepareCrossInboundCapacity}
          <label class="route-checkbox" data-testid="swap-cross-auto-extend">
            <input type="checkbox" bind:checked={autoExtendCrossInbound} />
            <span>Auto-extend target inbound capacity</span>
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
      {#if crossAutoCapacityNote && autoExtendCrossInbound}
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
        class:buy-action={tradeSide === 'buy-base'}
        class:sell-action={tradeSide === 'sell-base'}
        data-testid="swap-submit-order"
        on:click={placeSwapOffer}
        disabled={Boolean(swapActionDisabledReason)}
      >
        Swap {giveTokenSymbol} to {wantTokenSymbol}
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
                  </td>
                  <td>{formatPriceImprovement(offerImprovement.amount, offerImprovement.tokenId)}</td>
                  <td>{String(offer.accountId || '').slice(0, 10)}...</td>
                  <td>
                    <button class="cancel-btn" data-testid="swap-open-order-cancel" on:click={() => cancelSwapOffer(String(offer.offerId || ''), String(offer.accountId || ''))}>
                      Request Cancel
                    </button>
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
    <div class="swap-modal-overlay" on:click={() => (swapCompletionModal = null)}>
      <div class="swap-modal" on:click|stopPropagation>
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
    padding: 10px;
    background: #131419;
    border-radius: 6px;
    border: 1px solid #1e2028;
  }

  .trade-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 14px;
    align-items: start;
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

  .order-input-row {
    display: flex;
    align-items: center;
    gap: 0;
    margin-bottom: 8px;
    padding: 0 10px;
    height: 40px;
    background: #111217 !important;
    border: 1px solid #1e2028 !important;
    border-radius: 6px;
    font-size: 13px;
    box-sizing: border-box;
  }

  .order-input-row:focus-within {
    border-color: rgba(251, 191, 36, 0.5);
  }

  .input-label {
    color: #6b7280;
    font-size: 12px;
    font-weight: 500;
    min-width: 48px;
    flex-shrink: 0;
  }

  .order-input-row input {
    flex: 1;
    min-width: 0;
    border: none;
    background: none;
    padding: 0 8px;
    height: 100%;
    font-size: 14px;
    text-align: right;
  }

  .order-input-row input:focus {
    outline: none;
    border: none;
  }

  .anyswap-builder {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 8px;
    margin-bottom: 10px;
  }

  .swap-leg-card {
    display: grid;
    gap: 8px;
    padding: 10px;
    background: #0c0d12;
    border: 1px solid #20232c;
    border-radius: 8px;
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
    justify-content: space-between;
  }

  .leg-header span,
  .venue-row span {
    color: #8b94a7;
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
  }

  .chain-select,
  .token-select,
  .venue-row select {
    min-width: 0;
    border: 1px solid #232631;
    border-radius: 7px;
    background: #111217;
    color: #e5e7eb;
    font-size: 12px;
    font-weight: 700;
    color-scheme: dark;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chain-select {
    width: min(220px, 68%);
    max-width: 220px;
    height: 30px;
    padding: 0 8px;
  }

  .token-select {
    width: 96px;
    height: 40px;
    padding: 0 8px;
    flex-shrink: 0;
  }

  .leg-main input {
    flex: 1;
    min-width: 0;
    height: 42px;
    padding: 0;
    border: none;
    background: transparent;
    color: #f3f4f6;
    font-size: 22px;
    font-weight: 700;
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
    min-height: 28px;
  }

  .direction-chip,
  .side-compat {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: 24px;
    border-radius: 7px;
    border: 1px solid #252936;
    background: #141720;
    color: #a7afbd;
    font-size: 11px;
    font-weight: 800;
  }

  .direction-chip {
    width: 32px;
    color: #fbbf24;
  }

  .side-compat {
    min-width: 42px;
    padding: 0 8px;
  }

  .quote-row,
  .venue-row {
    min-height: 36px;
    padding: 0 10px;
    margin-bottom: 8px;
    background: #111217;
    border: 1px solid #1e2028;
    border-radius: 6px;
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
  }

  .quote-row input:focus {
    outline: none;
  }

  .venue-row {
    justify-content: space-between;
  }

  .venue-row select {
    width: min(240px, 70%);
    height: 30px;
    padding: 0 8px;
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

  .route-builder {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 8px;
    margin-bottom: 10px;
  }

  .route-summary {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 8px;
    min-height: 34px;
    padding: 0 10px;
    background: #101116;
    border: 1px solid #1e2028;
    border-radius: 6px;
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
    grid-template-columns: 52px minmax(0, 1fr);
    align-items: center;
    gap: 8px;
    padding: 0 10px;
    height: 36px;
    background: #111217;
    border: 1px solid #1e2028;
    border-radius: 6px;
    box-sizing: border-box;
  }

  .route-select-row span {
    color: #7c8597;
    font-size: 12px;
    font-weight: 600;
  }

  .route-select {
    width: 100%;
    height: 100%;
    min-width: 0;
    padding: 0;
    color: #d1d5db;
    background: transparent;
    border: 0;
    border-radius: 0;
    font-size: 12px;
    box-sizing: border-box;
  }

  .route-flow {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 20px minmax(0, 1fr);
    align-items: stretch;
    gap: 6px;
  }

  .route-node {
    display: grid;
    gap: 3px;
    min-width: 0;
    padding: 8px;
    background: #0c0d12;
    border: 1px solid #1e2028;
    border-radius: 6px;
  }

  .route-node-kicker {
    color: #6b7280;
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
  }

  .route-node strong,
  .route-node span,
  .route-node em {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .route-node strong {
    color: #e5e7eb;
    font-size: 12px;
  }

  .route-node span {
    color: #9ca3af;
    font-size: 11px;
  }

  .route-node em {
    color: #fbbf24;
    font-size: 11px;
    font-style: normal;
    font-weight: 700;
  }

  .route-arrow {
    display: flex;
    align-items: center;
    justify-content: center;
    color: #6b7280;
    font-size: 12px;
    font-weight: 700;
  }

  .route-checkbox {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    color: #a7f3d0;
    font-size: 12px;
  }

  .route-checkbox input {
    width: 14px;
    height: 14px;
    margin: 0;
    accent-color: #22c55e;
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
    margin-bottom: 12px;
    padding: 0 2px;
  }

  .avbl-row strong {
    color: #d1d5db;
  }

  .capacity-warn {
    color: #f59e0b;
    font-size: 11px;
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
    padding: 10px;
    background: linear-gradient(180deg, rgba(251, 191, 36, 0.18), rgba(217, 119, 6, 0.12)) !important;
    border: 1px solid rgba(251, 191, 36, 0.55) !important;
    border-radius: 8px;
    color: #fde68a;
    font-size: 13px;
    font-weight: 600;
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
    opacity: 0.4;
    cursor: not-allowed;
  }




  .size-hint {
    margin: 8px 0 0;
    color: #9ca3af;
    font-size: 11px;
    line-height: 1.4;
  }

  .size-warning {
    margin: 6px 0 0;
    color: #fca5a5;
    font-size: 11px;
    line-height: 1.4;
  }

  .form-error {
    margin: 8px 0 0;
    color: #fda4af;
    font-size: 12px;
    line-height: 1.4;
  }

  .auto-capacity-note {
    margin: 10px 0 8px;
    color: #86efac;
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
    min-width: 148px;
    height: 34px;
    border-radius: 10px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: #111217;
    color: #f3f4f6;
    font-family: inherit;
    font-size: 12px;
    font-weight: 600;
    padding: 0 10px;
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

</style>
