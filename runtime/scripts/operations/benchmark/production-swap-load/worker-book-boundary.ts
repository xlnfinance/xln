/** Exact projection decoder for the compact Runtime-adapter orderbook page. */

import {
  requireBoundaryInteger,
  requireBoundaryRecord,
  requireExactBoundaryKeys,
} from '../../../../protocol/boundary-validation';
import { decodePageItems } from './worker-boundary';
import {
  baseAmountAtPriceCeil,
  computeSwapPriceTicksForDimensions,
  getStaticSwapTokenDimensions,
  getSwapLotScale,
  ORDERBOOK_PRICE_SCALE,
  quoteAmountAtPrice,
} from '../../../../orderbook';

export type LoadBookSnapshot = Readonly<{
  tradeCount: number;
  executableAskPriceTicks: readonly bigint[];
}>;

type LoadBookLevel = Readonly<{
  priceTicks: bigint;
  orderIds: readonly string[];
  totalQtyLots: bigint;
}>;

export const deriveMinimumLotAlignedBaseAmount = (
  baseTokenId: number,
  quoteTokenId: number,
  minimumQuoteAmount: bigint,
  priceTicks: bigint,
): bigint => {
  const lot = getSwapLotScale(baseTokenId);
  const raw = baseAmountAtPriceCeil(baseTokenId, quoteTokenId, minimumQuoteAmount, priceTicks);
  const aligned = ((raw + lot - 1n) / lot) * lot;
  if (aligned <= 0n || quoteAmountAtPrice(baseTokenId, quoteTokenId, aligned, priceTicks) < minimumQuoteAmount) {
    throw new Error('PRODUCTION_SWAP_LOAD_MINIMUM_BASE_AMOUNT_INVALID');
  }
  return aligned;
};

export const deriveExecutableBidForAsk = (
  baseTokenId: number,
  quoteTokenId: number,
  minimumQuoteAmount: bigint,
  askPriceTicks: bigint,
): Readonly<{ baseAmount: bigint; quoteAmount: bigint }> => {
  const minimumBaseAmount = deriveMinimumLotAlignedBaseAmount(
    baseTokenId,
    quoteTokenId,
    minimumQuoteAmount,
    askPriceTicks,
  );
  const dimensions = getStaticSwapTokenDimensions(quoteTokenId, baseTokenId);
  const lot = getSwapLotScale(baseTokenId);
  const scale = (decimals: number): bigint => 10n ** BigInt(decimals);
  const gcd = (left: bigint, right: bigint): bigint => {
    let a = left;
    let b = right;
    while (b !== 0n) [a, b] = [b, a % b];
    return a;
  };
  // A maker ask authorizes a pro-rata minimum quote receive rounded upward.
  // Use the smallest integral quote lot so the matcher cannot underpay that
  // signed minimum by one raw quote unit during a partial fill.
  const quoteNumeratorPerLot = lot * askPriceTicks * scale(dimensions.giveTokenDecimals);
  const quoteDenominator = ORDERBOOK_PRICE_SCALE * scale(dimensions.wantTokenDecimals);
  const exactQuoteLotMultiple = quoteDenominator / gcd(quoteNumeratorPerLot, quoteDenominator);
  const minimumLots = (minimumBaseAmount + lot - 1n) / lot;
  const executableLots = ((minimumLots + exactQuoteLotMultiple - 1n) / exactQuoteLotMultiple) * exactQuoteLotMultiple;
  const baseAmount = executableLots * lot;
  const quoteAmount = quoteAmountAtPrice(baseTokenId, quoteTokenId, baseAmount, askPriceTicks);
  const executablePrice = computeSwapPriceTicksForDimensions(
    quoteTokenId,
    baseTokenId,
    quoteAmount,
    baseAmount,
    dimensions,
  );
  if (
    quoteAmount < minimumQuoteAmount ||
    executablePrice < askPriceTicks ||
    (baseAmount * askPriceTicks * scale(dimensions.giveTokenDecimals)) % quoteDenominator !== 0n
  ) {
    throw new Error('PRODUCTION_SWAP_LOAD_EXECUTABLE_BID_INVALID');
  }
  return { baseAmount, quoteAmount };
};

const requireBigInt = (value: unknown, code: string): bigint => {
  if (typeof value !== 'bigint') throw new Error(code);
  return value;
};

const requireBigIntArray = (value: unknown, code: string): bigint[] => {
  if (!Array.isArray(value)) throw new Error(code);
  return value.map((entry, index) => requireBigInt(entry, `${code}:${index}`));
};

const requireStringArray = (value: unknown, code: string): string[] => {
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string' || !entry)) throw new Error(code);
  return value.slice();
};

const decodeLevelMap = (value: unknown, code: string): Map<string, LoadBookLevel> => {
  if (!(value instanceof Map)) throw new Error(code);
  const decoded = new Map<string, LoadBookLevel>();
  for (const [key, raw] of value) {
    if (typeof key !== 'string') throw new Error(code);
    const level = requireBoundaryRecord(raw, code);
    requireExactBoundaryKeys(level, ['priceTicks', 'orderIds', 'totalQtyLots'], ['commitmentHash'], `${code}_FIELDS`);
    const priceTicks = requireBigInt(level['priceTicks'], code);
    const orderIds = requireStringArray(level['orderIds'], code);
    const totalQtyLots = requireBigInt(level['totalQtyLots'], code);
    if (level['commitmentHash'] !== undefined && typeof level['commitmentHash'] !== 'string') throw new Error(code);
    decoded.set(key, { priceTicks, orderIds, totalQtyLots });
  }
  return decoded;
};

type LoadBookBucket = Readonly<{
  bucketId: bigint;
  pricesAsc: readonly bigint[];
  levels: ReadonlyMap<string, LoadBookLevel>;
}>;

const decodeBucketMap = (value: unknown, code: string): Map<string, LoadBookBucket> => {
  if (!(value instanceof Map)) throw new Error(code);
  const decoded = new Map<string, LoadBookBucket>();
  for (const [key, raw] of value) {
    if (typeof key !== 'string') throw new Error(code);
    const bucket = requireBoundaryRecord(raw, code);
    requireExactBoundaryKeys(bucket, ['bucketId', 'pricesAsc', 'levels'], ['commitmentHash'], `${code}_FIELDS`);
    const bucketId = requireBigInt(bucket['bucketId'], code);
    const pricesAsc = requireBigIntArray(bucket['pricesAsc'], code);
    const levels = decodeLevelMap(bucket['levels'], code);
    if (bucket['commitmentHash'] !== undefined && typeof bucket['commitmentHash'] !== 'string') throw new Error(code);
    decoded.set(key, { bucketId, pricesAsc, levels });
  }
  return decoded;
};

type LoadBookOrder = Readonly<{ side: 0 | 1; priceTicks: bigint }>;

const decodeOrderMap = (value: unknown): Map<string, LoadBookOrder> => {
  if (!(value instanceof Map)) throw new Error('PRODUCTION_SWAP_LOAD_BOOK_ORDERS_INVALID');
  const decoded = new Map<string, LoadBookOrder>();
  for (const [key, raw] of value) {
    if (typeof key !== 'string') throw new Error('PRODUCTION_SWAP_LOAD_BOOK_ORDER_KEY_INVALID');
    const order = requireBoundaryRecord(raw, 'PRODUCTION_SWAP_LOAD_BOOK_ORDER_INVALID');
    requireExactBoundaryKeys(order, [
      'orderId', 'ownerId', 'side', 'priceTicks', 'qtyLots', 'seq', 'bucketId',
    ], ['commitmentHash'], 'PRODUCTION_SWAP_LOAD_BOOK_ORDER_FIELDS_INVALID');
    if (typeof order['orderId'] !== 'string' || typeof order['ownerId'] !== 'string') throw new Error('PRODUCTION_SWAP_LOAD_BOOK_ORDER_ID_INVALID');
    const side = order['side'];
    if (side !== 0 && side !== 1) throw new Error('PRODUCTION_SWAP_LOAD_BOOK_ORDER_SIDE_INVALID');
    const priceTicks = requireBigInt(order['priceTicks'], 'PRODUCTION_SWAP_LOAD_BOOK_ORDER_PRICE_INVALID');
    requireBigInt(order['qtyLots'], 'PRODUCTION_SWAP_LOAD_BOOK_ORDER_QTY_INVALID');
    requireBoundaryInteger(order['seq'], 'PRODUCTION_SWAP_LOAD_BOOK_ORDER_SEQ_INVALID');
    requireBigInt(order['bucketId'], 'PRODUCTION_SWAP_LOAD_BOOK_ORDER_BUCKET_INVALID');
    decoded.set(key, { side, priceTicks });
  }
  return decoded;
};

const decodeExecutableAskPrices = (
  bucketIds: readonly bigint[],
  buckets: ReadonlyMap<string, LoadBookBucket>,
  orders: ReadonlyMap<string, LoadBookOrder>,
): bigint[] => {
  const prices: bigint[] = [];
  for (const bucketId of bucketIds) {
    const bucket = buckets.get(bucketId.toString());
    if (!bucket || bucket.bucketId !== bucketId) throw new Error('PRODUCTION_SWAP_LOAD_ASK_BUCKET_MISSING');
    for (const price of bucket.pricesAsc) {
      const level = bucket.levels.get(price.toString());
      if (!level || level.priceTicks !== price || price <= 0n) throw new Error('PRODUCTION_SWAP_LOAD_ASK_LEVEL_INVALID');
      for (const orderId of level.orderIds) {
        const order = orders.get(orderId);
        if (!order || order.side !== 1 || order.priceTicks !== price) throw new Error('PRODUCTION_SWAP_LOAD_ASK_ORDER_INVALID');
        prices.push(price);
      }
    }
  }
  if (prices.length === 0) throw new Error('PRODUCTION_SWAP_LOAD_MM_ASK_MISSING');
  if (prices.some((price, index) => index > 0 && price < prices[index - 1]!)) {
    throw new Error('PRODUCTION_SWAP_LOAD_ASK_LADDER_UNSORTED');
  }
  return prices;
};

export const decodeLoadBookPage = (value: unknown, pairId: string): LoadBookSnapshot => {
  const items = decodePageItems(value, 'PRODUCTION_SWAP_LOAD_BOOK_PAGE_INVALID');
  const matches = items.filter(raw => requireBoundaryRecord(raw, 'PRODUCTION_SWAP_LOAD_BOOK_ITEM_INVALID')['pairId'] === pairId);
  if (matches.length !== 1) throw new Error(`PRODUCTION_SWAP_LOAD_BOOK_NOT_UNIQUE:${pairId}`);
  const item = requireBoundaryRecord(matches[0], 'PRODUCTION_SWAP_LOAD_BOOK_ITEM_INVALID');
  requireExactBoundaryKeys(item, ['pairId', 'book'], [], 'PRODUCTION_SWAP_LOAD_BOOK_ITEM_FIELDS_INVALID');
  const book = requireBoundaryRecord(item['book'], 'PRODUCTION_SWAP_LOAD_BOOK_INVALID');
  requireExactBoundaryKeys(book, [
    'params', 'orders', 'bidBuckets', 'askBuckets', 'bidBucketIdsDesc',
    'askBucketIdsAsc', 'nextSeq', 'tradeCount', 'tradeQtySum',
    'lastTradePriceTicks', 'lastAcceptedUsdAskPriceTicks', 'eventHash',
  ], ['commitmentHash'], 'PRODUCTION_SWAP_LOAD_BOOK_FIELDS_INVALID');
  const params = requireBoundaryRecord(book['params'], 'PRODUCTION_SWAP_LOAD_BOOK_PARAMS_INVALID');
  requireExactBoundaryKeys(params, ['bucketWidthTicks', 'maxOrders', 'stpPolicy'], [], 'PRODUCTION_SWAP_LOAD_BOOK_PARAMS_FIELDS_INVALID');
  requireBigInt(params['bucketWidthTicks'], 'PRODUCTION_SWAP_LOAD_BOOK_BUCKET_WIDTH_INVALID');
  requireBoundaryInteger(params['maxOrders'], 'PRODUCTION_SWAP_LOAD_BOOK_MAX_ORDERS_INVALID', 1);
  if (params['stpPolicy'] !== 0 && params['stpPolicy'] !== 1) throw new Error('PRODUCTION_SWAP_LOAD_BOOK_STP_INVALID');
  const orders = decodeOrderMap(book['orders']);
  decodeBucketMap(book['bidBuckets'], 'PRODUCTION_SWAP_LOAD_BID_BUCKETS_INVALID');
  const asks = decodeBucketMap(book['askBuckets'], 'PRODUCTION_SWAP_LOAD_ASK_BUCKETS_INVALID');
  requireBigIntArray(book['bidBucketIdsDesc'], 'PRODUCTION_SWAP_LOAD_BID_IDS_INVALID');
  const askIds = requireBigIntArray(book['askBucketIdsAsc'], 'PRODUCTION_SWAP_LOAD_ASK_IDS_INVALID');
  requireBoundaryInteger(book['nextSeq'], 'PRODUCTION_SWAP_LOAD_BOOK_NEXT_SEQ_INVALID');
  const tradeCount = requireBoundaryInteger(book['tradeCount'], 'PRODUCTION_SWAP_LOAD_BOOK_TRADE_COUNT_INVALID');
  for (const field of ['tradeQtySum', 'lastTradePriceTicks', 'lastAcceptedUsdAskPriceTicks', 'eventHash'] as const) {
    requireBigInt(book[field], `PRODUCTION_SWAP_LOAD_BOOK_${field.toUpperCase()}_INVALID`);
  }
  return {
    tradeCount,
    executableAskPriceTicks: decodeExecutableAskPrices(askIds, asks, orders),
  };
};
