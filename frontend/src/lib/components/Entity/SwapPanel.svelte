  <script lang="ts">
    import type { EntityReplica, Tab } from '$lib/types/ui';
    import { getXLN, xlnEnvironment, xlnFunctions } from '../../stores/xlnStore';
    import { isLive as globalIsLive } from '../../stores/timeStore';
    import { getEntityEnv, hasEntityEnvContext } from '$lib/view/components/entity/shared/EntityEnvContext';
    import { requireSignerIdForEntity } from '$lib/utils/entityReplica';
    import EntitySelect from './EntitySelect.svelte';
    import OrderbookPanel from '../Trading/OrderbookPanel.svelte';

  export let replica: EntityReplica | null;
  export let tab: Tab;

  // Props
  export let counterpartyId: string = '';
  export let prefilledCounterparty = false;
  let orderbookScope: 'all' | 'selected' = 'all';
  const ORDERBOOK_PRICE_SCALE = 100n;
  const ORDERBOOK_LOT_SCALE = 10n ** 12n;
  const PRICE_RATIO_DECIMALS = 6;
  const PRICE_RATIO_SCALE = 10n ** BigInt(PRICE_RATIO_DECIMALS);
  type BookSide = 'bid' | 'ask';
  type ClickedOrderLevel = {
    side: BookSide;
    priceTicks: bigint;
    sizeBaseWei: bigint;
    baseTokenId: number;
    quoteTokenId: number;
    accountId: string;
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
  let orderPercent = 100;
  let submitError = '';
  let selectedPairValue = '';
  let pairSearchInput = '';
  let tradeSide: 'buy-base' | 'sell-base' = 'buy-base';
  let selectedPair: PairOption | null = null;
  let giveTokenId = '1';
  let wantTokenId = '2';
  let orderAmountInput = '';
  let priceRatioInput = '';
  let giveAmount: bigint = 0n;
  let wantAmount: bigint = 0n;
  let parsedOrderbookPair: { baseTokenId: number; quoteTokenId: number } | null = null;
  let orderMode: 'buy-base' | 'sell-base' | 'none' = 'none';
  let limitPriceTicks: bigint | null = null;
  let priceRatioScaled = 0n;
  let minFillPercent = '50'; // Min fill ratio as percentage (0-100)
  let showDepthChart = false;

    const entityEnv = hasEntityEnvContext() ? getEntityEnv() : null;
    const contextXlnFunctions = entityEnv?.xlnFunctions;
    const contextEnv = entityEnv?.env;
    const contextIsLive = entityEnv?.isLive;
    $: activeXlnFunctions = contextXlnFunctions ? $contextXlnFunctions : $xlnFunctions;
    $: activeEnv = contextEnv ? $contextEnv : $xlnEnvironment;
    $: activeIsLive = contextIsLive ? $contextIsLive : $globalIsLive;

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
  $: if (orderbookScope === 'selected' && !counterpartyId) {
    orderbookScope = 'all';
  }
  $: orderbookHubIds = orderbookScope === 'selected'
    ? (counterpartyId ? [counterpartyId] : [])
    : cappedAccountIds;

  function resolveCounterpartyId(input: string): string {
    const normalized = String(input || '').trim().toLowerCase();
    if (!normalized) return '';
    const match = accountIds.find((id) => String(id || '').toLowerCase() === normalized);
    return match || String(input || '').trim();
  }
  $: orderbookHint = (() => {
    if (orderbookScope === 'selected') {
      return counterpartyId
        ? 'Showing selected account orderbook.'
        : 'Select account to view selected orderbook.';
    }
    if (orderbookHubIds.length === 0) {
      return 'Select account to trade. No orderbook sources yet.';
    }
    const hidden = hiddenAccountCount > 0 ? ` (+${hiddenAccountCount} hidden)` : '';
    return `Showing aggregate orderbook across ${orderbookHubIds.length} account(s)${hidden}. Select account to place orders.`;
  })();

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
      pairSearchInput = pairOptions[0]!.label;
    } else {
      const current = pairOptions.find((option) => option.value === selectedPairValue);
      if (current) pairSearchInput = current.label;
    }
  }
  $: selectedPair = pairOptions.find((option) => option.value === selectedPairValue) || null;

  function setPairBySearch(raw: string): void {
    const normalized = String(raw || '').trim().toLowerCase();
    if (!normalized) return;
    const exact = pairOptions.find((option) => option.label.toLowerCase() === normalized);
    if (exact) {
      selectedPairValue = exact.value;
      pairSearchInput = exact.label;
      return;
    }
    const partial = pairOptions.find((option) => option.label.toLowerCase().includes(normalized));
    if (partial) {
      selectedPairValue = partial.value;
      pairSearchInput = partial.label;
    }
  }

  function handlePairSearchInput(event: Event): void {
    const target = event.currentTarget as HTMLInputElement | null;
    const next = String(target?.value || '');
    pairSearchInput = next;
    setPairBySearch(next);
  }

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
    const frac = (ticks % ORDERBOOK_PRICE_SCALE).toString().padStart(2, '0').replace(/0+$/, '');
    return frac.length > 0 ? `${whole.toString()}.${frac}` : whole.toString();
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

  // Get active swap offers for this entity
  $: activeOffers = replica?.state?.swapBook
    ? Array.from(replica.state.swapBook.values())
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

  function computeRawOutPeerDebt(delta: DeltaLike, isLeft: boolean): bigint {
    const totalDelta = (toBigIntSafe(delta.ondelta) ?? 0n) + (toBigIntSafe(delta.offdelta) ?? 0n);
    const collateral = nonNegative(toBigIntSafe(delta.collateral) ?? 0n);
    if (isLeft) return nonNegative(totalDelta - collateral);
    return nonNegative(-totalDelta - collateral);
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
      const derived = activeXlnFunctions.deriveDelta(delta, isLeft) as { inCapacity?: unknown; inPeerCredit?: unknown };
      const inCapacity = nonNegative(toBigIntSafe(derived.inCapacity) ?? 0n);
      if (inCapacity >= desiredInboundAmount) return null;

      const inPeerCredit = nonNegative(toBigIntSafe(derived.inPeerCredit) ?? 0n);
      const inWithoutPeerCredit = inCapacity > inPeerCredit ? inCapacity - inPeerCredit : 0n;
      const neededPeerCredit = desiredInboundAmount > inWithoutPeerCredit ? desiredInboundAmount - inWithoutPeerCredit : 0n;

      const currentPeerLimit = readPeerCreditLimit(resolvedCounterparty, tokenIdValue);
      const rawOutPeerDebt = computeRawOutPeerDebt(delta, isLeft);
      const targetPeerLimit = rawOutPeerDebt + neededPeerCredit;
      if (targetPeerLimit > currentPeerLimit) return targetPeerLimit;

      // Conservative fallback: ensure forward progress even if derived decomposition is stale between frames.
      return currentPeerLimit + (desiredInboundAmount - inCapacity);
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
  $: wantTokenPresentInAccount = hasTokenInAccount(counterpartyId, wantToken);
  $: availableGiveCapacity = readOutCapacity(counterpartyId, giveToken);
  $: availableWantInCapacity = readInCapacity(counterpartyId, wantToken);
  $: formattedAvailableGive = Number.isFinite(giveToken) && giveToken > 0
    ? `${formatAmount(availableGiveCapacity, giveToken)} ${giveTokenSymbol}`
    : availableGiveCapacity.toString();
  $: formattedAvailableWantIn = Number.isFinite(wantToken) && wantToken > 0
    ? `${formatAmount(availableWantInCapacity, wantToken)} ${wantTokenSymbol}`
    : availableWantInCapacity.toString();
  $: estimatedPrice = priceRatioScaled > 0n ? formatScaled(priceRatioScaled, PRICE_RATIO_DECIMALS) : 'n/a';
  $: estimatedReceiveLabel = Number.isFinite(wantToken) && wantToken > 0
    ? `${formatAmount(wantAmount, wantToken)} ${wantTokenSymbol}`
    : wantAmount.toString();
  $: estimatedSpendLabel = Number.isFinite(giveToken) && giveToken > 0
    ? `${formatAmount(giveAmount, giveToken)} ${giveTokenSymbol}`
    : giveAmount.toString();
  $: autoInboundCreditTarget = computeAutoInboundCreditTarget(counterpartyId, wantToken, wantAmount);
  $: currentPeerCreditLimit = readPeerCreditLimit(counterpartyId, wantToken);
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
    minFillPercent: string;
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
    if (!input.wantTokenPresentInAccount) {
      return 'Inbound token is not active in this account. Add token capacity first.';
    }
    if (input.giveAmount > input.availableGiveCapacity) {
      return `Insufficient outbound capacity (${input.formattedAvailableGive}).`;
    }
    if (input.wantAmount > input.availableWantInCapacity) {
      return `Insufficient inbound capacity (${input.formattedAvailableWantIn}).`;
    }
    const minFillPercentValue = Number.parseFloat(input.minFillPercent);
    if (!Number.isFinite(minFillPercentValue) || minFillPercentValue < 1 || minFillPercentValue > 100) {
      return 'Min Fill % must be between 1 and 100.';
    }
    return '';
  }

  $: swapDisabledReason = validateSwapForm({
    isLive: activeIsLive,
    entityId: String(tab.entityId || ''),
    counterpartyId: String(counterpartyId || ''),
    accountIds,
    giveToken,
    wantToken,
    giveAmount,
    priceRatioScaled,
    limitPriceTicks,
    wantAmount,
    wantTokenPresentInAccount,
    availableGiveCapacity,
    availableWantInCapacity,
    formattedAvailableGive,
    formattedAvailableWantIn,
    minFillPercent,
  });
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
  $: capacityWarning = (() => {
    if (!counterpartyId || !Number.isFinite(giveToken) || giveToken <= 0) return '';
    if (availableGiveCapacity <= 0n) return `Observed available ${giveTokenSymbol}: 0 (may update after next frame).`;
    if (giveAmount > 0n && giveAmount > availableGiveCapacity) {
      return `Give amount is above observed available capacity (${formattedAvailableGive}).`;
    }
    return '';
  })();
  $: if (selectedOrderLevel && selectedOrderLevel.accountId !== counterpartyId) {
    selectedOrderLevel = null;
    orderPercent = 100;
  }

  function applyOrderPercent(percent: number) {
    if (!selectedOrderLevel) return;
    const clamped = Math.max(0, Math.min(100, Math.round(percent)));
    orderPercent = clamped;

    const priceScaled = (selectedOrderLevel.priceTicks * PRICE_RATIO_SCALE) / ORDERBOOK_PRICE_SCALE;
    const levelBaseDecimals = getTokenDecimals(selectedOrderLevel.baseTokenId);
    const levelQuoteDecimals = getTokenDecimals(selectedOrderLevel.quoteTokenId);
    const availableBase = selectedOrderLevel.side === 'ask'
      ? (
          selectedOrderLevel.priceTicks > 0n
            ? (readOutCapacity(selectedOrderLevel.accountId, selectedOrderLevel.quoteTokenId) * ORDERBOOK_PRICE_SCALE) / selectedOrderLevel.priceTicks
            : 0n
        )
      : readOutCapacity(selectedOrderLevel.accountId, selectedOrderLevel.baseTokenId);
    const maxFillBase = availableBase < selectedOrderLevel.sizeBaseWei ? availableBase : selectedOrderLevel.sizeBaseWei;
    const fillBase = (maxFillBase * BigInt(clamped)) / 100n;
    const fillGive = selectedOrderLevel.side === 'ask'
      ? quoteFromBase(fillBase, priceScaled, levelBaseDecimals, levelQuoteDecimals)
      : fillBase;

    orderAmountInput = formatAmount(fillGive, Number.parseInt(giveTokenId, 10));
    priceRatioInput = formatPriceTicks(selectedOrderLevel.priceTicks);
  }

  function handleOrderPercentInput(event: Event) {
    const target = event.currentTarget as HTMLInputElement | null;
    const value = Number.parseInt(String(target?.value || ''), 10);
    applyOrderPercent(Number.isFinite(value) ? value : 0);
  }

  function setMaxOrderPercent() {
    if (selectedOrderLevel) {
      applyOrderPercent(100);
      return;
    }
    if (availableGiveCapacity <= 0n) return;
    orderAmountInput = formatAmount(availableGiveCapacity, giveToken);
  }

  function handleOrderbookSnapshot(event: CustomEvent<OrderbookSnapshot>) {
    orderbookSnapshot = event.detail;
  }

  function handleOrderbookLevelClick(event: CustomEvent<{ side: BookSide; price: number; size: number }>) {
    submitError = '';
    if (!counterpartyId) {
      submitError = 'Select account first, then click an orderbook level.';
      return;
    }

    const pair = selectedPair;
    if (!pair) {
      submitError = 'Select valid token pair first.';
      return;
    }

    const side = event.detail?.side;
    const rawPrice = Number(event.detail?.price || 0);
    const rawSize = Number(event.detail?.size || 0);
    if ((side !== 'ask' && side !== 'bid') || !Number.isFinite(rawPrice) || rawPrice <= 0 || !Number.isFinite(rawSize) || rawSize <= 0) {
      return;
    }

    const priceTicks = BigInt(Math.max(1, Math.floor(rawPrice)));
    const sizeBaseWei = lotsToBaseWei(rawSize);
    selectedOrderLevel = {
      side,
      priceTicks,
      sizeBaseWei,
      baseTokenId: pair.baseTokenId,
      quoteTokenId: pair.quoteTokenId,
      accountId: counterpartyId,
    };

    tradeSide = side === 'ask' ? 'buy-base' : 'sell-base';
    applyOrderPercent(100);
  }

  // Convert percentage to fill ratio (0-65535)
  function percentToFillRatio(percent: number): number {
    return Math.floor((percent / 100) * 65535);
  }

  function resolveSignerId(entityId: string): string {
    return activeXlnFunctions?.resolveEntityProposerId?.(activeEnv as any, entityId, 'swap-panel')
      || requireSignerIdForEntity(activeEnv, entityId, 'swap-panel');
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
  $: depthLevels = (() => {
    const bids = orderbookSnapshot.bids.slice(0, 12);
    const asks = orderbookSnapshot.asks.slice(0, 12);
    return { bids, asks };
  })();

  function buildDepthPolyline(levels: SnapshotLevel[], side: 'bid' | 'ask'): string {
    if (levels.length === 0) return '';
    const ordered = side === 'bid' ? [...levels].reverse() : [...levels];
    const allPrices = [...depthLevels.bids.map(l => l.price), ...depthLevels.asks.map(l => l.price)];
    const minPrice = Math.min(...allPrices);
    const maxPrice = Math.max(...allPrices);
    const priceRange = Math.max(1, maxPrice - minPrice);
    const maxTotal = Math.max(
      1,
      ...depthLevels.bids.map(l => l.total),
      ...depthLevels.asks.map(l => l.total),
    );
    return ordered
      .map(level => {
        const x = ((level.price - minPrice) / priceRange) * 100;
        const y = 100 - (level.total / maxTotal) * 100;
        return `${x.toFixed(2)},${y.toFixed(2)}`;
      })
      .join(' ');
  }

  $: bidDepthPolyline = buildDepthPolyline(depthLevels.bids, 'bid');
  $: askDepthPolyline = buildDepthPolyline(depthLevels.asks, 'ask');

  function offerSideLabel(offer: any): 'Ask' | 'Bid' {
    const give = Number(offer?.giveTokenId || 0);
    const want = Number(offer?.wantTokenId || 0);
    const pair = resolvePairOrientation(give, want);
    return give === pair.baseTokenId ? 'Ask' : 'Bid';
  }

  function offerPriceTicks(offer: any): bigint {
    const give = toBigIntSafe(offer?.giveAmount) ?? 0n;
    const want = toBigIntSafe(offer?.wantAmount) ?? 0n;
    if (give <= 0n || want <= 0n) return 0n;
    const isAsk = offerSideLabel(offer) === 'Ask';
    return isAsk ? (want * ORDERBOOK_PRICE_SCALE) / give : (give * ORDERBOOK_PRICE_SCALE) / want;
  }

  $: openOrders = [...activeOffers].sort((a: any, b: any) => {
    const aCreated = toBigIntSafe((a as any)?.createdAt) ?? 0n;
    const bCreated = toBigIntSafe((b as any)?.createdAt) ?? 0n;
    if (aCreated === bCreated) return String(a?.offerId || '').localeCompare(String(b?.offerId || ''));
    return aCreated > bCreated ? -1 : 1;
  });

  async function placeSwapOffer() {
    submitError = '';
    if (swapActionDisabledReason) {
      submitError = swapActionDisabledReason;
      return;
    }

    try {
      const xln = await getXLN();
      const env = activeEnv;
      if (!env) throw new Error('XLN environment not ready');
      if (!isRuntimeEnv(env)) throw new Error('Runtime environment not available');
      if (!activeIsLive) throw new Error('Swap actions are only available in LIVE mode');
      const signerId = resolveSignerId(tab.entityId);
      if (!signerId) throw new Error('No signer available for selected entity');

      const resolvedCounterparty = resolveCounterpartyId(counterpartyId);
      if (!resolvedCounterparty) {
        throw new Error('Select counterparty from your account list');
      }

      const giveToken = Number.parseInt(giveTokenId, 10);
      const wantToken = Number.parseInt(wantTokenId, 10);
      const effectiveGiveAmount = giveAmount;
      const effectiveWantAmount = wantAmount;
      if (effectiveGiveAmount <= 0n || effectiveWantAmount <= 0n) {
        throw new Error('Enter amount and limit price');
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

      const minFillPercentValue = Number.parseFloat(minFillPercent);
      if (!Number.isFinite(minFillPercentValue) || minFillPercentValue < 1 || minFillPercentValue > 100) {
        throw new Error('Min Fill % must be between 1 and 100');
      }

      const offerId = `swap-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      const minFillRatio = percentToFillRatio(minFillPercentValue);
      const requiredInboundCreditLimit = computeAutoInboundCreditTarget(
        resolvedCounterparty,
        wantToken,
        effectiveWantAmount,
      );
      const currentInboundCreditLimit = readPeerCreditLimit(resolvedCounterparty, wantToken);
      const shouldAutoPrepareInbound = (
        requiredInboundCreditLimit !== null
        && requiredInboundCreditLimit > currentInboundCreditLimit
        && isInboundCapacityValidationError(swapDisabledReason)
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
          minFillRatio,
        },
      });

      xln.enqueueRuntimeInput(env, { runtimeTxs: [], entityInputs: [{
        entityId: tab.entityId,
        signerId,
        entityTxs,
      }] });

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
      const xln = await getXLN();
      const env = activeEnv;
      if (!env) throw new Error('XLN environment not ready');
      if (!isRuntimeEnv(env)) throw new Error('Runtime environment not available');
      if (!activeIsLive) throw new Error('Swap actions are only available in LIVE mode');
      const signerId = resolveSignerId(tab.entityId);
      if (!signerId) throw new Error('No signer available for selected entity');

      xln.enqueueRuntimeInput(env, { runtimeTxs: [], entityInputs: [{
        entityId: tab.entityId,
        signerId,
        entityTxs: [{
          type: 'proposeCancelSwap',
          data: {
            offerId,
            counterpartyEntityId: accountId, // accountId is the counterparty entity ID
          }
        }]
      }] });

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
</script>

<div class="swap-panel">
  <h3>Swap Trading</h3>

  <div class="section">
    <div class="orderbook-header">
      <h4>Orderbook</h4>
      <div class="scope-toggle">
        <button
          class="scope-btn"
          class:active={orderbookScope === 'all'}
          on:click={() => (orderbookScope = 'all')}
        >
          All Accounts
        </button>
        <button
          class="scope-btn"
          class:active={orderbookScope === 'selected'}
          disabled={!counterpartyId}
          on:click={() => (orderbookScope = 'selected')}
        >
          Selected Account
        </button>
      </div>
    </div>
    {#if !prefilledCounterparty}
      <div class="form-row compact">
        <label>
          Account (Hub)
          <EntitySelect bind:value={counterpartyId} options={accountIds} placeholder="Select account" />
        </label>
      </div>
    {/if}

    <div class="form-row compact">
      <label>
        Pair
        <input
          list="swap-pair-options"
          bind:value={pairSearchInput}
          inputmode="search"
          placeholder="Search pair (e.g. WETH/USDC)"
          data-testid="swap-pair-search"
          on:input={handlePairSearchInput}
        />
        <datalist id="swap-pair-options">
          {#each pairOptions as pair (pair.value)}
            <option value={pair.label}>{pair.label}</option>
          {/each}
        </datalist>
      </label>
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
      <button
        type="button"
        class="scope-btn"
        class:active={showDepthChart}
        data-testid="swap-depth-chart-toggle"
        on:click={() => (showDepthChart = !showDepthChart)}
      >
        {showDepthChart ? 'Hide Depth' : 'Show Depth'}
      </button>
    </div>

    <p class="orderbook-hint">
      Pair: {baseTokenSymbol}/{quoteTokenSymbol}. Price is quoted in {quoteTokenSymbol} per {baseTokenSymbol}.
      {orderbookHint}
    </p>
    {#if orderbookHubIds.length > 0}
      <div class="orderbook-wrap" data-testid="swap-orderbook">
        <OrderbookPanel
          hubIds={orderbookHubIds}
          hubId={counterpartyId}
          pairId={orderbookPairId}
          pairLabel={selectedPair?.label || `${baseTokenSymbol}/${quoteTokenSymbol}`}
          depth={12}
          priceScale={Number(ORDERBOOK_PRICE_SCALE)}
          sizeDisplayScale={orderbookSizeDisplayScale}
          on:levelclick={handleOrderbookLevelClick}
          on:snapshot={handleOrderbookSnapshot}
        />
      </div>
      {#if showDepthChart}
        <div class="depth-chart" data-testid="swap-depth-chart">
          <div class="depth-header">
            <span>Depth Chart</span>
            <span>{orderbookPairId}</span>
          </div>
          {#if bidDepthPolyline || askDepthPolyline}
            <svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="Orderbook depth chart">
              {#if bidDepthPolyline}
                <polyline points={bidDepthPolyline} class="depth-line bid" />
              {/if}
              {#if askDepthPolyline}
                <polyline points={askDepthPolyline} class="depth-line ask" />
              {/if}
            </svg>
          {:else}
            <div class="depth-empty">No depth available yet.</div>
          {/if}
        </div>
      {/if}
    {:else}
      <div class="orderbook-empty">No connected account orderbooks yet.</div>
    {/if}
  </div>

  <div class="section">
    <h4>Place Limit Order</h4>

    <div class="form-row">
      <label>
        {tradeSide === 'buy-base' ? 'Amount to Spend' : 'Amount to Sell'} ({giveTokenSymbol})
        <input type="text" bind:value={orderAmountInput} inputmode="decimal" placeholder="Amount to sell" />
      </label>
      <label>
        Price ({quoteTokenSymbol} per {baseTokenSymbol})
        <input
          type="text"
          bind:value={priceRatioInput}
          inputmode="decimal"
          placeholder="Price"
          on:input={handlePriceRatioInput}
        />
      </label>
      <label>
        Amount to Receive ({wantTokenSymbol})
        <input
          type="text"
          readonly
          value={`${formatAmount(wantAmount, wantToken)} ${wantTokenSymbol}`}
          class="readonly-input"
        />
      </label>
    </div>

    <div class="size-tools">
      <div class="size-top">
        <span class="size-title">Order Sizing</span>
        <button class="max-btn" type="button" on:click={setMaxOrderPercent} disabled={availableGiveCapacity <= 0n}>Max</button>
      </div>
      <div class="size-stats">
        <span>Available: <strong>{formattedAvailableGive}</strong></span>
        <span>Inbound Capacity: <strong>{formattedAvailableWantIn}</strong></span>
        <span>Estimate: <strong>{estimatedSpendLabel} → {estimatedReceiveLabel}</strong></span>
        <span>Pair Price: <strong>{estimatedPrice}</strong></span>
      </div>
      <div class="slider-row">
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
    </div>

    <div class="form-row compact">
      <label>
        Min Fill %
        <input type="number" bind:value={minFillPercent} min="1" max="100" placeholder="50" />
      </label>
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

  <div class="section">
    <div class="orders-title">
      <h4>Open Orders</h4>
      <span>{openOrders.length}</span>
    </div>
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
              <tr>
                <td>
                  <span class:side-ask={side === 'Ask'} class:side-bid={side === 'Bid'} class="side-badge">{side}</span>
                </td>
                <td>{tokenSymbol(pairView.baseTokenId)}/{tokenSymbol(pairView.quoteTokenId)}</td>
                <td>{formatPriceTicks(offerPriceTicks(offer))}</td>
                <td>
                  {formatAmount(offer.giveAmount, offer.giveTokenId)} {tokenSymbol(offer.giveTokenId)}
                </td>
                <td>{offer.accountId.slice(0, 10)}...</td>
                <td>
                  <button class="cancel-btn" on:click={() => cancelSwapOffer(offer.offerId, offer.accountId)}>
                    Request Cancel
                  </button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
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

  .orderbook-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  }

  .scope-toggle {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }

  .side-toggle-group {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
  }

  .scope-btn {
    padding: 6px 10px;
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

  .orderbook-hint {
    margin: 6px 0 10px;
    color: #9ca3af;
    font-size: 12px;
    line-height: 1.45;
  }

  .orderbook-empty {
    border: 1px dashed #3f434d;
    border-radius: 8px;
    padding: 10px 12px;
    color: #9ca3af;
    font-size: 12px;
  }

  .depth-chart {
    margin-top: 12px;
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
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12px;
    color: #9ca3af;
  }

  select, input {
    padding: 8px;
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

  .primary-btn:hover {
    background: linear-gradient(180deg, rgba(251, 191, 36, 0.28), rgba(217, 119, 6, 0.2));
    border-color: rgba(251, 191, 36, 0.75);
  }

  .primary-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .size-tools {
    margin: 8px 0 14px;
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

  .max-btn {
    padding: 5px 10px;
    border-radius: 6px;
    border: 1px solid #4b5563;
    background: #161922;
    color: #d1d5db;
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
  }

  .max-btn:hover:not(:disabled) {
    border-color: #fbbf24;
    color: #fbbf24;
  }

  .max-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
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

  .slider-row {
    margin-top: 10px;
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 10px;
    align-items: center;
  }

  .size-slider {
    width: 100%;
    accent-color: #f59e0b;
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

  .orders-empty {
    border: 1px dashed #3f434d;
    border-radius: 8px;
    padding: 10px 12px;
    color: #9ca3af;
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

  @media (max-width: 900px) {
    .form-row {
      flex-direction: column;
    }
  }
</style>
