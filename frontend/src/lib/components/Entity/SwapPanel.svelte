  <script lang="ts">
    import type { AccountMachine, AccountTx, EntityReplica, Tab } from '$lib/types/ui';
  import { enqueueEntityInputs, xlnEnvironment, xlnFunctions } from '../../stores/xlnStore';
  import { isLive as globalIsLive } from '../../stores/timeStore';
  import { requireSignerIdForEntity } from '$lib/utils/entityReplica';
  import { amountToUsd } from '$lib/utils/assetPricing';
  import OrderbookPanel from '../Trading/OrderbookPanel.svelte';
  import { resolveEntityName } from '$lib/utils/entityNaming';
  import { formatEntityId } from '$lib/utils/format';

  export let replica: EntityReplica | null;
  export let tab: Tab;

  // Props
  export let counterpartyId: string = '';
  const AGGREGATED_ACCOUNT_VALUE = '__aggregated__';
  let accountViewValue = AGGREGATED_ACCOUNT_VALUE;
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
  const PRICE_RATIO_DECIMALS = 6;
  const PRICE_RATIO_SCALE = 10n ** BigInt(PRICE_RATIO_DECIMALS);
  type BookSide = 'bid' | 'ask';
  type SwapOfferLike = {
    offerId?: string;
    accountId?: string;
    giveTokenId?: unknown;
    wantTokenId?: unknown;
    giveAmount?: unknown;
    wantAmount?: unknown;
    priceTicks?: unknown;
    createdAt?: unknown;
  };
  type ClickedOrderLevel = {
    side: BookSide;
    priceTicks: bigint;
    sizeBaseWei: bigint;
    baseTokenId: number;
    quoteTokenId: number;
    accountId: string;
    accountIds: string[];
  };
  type SnapshotLevel = { price: number; size: number; total: number };
  type OrderbookSnapshot = {
    pairId: string;
    bids: SnapshotLevel[];
    asks: SnapshotLevel[];
    spread: number | null;
    spreadPercent: string;
    sourceCount: number;
    updatedAt: number;
  };
  type ClosedOrderStatus = 'filled' | 'partial' | 'canceled' | 'closed';
  type ResolveRecord = { fillRatio: number; cancelRemainder: boolean; timestamp: number };
  type OfferLifecycle = {
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
    filledPercent: number;
    status: ClosedOrderStatus;
    createdAt: number;
    closedAt: number;
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
  let submitError = '';
  let selectedPairValue = '';
  let tradeSide: 'buy-base' | 'sell-base' = 'buy-base';
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
  let priceRatioScaled = 0n;
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
  $: if (accountViewValue !== AGGREGATED_ACCOUNT_VALUE && !cappedAccountIds.includes(accountViewValue)) {
    accountViewValue = counterpartyId && cappedAccountIds.includes(counterpartyId)
      ? counterpartyId
      : AGGREGATED_ACCOUNT_VALUE;
  }
  $: selectedBookAccountId = accountViewValue === AGGREGATED_ACCOUNT_VALUE ? '' : accountViewValue;
  $: if (accountViewValue === AGGREGATED_ACCOUNT_VALUE) {
    if (!createOrderAccountId || !cappedAccountIds.includes(createOrderAccountId)) {
      createOrderAccountId = counterpartyId && cappedAccountIds.includes(counterpartyId)
        ? counterpartyId
        : (cappedAccountIds[0] || '');
    }
  } else {
    createOrderAccountId = selectedBookAccountId;
  }
  $: activeOrderAccountId = accountViewValue === AGGREGATED_ACCOUNT_VALUE
    ? createOrderAccountId
    : selectedBookAccountId;
  $: orderbookHubIds = accountViewValue === AGGREGATED_ACCOUNT_VALUE
    ? cappedAccountIds
    : (selectedBookAccountId ? [selectedBookAccountId] : []);
  $: orderbookDepth = accountViewValue === AGGREGATED_ACCOUNT_VALUE
    ? AGGREGATED_ORDERBOOK_DEPTH
    : SELECTED_ORDERBOOK_DEPTH;
  $: orderbookViewKey = `${orderbookPairId}|${accountViewValue}|${orderbookHubIds.join(',')}`;

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
  $: accountViewOptions = [
    { value: AGGREGATED_ACCOUNT_VALUE, label: 'Aggregated' },
    ...cappedAccountIds.map((id) => ({ value: id, label: accountLabel(id) })),
  ];
  $: placementAccountOptions = cappedAccountIds.map((id) => ({ value: id, label: accountLabel(id) }));
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
    orderPercent = 100;
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

  function formatScaled(value: bigint, decimals: number): string {
    if (value <= 0n) return '0';
    const scale = 10n ** BigInt(Math.max(0, decimals));
    const whole = value / scale;
    const frac = value % scale;
    if (frac === 0n) return whole.toString();
    return `${whole.toString()}.${frac.toString().padStart(Math.max(0, decimals), '0').replace(/0+$/, '')}`;
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
    priceRatioInput = normalizeDecimalInput(target?.value || '', PRICE_RATIO_DECIMALS);
  }

  // Open orders use entity swapBook for immediate UX. Restore path rebuilds swapBook
  // from authoritative account.swapOffers to avoid stale rows after reload.
  $: activeOffers = replica?.state?.swapBook
    ? Array.from(replica.state.swapBook.values()) as SwapOfferLike[]
    : [];

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
  $: estimatedPrice = priceRatioScaled > 0n ? formatScaled(priceRatioScaled, PRICE_RATIO_DECIMALS) : 'n/a';
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
    priceRatioScaled: bigint;
    limitPriceTicks: bigint | null;
    wantAmount: bigint;
    wantTokenPresentInAccount: boolean;
    availableGiveCapacity: bigint;
    availableWantInCapacity: bigint;
    formattedAvailableGive: string;
    formattedAvailableWantIn: string;
    notionalUsd: number;
  };

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
    if (input.priceRatioScaled <= 0n) return 'Enter valid price.';
    if (!input.limitPriceTicks || input.limitPriceTicks <= 0n) return 'Price is too small.';
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
    candidatePriceRatioScaled: bigint,
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
      priceRatioScaled: candidatePriceRatioScaled,
      limitPriceTicks: candidateLimitPriceTicks,
      wantAmount: candidateWantAmount,
      wantTokenPresentInAccount: liveWantTokenPresentInAccount,
      availableGiveCapacity: liveAvailableGiveCapacity,
      availableWantInCapacity: liveAvailableWantInCapacity,
      formattedAvailableGive: liveFormattedAvailableGive,
      formattedAvailableWantIn: liveFormattedAvailableWantIn,
      notionalUsd: computeOrderNotionalUsd(orderMode, candidateGiveToken, candidateWantToken, candidateGiveAmount, candidateWantAmount),
    };
  }

  $: swapPreparationError = (
    giveAmount > 0n
    && priceRatioScaled > 0n
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
      priceRatioScaled,
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
  $: if (selectedOrderLevel && accountViewValue !== AGGREGATED_ACCOUNT_VALUE && selectedOrderLevel.accountId !== selectedBookAccountId) {
    selectedOrderLevel = null;
    orderPercent = 100;
  }

  function applyOrderPercent(percent: number) {
    const clamped = Math.max(0, Math.min(100, Math.round(percent)));
    orderPercent = clamped;
    const currentGiveCapacity = readOutCapacity(activeOrderAccountId, giveToken);
    if (!selectedOrderLevel) {
      const rawGive = (currentGiveCapacity * BigInt(clamped)) / 100n;
      const rawWant = orderMode === 'sell-base'
        ? quoteFromBase(rawGive, priceRatioScaled, baseTokenDecimals, quoteTokenDecimals)
        : baseFromQuote(rawGive, priceRatioScaled, baseTokenDecimals, quoteTokenDecimals);
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
    const priceScaled = (selectedOrderLevel.priceTicks * PRICE_RATIO_SCALE) / ORDERBOOK_PRICE_SCALE;
    const levelBaseDecimals = getTokenDecimals(selectedOrderLevel.baseTokenId);
    const levelQuoteDecimals = getTokenDecimals(selectedOrderLevel.quoteTokenId);
    const levelGiveCapacity = readOutCapacity(selectedLevelAccountId, levelGiveTokenId);
    const maxFillGiveByBook = selectedOrderLevel.side === 'ask'
      ? quoteFromBase(selectedOrderLevel.sizeBaseWei, priceScaled, levelBaseDecimals, levelQuoteDecimals)
      : selectedOrderLevel.sizeBaseWei;
    const maxFillGive = levelGiveCapacity < maxFillGiveByBook ? levelGiveCapacity : maxFillGiveByBook;
    const rawGive = (maxFillGive * BigInt(clamped)) / 100n;
    const rawWant = tradeSide === 'sell-base'
      ? quoteFromBase(rawGive, priceScaled, levelBaseDecimals, levelQuoteDecimals)
      : baseFromQuote(rawGive, priceScaled, levelBaseDecimals, levelQuoteDecimals);
    const fillGive = prepareCanonicalOrder(rawGive, rawWant)?.effectiveGive ?? 0n;

    orderAmountInput = formatAmountForInput(fillGive, levelGiveTokenId);
    priceRatioInput = formatPriceTicks(selectedOrderLevel.priceTicks);
  }

  function handleOrderPercentInput(event: Event) {
    const target = event.currentTarget as HTMLInputElement | null;
    const value = Number.parseInt(String(target?.value || ''), 10);
    applyOrderPercent(Number.isFinite(value) ? value : 0);
  }

  function handleOrderbookSnapshot(event: CustomEvent<OrderbookSnapshot>) {
    orderbookSnapshot = event.detail;
  }

  function handleAccountViewChange(event: Event): void {
    const nextValue = String((event.currentTarget as HTMLSelectElement | null)?.value || AGGREGATED_ACCOUNT_VALUE);
    accountViewValue = nextValue;
    selectedOrderLevel = null;
    orderPercent = 100;
  }

  function handleCreateOrderAccountChange(event: Event): void {
    createOrderAccountId = String((event.currentTarget as HTMLSelectElement | null)?.value || '');
    selectedOrderLevel = null;
    orderPercent = 100;
  }

  function handlePairChange(): void {
    selectedOrderLevel = null;
    orderPercent = 100;
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
    const clickedAccountId = accountViewValue === AGGREGATED_ACCOUNT_VALUE
      ? String(availableAccountIds.find((id) => cappedAccountIds.includes(id)) || activeOrderAccountId || '')
      : String(selectedBookAccountId || availableAccountIds.find((id) => cappedAccountIds.includes(id)) || '');
    if (!clickedAccountId) {
      submitError = 'Pick a priced level from a connected account.';
      return;
    }
    if (accountViewValue === AGGREGATED_ACCOUNT_VALUE && createOrderAccountId !== clickedAccountId) {
      createOrderAccountId = clickedAccountId;
    }

    const priceTicks = parsedPriceTicks;
    const sizeBaseWei = lotsToBaseWei(rawSize);
    selectedOrderLevel = {
      side,
      priceTicks,
      sizeBaseWei,
      baseTokenId: pair.baseTokenId,
      quoteTokenId: pair.quoteTokenId,
      accountId: clickedAccountId,
      accountIds: availableAccountIds,
    };

    tradeSide = side === 'ask' ? 'buy-base' : 'sell-base';
    applyOrderPercent(100);
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

  function quoteFromBase(baseAmount: bigint, priceScaled: bigint, baseDecimals: number, quoteDecimals: number): bigint {
    if (baseAmount <= 0n || priceScaled <= 0n) return 0n;
    const baseScale = 10n ** BigInt(Math.max(0, baseDecimals));
    const quoteScale = 10n ** BigInt(Math.max(0, quoteDecimals));
    return (baseAmount * priceScaled * quoteScale) / (PRICE_RATIO_SCALE * baseScale);
  }

  function baseFromQuote(quoteAmount: bigint, priceScaled: bigint, baseDecimals: number, quoteDecimals: number): bigint {
    if (quoteAmount <= 0n || priceScaled <= 0n) return 0n;
    const baseScale = 10n ** BigInt(Math.max(0, baseDecimals));
    const quoteScale = 10n ** BigInt(Math.max(0, quoteDecimals));
    return (quoteAmount * PRICE_RATIO_SCALE * baseScale) / (priceScaled * quoteScale);
  }

  function prepareCanonicalOrder(rawGiveAmount: bigint, rawWantAmount: bigint): PreparedSwapOrderLike | null {
    if (!activeXlnFunctions?.isReady || !activeXlnFunctions?.prepareSwapOrder) return null;
    if (!Number.isFinite(giveToken) || !Number.isFinite(wantToken) || giveToken <= 0 || wantToken <= 0) return null;
    if (rawGiveAmount <= 0n || rawWantAmount <= 0n) return null;
    try {
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
  $: priceRatioScaled = parseDecimalAmountToBigInt(priceRatioInput, PRICE_RATIO_DECIMALS);
  $: limitPriceTicks = priceRatioScaled > 0n ? (priceRatioScaled * ORDERBOOK_PRICE_SCALE) / PRICE_RATIO_SCALE : null;
  $: giveAmount = parseDecimalAmountToBigInt(orderAmountInput, giveTokenDecimals);
  $: wantAmount = (() => {
    if (giveAmount <= 0n || priceRatioScaled <= 0n || !parsedOrderbookPair) return 0n;
    if (orderMode === 'sell-base') {
      return quoteFromBase(giveAmount, priceRatioScaled, baseTokenDecimals, quoteTokenDecimals);
    }
    if (orderMode === 'buy-base') {
      return baseFromQuote(giveAmount, priceRatioScaled, baseTokenDecimals, quoteTokenDecimals);
    }
    return 0n;
  })();
  $: preparedOrder = prepareCanonicalOrder(giveAmount, wantAmount);
  $: canonicalPriceTicks = preparedOrder?.priceTicks ?? limitPriceTicks;
  $: canonicalGiveAmount = preparedOrder?.effectiveGive ?? 0n;
  $: canonicalWantAmount = preparedOrder?.effectiveWant ?? 0n;
  $: giveAmountLeftover = preparedOrder?.unspentGiveAmount ?? 0n;
  function offerSideLabel(offer: SwapOfferLike): 'Ask' | 'Bid' {
    const give = Number(offer?.giveTokenId || 0);
    const want = Number(offer?.wantTokenId || 0);
    const pair = resolvePairOrientation(give, want);
    return give === pair.baseTokenId ? 'Ask' : 'Bid';
  }

  function offerPriceTicks(offer: SwapOfferLike): bigint {
    const explicitPriceTicks = toBigIntSafe(offer?.priceTicks);
    if (explicitPriceTicks && explicitPriceTicks > 0n) return explicitPriceTicks;
    const giveToken = Number(offer?.giveTokenId || 0);
    const wantToken = Number(offer?.wantTokenId || 0);
    const give = toBigIntSafe(offer?.giveAmount) ?? 0n;
    const want = toBigIntSafe(offer?.wantAmount) ?? 0n;
    if (!Number.isFinite(giveToken) || !Number.isFinite(wantToken)) return 0n;
    if (giveToken <= 0 || wantToken <= 0) return 0n;
    if (give <= 0n || want <= 0n) return 0n;
    return activeXlnFunctions.computeSwapPriceTicks(giveToken, wantToken, give, want);
  }

  function remainingOfferUsd(offer: SwapOfferLike): number {
    const giveToken = Number(offer?.giveTokenId || 0);
    const giveAmountValue = toBigIntSafe(offer?.giveAmount) ?? 0n;
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
    const aCreated = toBigIntSafe(a?.createdAt) ?? 0n;
    const bCreated = toBigIntSafe(b?.createdAt) ?? 0n;
    if (aCreated === bCreated) return String(a?.offerId || '').localeCompare(String(b?.offerId || ''));
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
            const giveToken = Number(data.giveTokenId || 0);
            const wantToken = Number(data.wantTokenId || 0);
            if (!Number.isFinite(giveToken) || !Number.isFinite(wantToken) || giveToken <= 0 || wantToken <= 0) continue;
            const give = toBigIntSafe(data.giveAmount) ?? 0n;
            const want = toBigIntSafe(data.wantAmount) ?? 0n;
            const priceTicks = toBigIntSafe(data.priceTicks)
              ?? (activeXlnFunctions?.computeSwapPriceTicks
                ? activeXlnFunctions.computeSwapPriceTicks(giveToken, wantToken, give, want)
                : 0n);
            lifecycles.set(offerId, {
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
            const fillRatio = Number(data.fillRatio || 0);
            const cancelRemainder = Boolean(data.cancelRemainder);
            const prev = lifecycles.get(offerId);
            if (!prev) continue;
            prev.resolves.push({
              fillRatio: Number.isFinite(fillRatio) ? fillRatio : 0,
              cancelRemainder,
              timestamp: frameTs,
            });
            continue;
          }
          if (tx.type === 'swap_cancel_request' || tx.type === 'swap_cancel') {
            const data = txDataAsRecord(tx);
            const offerId = String(data.offerId || '');
            if (!offerId) continue;
            const prev = lifecycles.get(offerId);
            if (!prev) continue;
            prev.cancelRequested = true;
          }
        }
      }
    }
    return Array.from(lifecycles.values());
  }

  function computeFilledPpm(resolves: ResolveRecord[]): bigint {
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

  function classifyClosedStatus(lifecycle: OfferLifecycle): ClosedOrderStatus {
    const filledPpm = computeFilledPpm(lifecycle.resolves);
    if (filledPpm >= FILLED_DISPLAY_PPM_THRESHOLD) return 'filled';
    const hasFill = lifecycle.resolves.some((resolve) => resolve.fillRatio > 0);
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

  $: openOfferIdSet = new Set(
    openOrders
      .map((offer) => String(offer.offerId || '').trim())
      .filter(Boolean),
  );
  $: closedOrderViews = collectOfferLifecycles()
    .filter((offer) => !openOfferIdSet.has(offer.offerId))
    .map((offer) => {
      const side = offerSideLabel(offer);
      const pair = resolvePairOrientation(offer.giveTokenId, offer.wantTokenId);
      const pairLabel = `${tokenSymbol(pair.baseTokenId)}/${tokenSymbol(pair.quoteTokenId)}`;
      const filledPpm = computeFilledPpm(offer.resolves);
      const filledGiveAmount = (offer.giveAmount * filledPpm) / 1_000_000n;
      const filledWantAmount = (offer.wantAmount * filledPpm) / 1_000_000n;
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
        filledGiveAmount,
        filledWantAmount,
        filledPercent,
        status: classifyClosedStatus(offer),
        createdAt: offer.createdAt,
        closedAt: latestResolveTs,
      } satisfies ClosedOrderView;
    })
    .sort((a, b) => b.closedAt - a.closedAt);
  $: filteredClosedOrderViews = closedOrderStatusFilter === 'all'
    ? closedOrderViews
    : closedOrderViews.filter((order) => order.status === closedOrderStatusFilter);

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
      const prepared = prepareCanonicalOrder(giveAmount, wantAmount);
      if (!prepared) throw new Error('Order does not fit canonical lot/tick constraints');
      let effectiveGiveAmount = prepared.effectiveGive;
      let effectiveWantAmount = prepared.effectiveWant;
      let canonicalPriceTicks = prepared.priceTicks;

      // When user clicked an orderbook level, use the exact price from the book
      // to avoid rounding drift from amounts→price→amounts round-trip.
      // Recompute amounts at the exact book price so the order crosses correctly.
      if (selectedOrderLevel && selectedOrderLevel.priceTicks > 0n) {
        const exactTicks = selectedOrderLevel.priceTicks;
        const LOT_SCALE = 10n ** 12n;
        const side = tradeSide === 'sell-base' ? 1 : 0;
        const rawBase = side === 1 ? giveAmount : wantAmount;
        const quantizedBase = (rawBase / LOT_SCALE) * LOT_SCALE;
        if (quantizedBase > 0n) {
          const quantizedQuote = (quantizedBase * exactTicks) / ORDERBOOK_PRICE_SCALE;
          if (quantizedQuote > 0n) {
            effectiveGiveAmount = side === 1 ? quantizedBase : quantizedQuote;
            effectiveWantAmount = side === 1 ? quantizedQuote : quantizedBase;
            canonicalPriceTicks = exactTicks;
          }
        }
      }
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
        priceRatioScaled,
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
          minFillRatio,
        },
      });

      await enqueueEntityInputs(env, [{
        entityId: tab.entityId,
        signerId,
        entityTxs,
      }]);

      console.log('📊 Swap offer placed:', offerId);
      if (shouldAutoPrepareInbound) {
        console.log(
          `🛠️ Auto-prepared inbound capacity: token=${wantToken} creditLimit=${requiredInboundCreditLimit?.toString() || '0'}`,
        );
      }

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
            counterpartyEntityId: accountId, // accountId is the counterparty entity ID
          }
        }]
      }]);

      console.log('📨 Swap cancel requested:', offerId);
    } catch (error) {
      console.error('Failed to cancel swap:', error);
      alert(`Failed to cancel: ${(error as Error)?.message || 'Unknown error'}`);
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
</script>

<div class="swap-panel">
  <div class="trade-grid">
    <div class="section section-market">
      <div class="swap-toolbar">
        <div class="toolbar-select toolbar-select-pair">
          <select
            bind:value={selectedPairValue}
            data-testid="swap-pair-select"
            aria-label="Swap pair"
            on:change={handlePairChange}
          >
            {#each pairOptions as pair (pair.value)}
              <option value={pair.value}>{pair.label}</option>
            {/each}
          </select>
        </div>
        <div class="toolbar-select toolbar-select-account">
          <select
            bind:value={accountViewValue}
            data-testid="swap-account-select"
            aria-label="Swap orderbook scope"
            on:change={handleAccountViewChange}
          >
            {#each accountViewOptions as option (option.value)}
              <option value={option.value}>{option.label}</option>
            {/each}
          </select>
        </div>
      </div>
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
      <div class="order-side-row">
        <div
          class="toolbar-select toolbar-select-create-account"
          class:is-hidden={accountViewValue !== AGGREGATED_ACCOUNT_VALUE}
        >
          <select
            bind:value={createOrderAccountId}
            data-testid="swap-create-account-select"
            aria-label="Create swap order on account"
            disabled={accountViewValue !== AGGREGATED_ACCOUNT_VALUE}
            on:change={handleCreateOrderAccountChange}
          >
            {#each placementAccountOptions as option (option.value)}
              <option value={option.value}>{option.label}</option>
            {/each}
          </select>
        </div>
        <div class="side-toggle-group">
          <button
            type="button"
            class="scope-btn"
            class:active={tradeSide === 'buy-base'}
            data-testid="swap-side-buy"
            on:click={() => setTradeSide('buy-base')}
          >
            Buy {baseTokenSymbol}
          </button>
          <button
            type="button"
            class="scope-btn"
            class:active={tradeSide === 'sell-base'}
            data-testid="swap-side-sell"
            on:click={() => setTradeSide('sell-base')}
          >
            Sell {baseTokenSymbol}
          </button>
        </div>
      </div>

      <div class="order-entry-row">
        <label class="order-field order-field-amount">
          {tradeSide === 'buy-base' ? 'Amount to Spend' : 'Amount to Sell'} ({giveTokenSymbol})
          <input type="text" bind:value={orderAmountInput} inputmode="decimal" data-testid="swap-order-amount" aria-label="Swap order amount" />
        </label>
        <label class="order-field order-field-price">
          Price ({quoteTokenSymbol} per {baseTokenSymbol})
          <input
            type="text"
            bind:value={priceRatioInput}
            inputmode="decimal"
            data-testid="swap-order-price"
            aria-label="Swap order price"
            on:input={handlePriceRatioInput}
          />
        </label>
        <label class="order-field order-field-receive">
          Amount to Receive ({wantTokenSymbol})
          <input
            type="text"
            readonly
            value={`${formatAmount(wantAmount, wantToken)} ${wantTokenSymbol}`}
            class="readonly-input"
          />
        </label>
      </div>

      <div class="slider-inline">
        <input
          class="size-slider"
          type="range"
          min="0"
          max="100"
          step="1"
          value={orderPercent}
          on:input={handleOrderPercentInput}
        />
        <span class="slider-value">{orderPercent}%</span>
      </div>

      <div class="size-tools">
        <div class="size-top">
          <span class="size-title">Order Sizing</span>
          <span class="size-min-fill">Min Fill: 0%</span>
        </div>
        <div class="size-stats">
          <span>Available: <strong>{formattedAvailableGive}</strong></span>
          <span>Inbound Capacity: <strong>{formattedAvailableWantIn}</strong></span>
          <span>Estimate: <strong>{estimatedSpendLabel} → {estimatedReceiveLabel}</strong></span>
          <span>Pair Price: <strong>{estimatedPrice}</strong></span>
        </div>
        {#if selectedOrderLevel}
          <p class="size-hint">
            Filled from book level: {selectedOrderLevel.side.toUpperCase()} @ {formatPriceTicks(selectedOrderLevel.priceTicks)}
            (max {formatAmount(selectedOrderLevel.sizeBaseWei, selectedOrderLevel.baseTokenId)} {tokenSymbol(selectedOrderLevel.baseTokenId)})
          </p>
        {:else}
          <p class="size-hint">Click any orderbook row to prefill price and max executable size.</p>
        {/if}
        {#if capacityWarning}
          <p class="size-warning">{capacityWarning}</p>
        {/if}
        {#if leftoverGiveNote}
          <p class="size-hint">{leftoverGiveNote}</p>
        {/if}
      </div>

      {#if autoCapacityNote}
        <p class="auto-capacity-note" data-testid="swap-auto-capacity-note">{autoCapacityNote}</p>
      {/if}

      <button class="primary-btn" on:click={placeSwapOffer} disabled={Boolean(swapActionDisabledReason)}>
        Place Swap Offer
      </button>
      {#if swapActionDisabledReason || submitError}
        <p class="form-error">{submitError || swapActionDisabledReason}</p>
      {/if}
    </div>
  </div>

  <div class="section section-orders">
    <div class="orders-title">
      <h4>Orders</h4>
      <span>{orderListTab === 'open' ? openOrders.length : filteredClosedOrderViews.length}</span>
    </div>
    <div class="orders-toolbar">
      <div class="orders-tabs">
        <button
          class="scope-btn"
          class:active={orderListTab === 'open'}
          on:click={() => (orderListTab = 'open')}
        >
          Open
        </button>
        <button
          class="scope-btn"
          class:active={orderListTab === 'closed'}
          on:click={() => (orderListTab = 'closed')}
        >
          Closed
        </button>
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
                <th>Hub</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {#each openOrders as offer}
                {@const side = offerSideLabel(offer)}
                {@const pairView = resolvePairOrientation(offer.giveTokenId, offer.wantTokenId)}
                {@const isDust = isDustOpenOffer(offer)}
                {@const remainingUsd = remainingOfferUsd(offer)}
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
                <th>Closed At</th>
                <th>Hub</th>
              </tr>
            </thead>
            <tbody>
              {#each filteredClosedOrderViews as order}
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
                    ({formatAmount(order.filledGiveAmount, order.giveTokenId)} {tokenSymbol(order.giveTokenId)})
                  </td>
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
    margin-bottom: 24px;
    padding: 14px;
    background: #131419;
    border-radius: 10px;
    border: 1px solid #2b2f39;
  }

  .trade-grid {
    display: grid;
    grid-template-columns: minmax(0, 1.45fr) minmax(340px, 1fr);
    gap: 14px;
    align-items: start;
  }

  .trade-grid.with-depth {
    grid-template-columns: minmax(0, 1.35fr) minmax(0, 0.9fr) minmax(340px, 1fr);
  }

  .trade-grid > .section {
    margin-bottom: 0;
    min-width: 0;
  }

  .section-market,
  .section-depth,
  .section-order {
    height: 100%;
    min-width: 0;
    overflow: hidden;
  }

  .section-orders {
    margin-top: 14px;
  }

  .swap-toolbar {
    display: flex;
    gap: 8px;
    align-items: center;
    margin-bottom: 10px;
  }

  .toolbar-select {
    position: relative;
    border: 1px solid #2d313b;
    border-radius: 12px;
    background: linear-gradient(180deg, rgba(34, 35, 42, 0.96), rgba(24, 25, 31, 0.96));
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.03);
  }

  .toolbar-select::after {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: inherit;
    pointer-events: none;
    box-shadow: 0 0 0 1px rgba(251, 191, 36, 0.04);
  }

  .toolbar-select-pair {
    flex: 0 0 220px;
  }

  .toolbar-select-account {
    flex: 0 0 170px;
  }

  .toolbar-select-create-account {
    flex: 0 0 160px;
    max-width: 160px;
    transition: opacity 120ms ease;
  }

  .toolbar-select-create-account.is-hidden {
    visibility: hidden;
    pointer-events: none;
  }

  .toolbar-select select {
    width: 100%;
    height: 48px;
    border: 0;
    background: transparent;
    padding: 0 14px;
    font-size: 14px;
    font-weight: 600;
    color: #f3f4f6;
  }

  .order-side-row {
    display: flex;
    justify-content: space-between;
    gap: 10px;
    align-items: center;
    margin-bottom: 12px;
    flex-wrap: wrap;
  }

  .order-side-row .scope-btn {
    min-width: 108px;
    height: 36px;
  }

  .side-toggle-group {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: nowrap;
    margin-left: auto;
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

  .depth-chart {
    border: 1px solid #2f343f;
    border-radius: 10px;
    background: #0f1015;
    padding: 10px;
  }

  .depth-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    color: #9ca3af;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 6px;
  }

  .depth-chart svg {
    width: 100%;
    height: 160px;
    display: block;
    background: linear-gradient(180deg, rgba(255, 255, 255, 0.02), transparent);
    border-radius: 8px;
  }

  .depth-line {
    fill: none;
    stroke-width: 1.6;
  }

  .depth-line.bid {
    stroke: #22c55e;
  }

  .depth-line.ask {
    stroke: #ef4444;
  }

  .depth-empty {
    color: #9ca3af;
    font-size: 12px;
    padding: 12px;
    text-align: center;
  }

  .form-row {
    display: flex;
    gap: 12px;
    margin-bottom: 12px;
    flex-wrap: wrap;
  }

  .form-row.compact {
    align-items: flex-end;
  }

  .form-row.compact .scope-btn {
    height: 36px;
    white-space: nowrap;
    flex: 0 0 auto;
  }

  .form-row label {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12px;
    color: #9ca3af;
  }

  select, input {
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

  select:focus, input:focus {
    outline: none;
    border-color: rgba(251, 191, 36, 0.65);
  }

  .order-entry-row {
    display: grid;
    grid-template-columns: minmax(0, 1.15fr) minmax(0, 0.95fr) minmax(0, 1fr);
    gap: 12px;
    align-items: start;
    margin-bottom: 10px;
  }

  .order-field {
    margin: 0;
    padding: 9px 10px 10px;
    border: 1px solid #2f343f;
    border-radius: 12px;
    background: linear-gradient(180deg, rgba(18, 19, 24, 0.96), rgba(14, 15, 20, 0.96));
    gap: 8px;
    color: #a1a1aa;
    font-size: 11px;
    font-weight: 600;
  }

  .order-field-amount {
    grid-column: 1;
  }

  .order-field-price {
    grid-column: 2;
  }

  .order-field-receive {
    grid-column: 3;
  }

  .order-field input {
    height: 42px;
    padding: 0 12px;
    background: #17181d;
    border-color: #333844;
    font-size: 14px;
  }

  .slider-inline {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: 8px;
    margin: 0 0 12px;
    padding: 8px 10px;
    border: 1px solid #2f343f;
    border-radius: 12px;
    background: #101116;
  }

  .readonly-input {
    background: #0a0b0f;
    border-style: dashed;
    color: #cbd5e1;
    cursor: not-allowed;
  }

  .primary-btn {
    width: 100%;
    padding: 10px;
    background: linear-gradient(180deg, rgba(251, 191, 36, 0.18), rgba(217, 119, 6, 0.12));
    border: 1px solid rgba(251, 191, 36, 0.55);
    border-radius: 8px;
    color: #fde68a;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s;
  }

  @media (max-width: 980px) {
    .order-side-row {
      justify-content: flex-start;
    }

    .side-toggle-group {
      margin-left: 0;
    }
  }

  .primary-btn:hover {
    background: linear-gradient(180deg, rgba(251, 191, 36, 0.28), rgba(217, 119, 6, 0.2));
    border-color: rgba(251, 191, 36, 0.75);
  }

  .primary-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .size-tools {
    margin: 0 0 14px;
    padding: 10px;
    border: 1px solid #2f343f;
    border-radius: 8px;
    background: #101116;
  }

  .size-top {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
  }

  .size-title {
    color: #d1d5db;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.03em;
    text-transform: uppercase;
  }

  .size-min-fill {
    color: #9ca3af;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .size-stats {
    margin-top: 8px;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
    gap: 6px 12px;
    font-size: 12px;
    color: #9ca3af;
  }

  .size-stats strong {
    color: #f3f4f6;
    font-weight: 600;
  }

  .size-slider {
    width: 100%;
    accent-color: #f59e0b;
    appearance: none;
    -webkit-appearance: none;
    height: 6px;
    border-radius: 999px;
    background: linear-gradient(180deg, #fbbf24, #d97706);
    outline: none;
  }

  .size-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 14px;
    height: 14px;
    border-radius: 999px;
    background: #fbbf24;
    border: 2px solid #111217;
    box-shadow: 0 0 0 1px rgba(251, 191, 36, 0.7);
    cursor: pointer;
  }

  .size-slider::-moz-range-thumb {
    width: 14px;
    height: 14px;
    border-radius: 999px;
    background: #fbbf24;
    border: 2px solid #111217;
    box-shadow: 0 0 0 1px rgba(251, 191, 36, 0.7);
    cursor: pointer;
  }

  .slider-value {
    min-width: 44px;
    text-align: right;
    color: #fbbf24;
    font-size: 12px;
    font-weight: 700;
    font-family: 'JetBrains Mono', monospace;
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

  .orders-title {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 10px;
  }

  .orders-title span {
    color: #9ca3af;
    font-size: 12px;
  }

  .orders-toolbar {
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
    gap: 10px;
    margin-bottom: 10px;
    flex-wrap: wrap;
  }

  .orders-tabs {
    display: inline-flex;
    gap: 8px;
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

  @media (max-width: 1480px) {
    .trade-grid.with-depth {
      grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr);
    }

    .section-depth {
      grid-column: 1 / -1;
    }
  }

  @media (max-width: 1100px) {
    .trade-grid,
    .trade-grid.with-depth {
      grid-template-columns: 1fr;
      gap: 12px;
    }

    .section-orders {
      margin-top: 12px;
    }
  }

  @media (max-width: 900px) {
    .toolbar-select-pair,
    .toolbar-select-account {
      flex: 1 1 0;
      min-width: 0;
    }

    .form-row {
      flex-direction: column;
    }

    .order-entry-row {
      grid-template-columns: 1fr;
    }

    .order-field-amount,
    .order-field-price,
    .order-field-receive {
      grid-column: auto;
    }

  }
</style>
