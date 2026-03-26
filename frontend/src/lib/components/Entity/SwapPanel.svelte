  <script lang="ts">
    import type { AccountMachine, AccountTx, EntityReplica, Tab } from '$lib/types/ui';
  import type { SwapBookEntry } from '@xln/runtime/xln-api';
  import { enqueueEntityInputs, xlnEnvironment, xlnFunctions } from '../../stores/xlnStore';
  import { isLive as globalIsLive } from '../../stores/timeStore';
  import { toasts } from '../../stores/toastStore';
  import { requireSignerIdForEntity } from '$lib/utils/entityReplica';
  import { amountToUsd } from '$lib/utils/assetPricing';
  import OrderbookPanel from '../Trading/OrderbookPanel.svelte';
  import SwapOrderModeRail from './SwapOrderModeRail.svelte';
  import SwapPairToolbar from './SwapPairToolbar.svelte';
  import { resolveEntityName } from '$lib/utils/entityNaming';
  import { formatEntityId } from '$lib/utils/format';

  export let replica: EntityReplica | null;
  export let tab: Tab;

  // Props
  export let counterpartyId: string = '';
  let orderbookScopeMode: 'aggregated' | 'selected' = 'aggregated';
  let createOrderAccountId = '';
  let selectedBookAccountId = '';
  let activeOrderAccountId = '';
  const AGGREGATED_ORDERBOOK_DEPTH = 15;
  const SELECTED_ORDERBOOK_DEPTH = 15;
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
  type OrderbookSnapshot = {
    pairId: string;
    bids: SnapshotLevel[];
    asks: SnapshotLevel[];
    spread: bigint | null;
    spreadPercent: string;
    sourceCount: number;
    updatedAt: number;
  };
  type ClosedOrderStatus = 'filled' | 'partial' | 'canceled' | 'closed';
  type ResolveRecord = {
    fillRatio: number;
    cancelRemainder: boolean;
    timestamp: number;
    executionGiveAmount: bigint | null;
    executionWantAmount: bigint | null;
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
    status: ClosedOrderStatus;
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
  let orderPercent = 100;
  let slippagePct = 0; // 0 = strict limit, 0.1-10 = market order with cap
  let orderType: 'market' | 'limit' = 'limit';
  const MARKET_SLIPPAGE_PCT = 5; // Market orders use ±5% from best price
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
  let closedOrderStatusFilter: 'all' | ClosedOrderStatus = 'all';
  const MIN_ORDER_NOTIONAL_USD = 10;
  const FILLED_DISPLAY_PPM_THRESHOLD = 999_950n;

    $: activeXlnFunctions = $xlnFunctions;
    $: activeEnv = $xlnEnvironment;
    $: activeIsLive = $globalIsLive;

    // Get available accounts (counterparties)
  $: accounts = replica?.state?.accounts
    ? Array.from(replica.state.accounts.keys())
    : [];
  $: baseAccountIds = accounts.map((id) => String(id)).sort();
  $: accountIds = (() => {
    const selected = String(counterpartyId || '');
    if (!selected || !baseAccountIds.includes(selected)) return baseAccountIds;
    return [selected, ...baseAccountIds.filter((id) => id !== selected)];
  })();
  $: cappedAccountIds = accountIds.slice(0, 10);
  $: hiddenAccountCount = Math.max(0, accountIds.length - cappedAccountIds.length);
  $: if (!selectedBookAccountId || !cappedAccountIds.includes(selectedBookAccountId)) {
    selectedBookAccountId = counterpartyId && cappedAccountIds.includes(counterpartyId)
      ? counterpartyId
      : (cappedAccountIds[0] || '');
  }
  $: if (!createOrderAccountId || !cappedAccountIds.includes(createOrderAccountId)) {
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
    ? cappedAccountIds
    : (selectedBookAccountId ? [selectedBookAccountId] : []);
  $: orderbookDepth = orderbookScopeMode === 'aggregated'
    ? AGGREGATED_ORDERBOOK_DEPTH
    : SELECTED_ORDERBOOK_DEPTH;
  $: orderbookViewKey = `${orderbookPairId}|${orderbookScopeMode}|${selectedBookAccountId}|${orderbookHubIds.join(',')}`;

  function resolveCounterpartyId(input: string): string {
    const normalized = String(input || '').trim().toLowerCase();
    if (!normalized) return '';
    const match = accountIds.find((id) => String(id || '').toLowerCase() === normalized);
    return match || String(input || '').trim();
  }
  function accountLabel(accountIdValue: string): string {
    const resolved = resolveEntityName(accountIdValue, activeEnv);
    return resolved || formatEntityId(accountIdValue);
  }
  $: selectedHubOptions = cappedAccountIds.map((id) => ({ value: id, label: accountLabel(id) }));
  $: orderbookSourceLabels = Object.fromEntries(
    cappedAccountIds.map((id) => [id, accountLabel(id)]),
  );
  $: orderbookSourceAvatars = Object.fromEntries(
    cappedAccountIds.map((id) => [id, activeXlnFunctions?.isReady ? (activeXlnFunctions.generateEntityAvatar?.(id) || '') : '']),
  );

  type TokenKeyedMap<V> = Map<number, V> | Map<string, V>;
  type DeltaLike = {
    collateral?: unknown;
    ondelta?: unknown;
    offdelta?: unknown;
    leftCreditLimit?: unknown;
    rightCreditLimit?: unknown;
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
    const configuredPairs = Array.isArray(replica?.state?.swapTradingPairs)
      ? replica.state.swapTradingPairs
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
      return a.label.localeCompare(b.label);
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
      .padStart(ORDERBOOK_PRICE_DECIMALS, '0')
      .replace(/0+$/, '');
    return frac ? `${whole.toString()}.${frac}` : whole.toString();
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

  $: activeOffers = replica ? activeXlnFunctions.listOpenSwapOffers(replica.state) : [];

  function readOutCapacity(counterpartyEntityId: string, tokenIdValue: number): bigint {
    if (!counterpartyEntityId || !Number.isFinite(tokenIdValue) || tokenIdValue <= 0) return 0n;
    const resolvedCounterparty = resolveCounterpartyId(counterpartyEntityId);
    const account = replica?.state?.accounts?.get?.(resolvedCounterparty);
    const deltas = account?.deltas as TokenKeyedMap<unknown> | undefined;
    if (!(deltas instanceof Map) || !activeXlnFunctions?.deriveDelta || !tab.entityId) return 0n;
    const delta = getTokenMapValue(deltas, tokenIdValue);
    if (!delta) return 0n;
    const isLeft = String(tab.entityId).toLowerCase() < String(resolvedCounterparty).toLowerCase();
    try {
      const derived = activeXlnFunctions.deriveDelta(delta, isLeft);
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
    const account = replica?.state?.accounts?.get?.(resolvedCounterparty);
    const deltas = account?.deltas as TokenKeyedMap<unknown> | undefined;
    if (!(deltas instanceof Map)) return false;
    return getTokenMapValue(deltas, tokenIdValue) !== undefined;
  }

  function readInCapacity(counterpartyEntityId: string, tokenIdValue: number): bigint {
    if (!counterpartyEntityId || !Number.isFinite(tokenIdValue) || tokenIdValue <= 0) return 0n;
    const resolvedCounterparty = resolveCounterpartyId(counterpartyEntityId);
    const account = replica?.state?.accounts?.get?.(resolvedCounterparty);
    const deltas = account?.deltas as TokenKeyedMap<unknown> | undefined;
    if (!(deltas instanceof Map) || !activeXlnFunctions?.deriveDelta || !tab.entityId) return 0n;
    const delta = getTokenMapValue(deltas, tokenIdValue);
    if (!delta) return 0n;
    const isLeft = String(tab.entityId).toLowerCase() < String(resolvedCounterparty).toLowerCase();
    try {
      const derived = activeXlnFunctions.deriveDelta(delta, isLeft);
      const inCapacityRaw = (derived as { inCapacity?: unknown })?.inCapacity;
      if (typeof inCapacityRaw === 'bigint') return inCapacityRaw;
      return toBigIntSafe(inCapacityRaw) ?? 0n;
    } catch {
      return 0n;
    }
  }

  function readAccountDelta(counterpartyEntityId: string, tokenIdValue: number): DeltaLike | null {
    if (!counterpartyEntityId || !Number.isFinite(tokenIdValue) || tokenIdValue <= 0) return null;
    const resolvedCounterparty = resolveCounterpartyId(counterpartyEntityId);
    const account = replica?.state?.accounts?.get?.(resolvedCounterparty);
    const deltas = account?.deltas as TokenKeyedMap<unknown> | undefined;
    if (!(deltas instanceof Map)) return null;
    const delta = getTokenMapValue(deltas, tokenIdValue) as DeltaLike | undefined;
    return delta || null;
  }

  function readPeerCreditLimit(counterpartyEntityId: string, tokenIdValue: number): bigint {
    const delta = readAccountDelta(counterpartyEntityId, tokenIdValue);
    if (!delta || !tab.entityId) return 0n;
    const isLeft = String(tab.entityId).toLowerCase() < String(resolveCounterpartyId(counterpartyEntityId)).toLowerCase();
    const raw = isLeft ? delta.rightCreditLimit : delta.leftCreditLimit;
    return nonNegative(toBigIntSafe(raw) ?? 0n);
  }

  function computeAutoInboundCreditTarget(
    counterpartyEntityId: string,
    tokenIdValue: number,
    desiredInboundAmount: bigint,
  ): bigint | null {
    if (!counterpartyEntityId || !Number.isFinite(tokenIdValue) || tokenIdValue <= 0 || desiredInboundAmount <= 0n) return null;
    if (!activeXlnFunctions?.deriveDelta || !tab.entityId) return desiredInboundAmount;
    const delta = readAccountDelta(counterpartyEntityId, tokenIdValue);
    if (!delta) return desiredInboundAmount;

    const resolvedCounterparty = resolveCounterpartyId(counterpartyEntityId);
    const isLeft = String(tab.entityId).toLowerCase() < String(resolvedCounterparty).toLowerCase();
    try {
      const derived = activeXlnFunctions.deriveDelta(delta, isLeft) as {
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

  function isInboundCapacityValidationError(reason: string): boolean {
    if (!reason) return false;
    return reason.startsWith('Inbound token is not active in this account.')
      || reason.startsWith('Insufficient inbound capacity');
  }

  $: giveTokenSymbol = tokenSymbol(giveToken);
  $: wantTokenSymbol = tokenSymbol(wantToken);
  $: wantTokenPresentInAccount = (replica, hasTokenInAccount(activeOrderAccountId, wantToken));
  // Include replica in deps so capacity updates when account state changes (new frames)
  $: availableGiveCapacity = (replica, readOutCapacity(activeOrderAccountId, giveToken));
  $: availableWantInCapacity = (replica, readInCapacity(activeOrderAccountId, wantToken));
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
  $: autoInboundCreditTarget = (replica, computeAutoInboundCreditTarget(activeOrderAccountId, wantToken, canonicalWantAmount));
  $: currentPeerCreditLimit = (replica, readPeerCreditLimit(activeOrderAccountId, wantToken));
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

  function resolveReferencePriceTicks(): bigint | null {
    if (String(orderbookSnapshot?.pairId || '').trim() === String(orderbookPairId || '').trim()) {
      const level = tradeSide === 'buy-base' ? orderbookSnapshot.asks?.[0] : orderbookSnapshot.bids?.[0];
      const price = level?.price ?? 0n;
      if (price > 0n) return price;
    }
    const bookSide: BookSide = tradeSide === 'buy-base' ? 'ask' : 'bid';
    return readCurrentHubBestPriceTicks(bookSide, activeOrderAccountId);
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
      entityId: String(tab.entityId || ''),
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
  $: swapDisabledReason = swapPreparationError || validateSwapForm(
    buildSwapValidationInput(
      String(activeOrderAccountId || ''),
      giveToken,
      wantToken,
      canonicalGiveAmount,
      canonicalWantAmount,
      canonicalPriceTicks,
    ),
  );
  $: swapActionDisabledReason = (
    isInboundCapacityValidationError(swapDisabledReason) && canAutoPrepareInboundCapacity
      ? ''
      : swapDisabledReason
  );
  $: autoCapacityNote = (() => {
    if (!canAutoPrepareInboundCapacity) return '';
    const targetLabel = formatAmount(autoInboundCreditTarget ?? 0n, wantToken);
    const increaseLabel = formatAmount(autoInboundCreditIncrease, wantToken);
    return `Placing this swap will auto-activate ${wantTokenSymbol} and set inbound capacity to ${targetLabel} ${wantTokenSymbol} (+${increaseLabel}).`;
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
    if (!activeEnv?.eReplicas || !hubEntityId) return null;
    const normalizedHubId = String(hubEntityId).trim().toLowerCase();
    if (!normalizedHubId) return null;
    for (const [key, replica] of activeEnv.eReplicas.entries()) {
      const entityId = String(key || '').split(':')[0]?.trim().toLowerCase();
      if (entityId !== normalizedHubId) continue;
      const book = replica?.state?.orderbookExt?.books?.get?.(orderbookPairId);
      if (!book) return null;
      const params = book.params || {};
      const idx = side === 'ask'
        ? Number(book.bestAskIdx ?? -1)
        : Number(book.bestBidIdx ?? -1);
      if (!Number.isFinite(idx) || idx < 0) return null;
      const pmin = toBigIntSafe(params.pmin) ?? 0n;
      const tick = toBigIntSafe(params.tick) ?? 1n;
      const price = pmin + (BigInt(idx) * tick);
      return price > 0n ? price : null;
    }
    return null;
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

  function handleOrderbookLevelClick(event: CustomEvent<{ side: BookSide; priceTicks: string; size: number; accountIds: string[] }>) {
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
      ? String(availableAccountIds.find((id) => cappedAccountIds.includes(id)) || activeOrderAccountId || '')
      : String(selectedBookAccountId || availableAccountIds.find((id) => cappedAccountIds.includes(id)) || '');
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
      displayPrice: String(event.detail?.displayPrice || ''),
      inputPriceTicks: parseDisplayPriceTicks(String(event.detail?.displayPrice || ''), priceTicks),
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

  // Market mode: auto-set price to bestAsk+5% (buy) or bestBid-5% (sell)
  // Price already includes the buffer — slippagePct stays 0, IOC is forced via orderType.
  $: if (orderType === 'market') {
    const refTicks = resolveReferencePriceTicks();
    if (refTicks && refTicks > 0n) {
      const adjustment = (refTicks * BigInt(MARKET_SLIPPAGE_PCT * 100)) / 10000n;
      const marketTicks = tradeSide === 'buy-base'
        ? refTicks + adjustment
        : (refTicks > adjustment ? refTicks - adjustment : 1n);
      priceRatioInput = formatPriceTicks(marketTicks);
    }
  }

  function resolveSignerId(entityId: string): string {
    if (activeEnv && activeXlnFunctions?.resolveEntityProposerId) {
      const proposerId = activeXlnFunctions.resolveEntityProposerId(activeEnv, entityId, 'swap-panel');
      if (proposerId) return proposerId;
    }
    return requireSignerIdForEntity(activeEnv, entityId, 'swap-panel');
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

  function isRuntimeEnv(value: unknown): value is { eReplicas: Map<string, unknown>; jReplicas: Map<string, unknown> } {
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
  function offerSideLabel(offer: SwapOfferLike): 'Ask' | 'Bid' {
    const give = Number(offer.giveTokenId || 0);
    const want = Number(offer.wantTokenId || 0);
    const pair = resolvePairOrientation(give, want);
    return give === pair.baseTokenId ? 'Ask' : 'Bid';
  }

  function offerPriceTicks(offer: SwapOfferLike): bigint {
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

  $: openOrders = [...activeOffers].sort((a: SwapOfferLike, b: SwapOfferLike) => {
    const aDust = isDustOpenOffer(a);
    const bDust = isDustOpenOffer(b);
    if (aDust !== bDust) return aDust ? 1 : -1;
    const aCreated = BigInt(a.createdHeight);
    const bCreated = BigInt(b.createdHeight);
    if (aCreated === bCreated) return String(a.offerId).localeCompare(String(b.offerId));
    return aCreated > bCreated ? -1 : 1;
  });

  function accountMachines(): Array<{ accountId: string; account: AccountMachine }> {
    if (!(replica?.state?.accounts instanceof Map)) return [];
    return Array.from(replica.state.accounts.entries()).map(([accountId, account]) => ({
      accountId: String(accountId),
      account,
    }));
  }

  function txDataAsRecord(tx: AccountTx): Record<string, unknown> {
    if (!tx || typeof tx !== 'object') return {};
    const data = (tx as { data?: unknown }).data;
    return data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
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
    };
  }

  function collectOfferLifecycles(): OfferLifecycle[] {
    const lifecycles = new Map<string, OfferLifecycle>();
    for (const { accountId, account } of accountMachines()) {
      const frames = Array.isArray(account.frameHistory) ? account.frameHistory : [];
      for (const frame of frames) {
        const frameTs = Number(frame.timestamp || 0);
        const frameTxs = Array.isArray(frame.accountTxs) ? frame.accountTxs : [];
        for (const tx of frameTxs) {
          if (tx.type === 'swap_offer') {
            const data = txDataAsRecord(tx);
            const offerId = String(data.offerId || '');
            if (!offerId) continue;
            const key = offerLifecycleKey(accountId, offerId);
            const giveToken = Number(data.giveTokenId || 0);
            const wantToken = Number(data.wantTokenId || 0);
            if (!Number.isFinite(giveToken) || !Number.isFinite(wantToken) || giveToken <= 0 || wantToken <= 0) continue;
            const give = toBigIntSafe(data.giveAmount) ?? 0n;
            const want = toBigIntSafe(data.wantAmount) ?? 0n;
            const priceTicks = toBigIntSafe(data.priceTicks)
              ?? (activeXlnFunctions?.computeSwapPriceTicks
                ? activeXlnFunctions.computeSwapPriceTicks(giveToken, wantToken, give, want)
                : 0n);
            lifecycles.set(key, {
              key,
              offerId,
              accountId,
              giveTokenId: giveToken,
              wantTokenId: wantToken,
              giveAmount: give,
              wantAmount: want,
              priceTicks,
              createdAt: frameTs,
              resolves: [],
              cancelRequested: false,
            });
            continue;
          }
          if (tx.type === 'swap_resolve') {
            const data = txDataAsRecord(tx);
            const offerId = String(data.offerId || '');
            if (!offerId) continue;
            const key = offerLifecycleKey(accountId, offerId);
            const fillRatio = Number(data.fillRatio || 0);
            const cancelRemainder = Boolean(data.cancelRemainder);
            const executionGiveAmount = toBigIntSafe(data.executionGiveAmount);
            const executionWantAmount = toBigIntSafe(data.executionWantAmount);
            const prev = lifecycles.get(key);
            if (!prev) continue;
            prev.resolves.push({
              fillRatio: Number.isFinite(fillRatio) ? fillRatio : 0,
              cancelRemainder,
              timestamp: frameTs,
              executionGiveAmount,
              executionWantAmount,
            });
            continue;
          }
          if (tx.type === 'swap_cancel_request' || tx.type === 'swap_cancel') {
            const data = txDataAsRecord(tx);
            const offerId = String(data.offerId || '');
            if (!offerId) continue;
            const prev = lifecycles.get(offerLifecycleKey(accountId, offerId));
            if (!prev) continue;
            prev.cancelRequested = true;
          }
        }
      }
    }
    return Array.from(lifecycles.values());
  }

  function classifyClosedStatus(lifecycle: OfferLifecycle): ClosedOrderStatus {
    const summary = computeOfferExecutionSummary(lifecycle);
    const filledPpm = summary.filledPpm;
    if (filledPpm >= FILLED_DISPLAY_PPM_THRESHOLD) return 'filled';
    const hasFill = summary.filledBaseAmount > 0n;
    const hasCancelResolve = lifecycle.resolves.some((resolve) => resolve.cancelRemainder);
    if (hasCancelResolve && hasFill) return 'partial';
    if (hasCancelResolve || lifecycle.cancelRequested) return 'canceled';
    if (hasFill) return 'filled';
    return 'closed';
  }

  function formatOrderTime(ms: number): string {
    if (!Number.isFinite(ms) || ms <= 0) return '-';
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

  $: offerLifecycles = collectOfferLifecycles();

  $: openOfferIdSet = new Set(
    openOrders
      .map((offer) => offerLifecycleKey(String(offer.accountId || ''), String(offer.offerId || '')))
      .filter(Boolean),
  );
  $: closedOrderViews = offerLifecycles
    .filter((offer) => !openOfferIdSet.has(offer.key))
    .map((offer) => {
      const side = offerSideLabel(offer);
      const pair = resolvePairOrientation(offer.giveTokenId, offer.wantTokenId);
      const pairLabel = `${tokenSymbol(pair.baseTokenId)}/${tokenSymbol(pair.quoteTokenId)}`;
      const summary = computeOfferExecutionSummary(offer);
      const filledPpm = summary.filledPpm;
      const filledPercent = filledPpm >= FILLED_DISPLAY_PPM_THRESHOLD
        ? 100
        : Number((filledPpm * 10_000n) / 1_000_000n) / 100;
      const latestResolveTs = offer.resolves.length > 0 ? offer.resolves[offer.resolves.length - 1]!.timestamp : offer.createdAt;
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
        status: classifyClosedStatus(offer),
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
        };
        const improvementNote = closed.priceImprovementAmount > 0n
          ? ` with ${formatPriceImprovement(closed.priceImprovementAmount, closed.priceImprovementTokenId)} price improvement`
          : '';
        toasts.success(`Swap fully filled${improvementNote}`);
      } else if (closed.status === 'partial') {
        const improvementNote = closed.priceImprovementAmount > 0n
          ? ` Price improvement: ${formatPriceImprovement(closed.priceImprovementAmount, closed.priceImprovementTokenId)}.`
          : '';
        toasts.info(`Swap partially filled (${closed.filledPercent.toFixed(2)}%) and closed the remainder.${improvementNote}`);
      } else if (closed.status === 'canceled') {
        toasts.info('Swap was canceled without a fill.');
      }
      pendingSwapFeedbackOfferId = '';
    }
  }

  async function placeSwapOffer() {
    submitError = '';
    try {
      const env = activeEnv;
      if (!env) throw new Error('XLN environment not ready');
      if (!isRuntimeEnv(env)) throw new Error('Runtime environment not available');
      if (!activeIsLive) throw new Error('Swap actions are only available in LIVE mode');
      const signerId = resolveSignerId(tab.entityId);
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

      // Apply slippage: if > 0%, adjust price to guarantee crossing
      // BUY: price UP by slippage% (willing to pay more)
      // SELL: price DOWN by slippage% (willing to receive less)
      if (slippagePct > 0 && canonicalPriceTicks > 0n) {
        const slipBps = BigInt(Math.round(slippagePct * 100)); // 1% = 100bps
        if (tradeSide === 'buy-base') {
          canonicalPriceTicks = canonicalPriceTicks + (canonicalPriceTicks * slipBps) / 10000n;
        } else {
          const reduction = (canonicalPriceTicks * slipBps) / 10000n;
          canonicalPriceTicks = canonicalPriceTicks > reduction ? canonicalPriceTicks - reduction : 1n;
        }
        // Recompute amounts at slippage-adjusted price
        const LOT_SCALE = 10n ** 12n;
        const rawBase = tradeSide === 'sell-base' ? giveAmount : wantAmount;
        const quantizedBase = (rawBase / LOT_SCALE) * LOT_SCALE;
        if (quantizedBase > 0n) {
          const adjustedQuote = (quantizedBase * canonicalPriceTicks) / ORDERBOOK_PRICE_SCALE;
          if (adjustedQuote > 0n) {
            effectiveGiveAmount = tradeSide === 'sell-base' ? quantizedBase : adjustedQuote;
            effectiveWantAmount = tradeSide === 'sell-base' ? adjustedQuote : quantizedBase;
          }
        }
      }

      // IOC when using slippage (market order behavior)
      const useIOC = orderType === 'market' || slippagePct > 0 || !!selectedOrderLevel;

      if (effectiveGiveAmount <= 0n || effectiveWantAmount <= 0n) {
        throw new Error('Quantized order too small');
      }
      if (!Number.isFinite(giveToken) || !allowedSwapTokenIds.has(giveToken)) {
        throw new Error('Invalid give token');
      }
      if (!Number.isFinite(wantToken) || !allowedSwapTokenIds.has(wantToken)) {
        throw new Error('Invalid want token');
      }
      if (giveToken === wantToken) {
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
      const liveValidationReason = validateSwapForm(liveValidation);
      if (liveValidationReason && !(isInboundCapacityValidationError(liveValidationReason) && canAutoPrepareInboundCapacity)) {
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
        requiredInboundCreditLimit !== null
        && requiredInboundCreditLimit > currentInboundCreditLimit
        && isInboundCapacityValidationError(liveValidationReason)
      );
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
          ...(useIOC ? { timeInForce: 1 as const } : {}),
          minFillRatio,
        },
      });

      await enqueueEntityInputs(env, [{
        entityId: tab.entityId,
        signerId,
        entityTxs,
      }]);

      pendingSwapFeedbackOfferId = offerId;
      toasts.success('Swap offer submitted');

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
    if (!tab.entityId) return;

    try {
      const env = activeEnv;
      if (!env) throw new Error('XLN environment not ready');
      if (!isRuntimeEnv(env)) throw new Error('Runtime environment not available');
      if (!activeIsLive) throw new Error('Swap actions are only available in LIVE mode');
      const signerId = resolveSignerId(tab.entityId);
      if (!signerId) throw new Error('No signer available for selected entity');

      await enqueueEntityInputs(env, [{
        entityId: tab.entityId,
        signerId,
        entityTxs: [{
          type: 'proposeCancelSwap',
          data: {
            offerId,
            counterpartyEntityId: accountId,
          }
        }]
      }]);

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
    if (orderType === 'market') return;
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
              priceScale={Number(ORDERBOOK_PRICE_SCALE)}
              sizeDisplayScale={orderbookSizeDisplayScale}
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
      <SwapOrderModeRail
        tradeSide={tradeSide}
        orderType={orderType}
        selectedHubOptions={selectedHubOptions}
        selectedHubValue={createOrderAccountId}
        on:tradesidechange={(event) => setTradeSide(event.detail)}
        on:ordertypechange={(event) => {
          orderType = event.detail;
          slippagePct = 0;
        }}
        on:hubchange={(event) => handleSelectedHubChange(event.detail)}
      />

      <div class="order-input-row">
        <span class="input-label">Price</span>
        {#if orderType === 'market'}
          <input type="text" readonly value="{priceRatioInput || '—'}" class="readonly-input market-price-input" data-testid="swap-order-price" title="Best {tradeSide === 'buy-base' ? 'ask' : 'bid'} ±{MARKET_SLIPPAGE_PCT}%" />
        {:else}
          <input
            type="text"
            bind:value={priceRatioInput}
            inputmode="decimal"
            data-testid="swap-order-price"
            aria-label="Swap order price"
            on:input={handlePriceRatioInput}
          />
        {/if}
        <span class="input-suffix">{orderType === 'market' ? `±${MARKET_SLIPPAGE_PCT}%` : quoteTokenSymbol}</span>
        {#if orderType === 'limit'}
          <div class="input-steppers">
            <button type="button" class="step-btn" on:click={() => stepPrice(1)}>▲</button>
            <button type="button" class="step-btn" on:click={() => stepPrice(-1)}>▼</button>
          </div>
        {/if}
      </div>

      <div class="order-input-row">
        <span class="input-label">Amount</span>
        <input type="text" bind:value={orderAmountInput} inputmode="decimal" data-testid="swap-order-amount" aria-label="Swap order amount" />
        <span class="input-suffix">{giveTokenSymbol}</span>
        <div class="input-steppers">
          <button type="button" class="step-btn" on:click={() => stepAmount(1)}>▲</button>
          <button type="button" class="step-btn" on:click={() => stepAmount(-1)}>▼</button>
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

      <label class="order-input-row">
        <span class="input-label">Total</span>
        <input type="text" readonly value={orderType === 'market' ? `~ ${formatAmount(wantAmount, wantToken)}` : formatAmount(wantAmount, wantToken)} class="readonly-input" />
        <span class="input-suffix">{wantTokenSymbol}</span>
      </label>

      <div class="avbl-row size-stats">
        <span>Available: <strong>{formattedAvailableGive}</strong></span>
        {#if capacityWarning}
          <span class="capacity-warn">{capacityWarning}</span>
        {/if}
      </div>

      {#if autoCapacityNote}
        <p class="auto-capacity-note" data-testid="swap-auto-capacity-note">{autoCapacityNote}</p>
      {/if}

      {#if selectedOrderLevel}
        <p class="size-hint">
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
        {tradeSide === 'buy-base' ? `Buy ${baseTokenSymbol.replace(/^W/, '')}` : `Sell ${baseTokenSymbol.replace(/^W/, '')}`}
      </button>
      {#if swapActionDisabledReason || submitError}
        <p class="form-error">{submitError || swapActionDisabledReason}</p>
      {/if}
    </div>
  </div>

  <div class="section section-orders">
    <div class="orders-toolbar">
      <div class="orders-header-left">
        <h4 class="orders-inline-title">Orders</h4>
        <span class="orders-count">{orderListTab === 'open' ? openOrders.length : filteredClosedOrderViews.length}</span>
        <button
          type="button"
          class="orders-tab-text"
          class:active={orderListTab === 'open'}
          data-testid="swap-orders-tab-open"
          on:click={() => (orderListTab = 'open')}
        >Open</button>
        <button
          type="button"
          class="orders-tab-text"
          class:active={orderListTab === 'closed'}
          data-testid="swap-orders-tab-closed"
          on:click={() => (orderListTab = 'closed')}
        >Closed</button>
      </div>
      {#if orderListTab === 'closed'}
        <label class="closed-status-filter">
          Status
          <select bind:value={closedOrderStatusFilter}>
            <option value="all">All</option>
            <option value="filled">Filled</option>
            <option value="partial">Partial</option>
            <option value="canceled">Canceled</option>
            <option value="closed">Closed</option>
          </select>
        </label>
      {/if}
    </div>
    {#if totalPriceImprovementSummary}
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
                <tr>
                  <td>
                    <span class:side-ask={side === 'Ask'} class:side-bid={side === 'Bid'} class="side-badge">{side}</span>
                  </td>
                  <td>{tokenSymbol(pairView.baseTokenId)}/{tokenSymbol(pairView.quoteTokenId)}</td>
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
                    <button class="cancel-btn" on:click={() => cancelSwapOffer(String(offer.offerId || ''), String(offer.accountId || ''))}>
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
                <tr>
                  <td>
                    <span class:side-ask={closedOrderStatusTone(order.status) === 'ask'} class:side-bid={closedOrderStatusTone(order.status) === 'bid'} class="side-badge">
                      {closedOrderStatusLabel(order.status)}
                    </span>
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
    height: 100%;
    min-width: 0;
    max-width: 100%;
    overflow: hidden;
  }

  .section-order {
    height: 100%;
    min-width: 0;
    max-width: 100%;
    overflow-y: auto;
    overflow-x: hidden;
  }

  .section-orders {
    margin-top: 14px;
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

  .market-price-input {
    color: #9ca3af;
    font-style: normal;
    font-size: 13px;
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

  select, input:not([type="range"]) {
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

  select:focus, input:not([type="range"]):focus {
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

  .orders-count {
    color: #9ca3af;
    font-size: 11px;
  }

  .orders-tab-text {
    border: none;
    background: none;
    padding: 0;
    font-size: 12px;
    color: #6b7280;
    cursor: pointer;
    user-select: none;
    transition: color 100ms;
  }

  .orders-tab-text:hover {
    color: #d1d5db;
  }

  .orders-tab-text.active {
    color: #fbbf24;
  }

  .closed-status-filter {
    display: inline-flex;
    flex-direction: column;
    gap: 4px;
    color: #9ca3af;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .closed-status-filter select {
    min-width: 130px;
    height: 32px;
    border-radius: 8px;
    border: 1px solid #353942;
    background: #111217;
    color: #f3f4f6;
    font-size: 12px;
    padding: 0 8px;
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
