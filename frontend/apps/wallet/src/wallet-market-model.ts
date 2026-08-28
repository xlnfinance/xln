import type { WalletMarketActivityEvent, WalletMarketActivityKind } from './wallet-market-activity';
import { decodeWalletMarketActivity } from './wallet-market-activity';
import {
  decodeWalletPaymentProjection,
  type WalletPaymentMath,
  type WalletPaymentProjection,
} from './wallet-payment-model';
import {
  normalizeRequiredRuntimeEntityId,
  optionalRuntimeMap,
  requireRuntimeBigInt,
  requireRuntimeEnum,
  requireRuntimeInteger,
  requireRuntimeMap,
  requireRuntimeRecord,
  requireRuntimeString,
} from './wallet-runtime-decode';

export type WalletMarketHub = Readonly<{
  entityId: string;
  label: string;
  feeBps: number | null;
}>;

export type WalletMarketLevel = Readonly<{
  priceTicks: bigint;
  priceLabel: string;
  quantityLots: bigint;
  orderCount: number;
}>;

export type WalletMarketPair = Readonly<{
  pairId: string;
  baseTokenId: number;
  quoteTokenId: number;
  label: string;
  bids: readonly WalletMarketLevel[];
  asks: readonly WalletMarketLevel[];
  tradeCount: number;
  lastTradePriceLabel: string;
}>;

export type WalletMarketOpenOrder = Readonly<{
  offerId: string;
  hubEntityId: string;
  sideLabel: string;
  giveLabel: string;
  wantLabel: string;
  priceLabel: string;
  timeInForceLabel: 'GTC' | 'IOC' | 'FOK';
  createdHeight: number;
}>;

export type WalletCrossMarketRoute = Readonly<{
  orderId: string;
  status: string;
  sourceLabel: string;
  targetLabel: string;
  updatedAt: number;
  expiresAt: number;
}>;

export type WalletMarketProjection = WalletPaymentProjection & Readonly<{
  logicalTimestamp: number;
  hubs: readonly WalletMarketHub[];
  selectedHubId: string;
  pairs: readonly WalletMarketPair[];
  selectedPairId: string;
  openOrders: readonly WalletMarketOpenOrder[];
  crossRoutes: readonly WalletCrossMarketRoute[];
  activity: readonly WalletMarketActivityEvent[];
  activityKind: WalletMarketActivityKind;
  activityPage: number;
  activityNextBeforeHeight: number | null;
}>;

export type WalletMarketContext = Readonly<{
  payment: WalletPaymentProjection;
  logicalTimestamp: number;
  hubs: readonly WalletMarketHub[];
}>;

export type WalletMarketPayload = Readonly<{
  activeFrame: unknown;
  hubFrame: unknown;
  activity: unknown;
  selectedHubId: string;
  selectedPairId: string;
  activityKind: WalletMarketActivityKind;
  activityPage: number;
}>;

const readCore = (frame: unknown, label: string): Record<string, unknown> => {
  const root = requireRuntimeRecord(frame, `${label}_FRAME`);
  const active = requireRuntimeRecord(root['activeEntity'], `${label}_ACTIVE_ENTITY`);
  return requireRuntimeRecord(active['core'], `${label}_CORE`);
};

export const decodeWalletMarketContext = (
  frame: unknown,
  math: WalletPaymentMath,
): WalletMarketContext => {
  const payment = decodeWalletPaymentProjection(frame, math);
  if (!payment.activeEntityId) return { payment, logicalTimestamp: 0, hubs: [] };
  const root = requireRuntimeRecord(frame, 'WALLET_MARKET_FRAME');
  if (!Array.isArray(root['entities'])) throw new Error('WALLET_MARKET_ENTITIES_INVALID');
  const hubIds = new Set(root['entities'].flatMap((value): string[] => {
    const entity = requireRuntimeRecord(value, 'WALLET_MARKET_ENTITY');
    return entity['isHub'] === true
      ? [normalizeRequiredRuntimeEntityId(entity['entityId'], 'WALLET_MARKET_HUB_ID')]
      : [];
  }));
  const labels = new Map(payment.entities.map(({ entityId, label }) => [entityId, label]));
  const usableRecipients = new Set(payment.recipients
    .filter(({ blocked }) => !blocked)
    .map(({ entityId }) => entityId));
  const hubs = payment.accounts
    .filter(({ counterpartyId }) => hubIds.has(counterpartyId) && usableRecipients.has(counterpartyId))
    .map(({ counterpartyId }): WalletMarketHub => ({
      entityId: counterpartyId,
      label: labels.get(counterpartyId) ?? counterpartyId,
      feeBps: null,
    }));
  const core = readCore(frame, 'WALLET_MARKET');
  return {
    payment,
    logicalTimestamp: requireRuntimeInteger(core['timestamp'], 'WALLET_MARKET_TIMESTAMP'),
    hubs,
  };
};

const selectedHubFee = (hubFrame: unknown, hubEntityId: string): number => {
  const core = readCore(hubFrame, 'WALLET_MARKET_HUB');
  if (normalizeRequiredRuntimeEntityId(core['entityId'], 'WALLET_MARKET_HUB_CORE_ID') !== hubEntityId) {
    throw new Error('WALLET_MARKET_HUB_FRAME_MISMATCH');
  }
  const profile = requireRuntimeRecord(core['profile'], 'WALLET_MARKET_HUB_PROFILE');
  if (profile['isHub'] !== true) throw new Error('WALLET_MARKET_COUNTERPARTY_NOT_HUB');
  const config = requireRuntimeRecord(core['hubRebalanceConfig'], 'WALLET_MARKET_HUB_CONFIG');
  return requireRuntimeInteger(config['swapTakerFeeBps'], 'WALLET_MARKET_HUB_FEE_BPS');
};

const pairTokenIds = (pairId: string): readonly [number, number] => {
  const match = /^(\d+)\/(\d+)$/.exec(pairId);
  if (!match) throw new Error(`WALLET_MARKET_PAIR_ID_INVALID:${pairId}`);
  const base = requireRuntimeInteger(Number(match[1]), 'WALLET_MARKET_PAIR_BASE', 1);
  const quote = requireRuntimeInteger(Number(match[2]), 'WALLET_MARKET_PAIR_QUOTE', 1);
  if (base === quote) throw new Error('WALLET_MARKET_PAIR_TOKENS_EQUAL');
  return [base, quote];
};

const priceFromPortableKey = (value: unknown): bigint => {
  const key = requireRuntimeString(value, 'WALLET_MARKET_BOOK_KEY').toLowerCase();
  if (!/^0x(?:[0-9a-f]{2})+$/.test(key)) throw new Error('WALLET_MARKET_BOOK_KEY_INVALID');
  const bytes = key.slice(2).match(/../g)?.map((hex) => Number.parseInt(hex, 16)) ?? [];
  const priceLength = bytes[0] ?? 0;
  if (priceLength <= 0 || bytes.length !== priceLength + 3 || bytes[1] === 0) {
    throw new Error('WALLET_MARKET_BOOK_KEY_LENGTH_INVALID');
  }
  return bytes.slice(1, priceLength + 1).reduce((price, byte) => (price << 8n) | BigInt(byte), 0n);
};

const priceLabel = (ticks: bigint): string => {
  const whole = ticks / 10_000n;
  const fraction = (ticks % 10_000n).toString().padStart(4, '0').replace(/0+$/, '');
  return fraction ? `${whole.toString()}.${fraction}` : whole.toString();
};

const decodeLevels = (value: unknown, side: 'bid' | 'ask'): readonly WalletMarketLevel[] => {
  const pages = requireRuntimeMap(value, `WALLET_MARKET_${side.toUpperCase()}_PAGES`);
  const levels = new Map<bigint, { quantityLots: bigint; orderCount: number }>();
  for (const [key, rawPage] of pages) {
    const priceTicks = priceFromPortableKey(key);
    const page = requireRuntimeRecord(rawPage, 'WALLET_MARKET_BOOK_PAGE');
    const slots = page['slots'];
    if (!Array.isArray(slots) || slots.length !== 16) throw new Error('WALLET_MARKET_BOOK_SLOTS_INVALID');
    const live = slots.flatMap((raw): Array<{ qtyLots: bigint }> => {
      if (raw === null) return [];
      const entry = requireRuntimeRecord(raw, 'WALLET_MARKET_BOOK_ENTRY');
      requireRuntimeString(entry['orderId'], 'WALLET_MARKET_BOOK_ORDER_ID');
      normalizeRequiredRuntimeEntityId(entry['ownerId'], 'WALLET_MARKET_BOOK_OWNER_ID');
      requireRuntimeInteger(entry['seq'], 'WALLET_MARKET_BOOK_SEQUENCE');
      const qtyLots = requireRuntimeBigInt(entry['qtyLots'], 'WALLET_MARKET_BOOK_QUANTITY');
      if (qtyLots <= 0n) throw new Error('WALLET_MARKET_BOOK_QUANTITY_INVALID');
      return [{ qtyLots }];
    });
    const total = live.reduce((sum, entry) => sum + entry.qtyLots, 0n);
    if (requireRuntimeInteger(page['liveCount'], 'WALLET_MARKET_BOOK_LIVE_COUNT') !== live.length ||
        requireRuntimeBigInt(page['totalQtyLots'], 'WALLET_MARKET_BOOK_TOTAL') !== total) {
      throw new Error('WALLET_MARKET_BOOK_AGGREGATE_MISMATCH');
    }
    const current = levels.get(priceTicks) ?? { quantityLots: 0n, orderCount: 0 };
    levels.set(priceTicks, {
      quantityLots: current.quantityLots + total,
      orderCount: current.orderCount + live.length,
    });
  }
  return [...levels.entries()]
    .map(([ticks, level]) => ({ priceTicks: ticks, priceLabel: priceLabel(ticks), ...level }))
    .sort((left, right) => left.priceTicks === right.priceTicks
      ? 0
      : side === 'bid'
        ? left.priceTicks > right.priceTicks ? -1 : 1
        : left.priceTicks < right.priceTicks ? -1 : 1);
};

const decodePairs = (hubFrame: unknown, math: WalletPaymentMath): readonly WalletMarketPair[] => {
  const root = requireRuntimeRecord(hubFrame, 'WALLET_MARKET_HUB_FRAME');
  const active = requireRuntimeRecord(root['activeEntity'], 'WALLET_MARKET_HUB_ACTIVE');
  const books = requireRuntimeRecord(active['books'], 'WALLET_MARKET_BOOKS');
  if (!Array.isArray(books['items'])) throw new Error('WALLET_MARKET_BOOK_ITEMS_INVALID');
  return books['items'].map((raw): WalletMarketPair => {
    const item = requireRuntimeRecord(raw, 'WALLET_MARKET_BOOK_ITEM');
    const pairId = requireRuntimeString(item['pairId'], 'WALLET_MARKET_PAIR_ID');
    const [baseTokenId, quoteTokenId] = pairTokenIds(pairId);
    const book = requireRuntimeRecord(item['book'], 'WALLET_MARKET_BOOK');
    const lastTrade = requireRuntimeBigInt(book['lastTradePriceTicks'], 'WALLET_MARKET_LAST_TRADE');
    return {
      pairId,
      baseTokenId,
      quoteTokenId,
      label: `${math.getTokenInfo(baseTokenId).symbol} / ${math.getTokenInfo(quoteTokenId).symbol}`,
      bids: decodeLevels(book['bidPages'], 'bid'),
      asks: decodeLevels(book['askPages'], 'ask'),
      tradeCount: requireRuntimeInteger(book['tradeCount'], 'WALLET_MARKET_TRADE_COUNT'),
      lastTradePriceLabel: lastTrade > 0n ? priceLabel(lastTrade) : '—',
    };
  }).sort((left, right) => left.pairId.localeCompare(right.pairId));
};

const tifLabel = (value: unknown): 'GTC' | 'IOC' | 'FOK' => {
  const tif = value === undefined ? 0 : requireRuntimeInteger(value, 'WALLET_MARKET_ORDER_TIF');
  if (tif === 0) return 'GTC';
  if (tif === 1) return 'IOC';
  if (tif === 2) return 'FOK';
  throw new Error('WALLET_MARKET_ORDER_TIF_INVALID');
};

const decodeOpenOrders = (
  frame: unknown,
  activeEntityId: string,
  hubEntityId: string,
  math: WalletPaymentMath,
): readonly WalletMarketOpenOrder[] => {
  const root = requireRuntimeRecord(frame, 'WALLET_MARKET_FRAME');
  const active = requireRuntimeRecord(root['activeEntity'], 'WALLET_MARKET_ACTIVE');
  const accounts = requireRuntimeRecord(active['accounts'], 'WALLET_MARKET_ACCOUNTS');
  if (!Array.isArray(accounts['items'])) throw new Error('WALLET_MARKET_ACCOUNT_ITEMS_INVALID');
  const account = accounts['items'].find((raw) => {
    const state = requireRuntimeRecord(requireRuntimeRecord(raw, 'WALLET_MARKET_ACCOUNT')['state'], 'WALLET_MARKET_ACCOUNT_STATE');
    const left = normalizeRequiredRuntimeEntityId(state['leftEntity'], 'WALLET_MARKET_ACCOUNT_LEFT');
    const right = normalizeRequiredRuntimeEntityId(state['rightEntity'], 'WALLET_MARKET_ACCOUNT_RIGHT');
    return (left === activeEntityId && right === hubEntityId) || (right === activeEntityId && left === hubEntityId);
  });
  if (!account) throw new Error('WALLET_MARKET_HUB_ACCOUNT_REQUIRED');
  const state = requireRuntimeRecord(requireRuntimeRecord(account, 'WALLET_MARKET_ACCOUNT')['state'], 'WALLET_MARKET_ACCOUNT_STATE');
  const left = normalizeRequiredRuntimeEntityId(state['leftEntity'], 'WALLET_MARKET_ACCOUNT_LEFT');
  const right = normalizeRequiredRuntimeEntityId(state['rightEntity'], 'WALLET_MARKET_ACCOUNT_RIGHT');
  const offers = optionalRuntimeMap(state['swapOffers'], 'WALLET_MARKET_SWAP_OFFERS');
  return [...offers.values()].flatMap((raw): WalletMarketOpenOrder[] => {
    const offer = requireRuntimeRecord(raw, 'WALLET_MARKET_OPEN_ORDER');
    const makerIsLeft = offer['makerIsLeft'];
    if (typeof makerIsLeft !== 'boolean') throw new Error('WALLET_MARKET_ORDER_MAKER_INVALID');
    if ((makerIsLeft ? left : right) !== activeEntityId) return [];
    const giveTokenId = requireRuntimeInteger(offer['giveTokenId'], 'WALLET_MARKET_ORDER_GIVE_TOKEN', 1);
    const wantTokenId = requireRuntimeInteger(offer['wantTokenId'], 'WALLET_MARKET_ORDER_WANT_TOKEN', 1);
    const give = requireRuntimeBigInt(offer['giveAmount'], 'WALLET_MARKET_ORDER_GIVE');
    const want = requireRuntimeBigInt(offer['wantAmount'], 'WALLET_MARKET_ORDER_WANT');
    const ticks = requireRuntimeBigInt(offer['priceTicks'], 'WALLET_MARKET_ORDER_PRICE');
    return [{
      offerId: requireRuntimeString(offer['offerId'], 'WALLET_MARKET_ORDER_ID'),
      hubEntityId,
      sideLabel: `Sell ${math.getTokenInfo(giveTokenId).symbol}`,
      giveLabel: math.formatTokenAmount(giveTokenId, give),
      wantLabel: math.formatTokenAmount(wantTokenId, want),
      priceLabel: priceLabel(ticks),
      timeInForceLabel: tifLabel(offer['timeInForce']),
      createdHeight: requireRuntimeInteger(offer['createdHeight'], 'WALLET_MARKET_ORDER_HEIGHT'),
    }];
  }).sort((left, right) => right.createdHeight - left.createdHeight || left.offerId.localeCompare(right.offerId));
};

const crossRouteStatuses = [
  'intent', 'target_prepared', 'resting', 'partially_filled', 'clear_requested',
  'clearing', 'settled', 'cancelled', 'expired',
] as const;

const decodeCrossRoutes = (
  frame: unknown,
  math: WalletPaymentMath,
): readonly WalletCrossMarketRoute[] => {
  const routes = optionalRuntimeMap(readCore(frame, 'WALLET_MARKET')['crossJurisdictionSwaps'], 'WALLET_MARKET_CROSS_ROUTES');
  return [...routes.values()].map((raw): WalletCrossMarketRoute => {
    const route = requireRuntimeRecord(raw, 'WALLET_MARKET_CROSS_ROUTE');
    const source = requireRuntimeRecord(route['source'], 'WALLET_MARKET_CROSS_SOURCE');
    const target = requireRuntimeRecord(route['target'], 'WALLET_MARKET_CROSS_TARGET');
    const sourceToken = requireRuntimeInteger(source['tokenId'], 'WALLET_MARKET_CROSS_SOURCE_TOKEN', 1);
    const targetToken = requireRuntimeInteger(target['tokenId'], 'WALLET_MARKET_CROSS_TARGET_TOKEN', 1);
    return {
      orderId: requireRuntimeString(route['orderId'], 'WALLET_MARKET_CROSS_ID'),
      status: requireRuntimeEnum(route['status'], crossRouteStatuses, 'WALLET_MARKET_CROSS_STATUS'),
      sourceLabel: `${math.formatTokenAmount(sourceToken, requireRuntimeBigInt(source['amount'], 'WALLET_MARKET_CROSS_SOURCE_AMOUNT'))} ${math.getTokenInfo(sourceToken).symbol}`,
      targetLabel: `${math.formatTokenAmount(targetToken, requireRuntimeBigInt(target['amount'], 'WALLET_MARKET_CROSS_TARGET_AMOUNT'))} ${math.getTokenInfo(targetToken).symbol}`,
      updatedAt: requireRuntimeInteger(route['updatedAt'], 'WALLET_MARKET_CROSS_UPDATED'),
      expiresAt: requireRuntimeInteger(route['expiresAt'], 'WALLET_MARKET_CROSS_EXPIRES'),
    };
  }).sort((left, right) => right.updatedAt - left.updatedAt || left.orderId.localeCompare(right.orderId));
};

export const decodeWalletMarketProjection = (
  payload: WalletMarketPayload,
  math: WalletPaymentMath,
): WalletMarketProjection => {
  const context = decodeWalletMarketContext(payload.activeFrame, math);
  const selectedHub = context.hubs.find(({ entityId }) => entityId === payload.selectedHubId);
  if (!selectedHub) throw new Error('WALLET_MARKET_HUB_UNKNOWN');
  const feeBps = selectedHubFee(payload.hubFrame, selectedHub.entityId);
  const hubs = context.hubs.map((hub) => hub.entityId === selectedHub.entityId ? { ...hub, feeBps } : hub);
  const pairs = decodePairs(payload.hubFrame, math);
  const selectedPairId = pairs.some(({ pairId }) => pairId === payload.selectedPairId)
    ? payload.selectedPairId
    : pairs[0]?.pairId ?? '';
  const activity = decodeWalletMarketActivity(payload.activity, math);
  return {
    ...context.payment,
    logicalTimestamp: context.logicalTimestamp,
    hubs,
    selectedHubId: selectedHub.entityId,
    pairs,
    selectedPairId,
    openOrders: decodeOpenOrders(
      payload.activeFrame,
      context.payment.activeEntityId,
      selectedHub.entityId,
      math,
    ),
    crossRoutes: decodeCrossRoutes(payload.activeFrame, math),
    activity: activity.events,
    activityKind: payload.activityKind,
    activityPage: payload.activityPage,
    activityNextBeforeHeight: activity.nextBeforeHeight,
  };
};
