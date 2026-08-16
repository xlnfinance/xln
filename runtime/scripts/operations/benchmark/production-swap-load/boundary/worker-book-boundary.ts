/** Exact projection decoder for the compact Runtime-adapter orderbook page. */

import {
  requireBoundaryInteger,
  requireBoundaryRecord,
  requireExactBoundaryKeys,
} from '../../../../../protocol/boundary-validation';
import { decodePageItems } from './worker-boundary';
import {
  baseAmountAtPriceCeil,
  computeSwapPriceTicksForDimensions,
  getSwapExactQuoteLotMultipleAtPriceForDimensions,
  getStaticSwapTokenDimensions,
  getSwapLotScale,
  quoteAmountAtPrice,
} from '../../../../../orderbook';
import {
  decodeBookPricePageTree,
  type BookPricePageTree,
} from '../../../../../orderbook/pages/page';

export type LoadBookSnapshot = Readonly<{
  tradeCount: number;
  bestBidPriceTicks: bigint | null;
  bestAskPriceTicks: bigint;
  executableAskPriceTicks: readonly bigint[];
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
  // A maker ask authorizes a pro-rata minimum quote receive rounded upward.
  // Use the smallest integral quote lot so the matcher cannot underpay that
  // signed minimum by one raw quote unit during a partial fill.
  const exactQuoteLotMultiple = getSwapExactQuoteLotMultipleAtPriceForDimensions(
    dimensions.wantTokenDecimals,
    dimensions.giveTokenDecimals,
    askPriceTicks,
  );
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
    executableLots % exactQuoteLotMultiple !== 0n
  ) {
    throw new Error('PRODUCTION_SWAP_LOAD_EXECUTABLE_BID_INVALID');
  }
  return { baseAmount, quoteAmount };
};

const requireBigInt = (value: unknown, code: string): bigint => {
  if (typeof value !== 'bigint') throw new Error(code);
  return value;
};

const decodeExecutableAskPrices = (pages: BookPricePageTree): bigint[] => {
  const prices: bigint[] = [];
  for (const [key, page] of pages.entries()) {
    for (let slot = page.headSlot; slot < page.nextSlot; slot += 1) {
      if (page.slots[slot]) prices.push(key.priceTicks);
    }
  }
  if (prices.length === 0) throw new Error('PRODUCTION_SWAP_LOAD_MM_ASK_MISSING');
  if (prices.some((price, index) => index > 0 && price < prices[index - 1]!)) {
    throw new Error('PRODUCTION_SWAP_LOAD_ASK_LADDER_UNSORTED');
  }
  return prices;
};

const decodeBestBidPrice = (
  pages: BookPricePageTree,
): bigint | null => pages.lastEntry()?.[0].priceTicks ?? null;

export const decodeLoadBookPage = (value: unknown, pairId: string): LoadBookSnapshot => {
  const items = decodePageItems(value, 'PRODUCTION_SWAP_LOAD_BOOK_PAGE_INVALID');
  const matches = items.filter(raw => requireBoundaryRecord(raw, 'PRODUCTION_SWAP_LOAD_BOOK_ITEM_INVALID')['pairId'] === pairId);
  if (matches.length !== 1) throw new Error(`PRODUCTION_SWAP_LOAD_BOOK_NOT_UNIQUE:${pairId}`);
  const item = requireBoundaryRecord(matches[0], 'PRODUCTION_SWAP_LOAD_BOOK_ITEM_INVALID');
  requireExactBoundaryKeys(item, ['pairId', 'book'], [], 'PRODUCTION_SWAP_LOAD_BOOK_ITEM_FIELDS_INVALID');
  const book = requireBoundaryRecord(item['book'], 'PRODUCTION_SWAP_LOAD_BOOK_INVALID');
  requireExactBoundaryKeys(book, [
    'params', 'bidPages', 'askPages', 'nextSeq', 'tradeCount', 'tradeQtySum',
    'lastTradePriceTicks', 'lastAcceptedUsdAskPriceTicks', 'eventHash',
  ], ['commitmentHash'], 'PRODUCTION_SWAP_LOAD_BOOK_FIELDS_INVALID');
  const params = requireBoundaryRecord(book['params'], 'PRODUCTION_SWAP_LOAD_BOOK_PARAMS_INVALID');
  requireExactBoundaryKeys(params, ['bucketWidthTicks', 'maxOrders', 'stpPolicy'], [], 'PRODUCTION_SWAP_LOAD_BOOK_PARAMS_FIELDS_INVALID');
  requireBigInt(params['bucketWidthTicks'], 'PRODUCTION_SWAP_LOAD_BOOK_BUCKET_WIDTH_INVALID');
  requireBoundaryInteger(params['maxOrders'], 'PRODUCTION_SWAP_LOAD_BOOK_MAX_ORDERS_INVALID', 1);
  if (params['stpPolicy'] !== 0 && params['stpPolicy'] !== 1) throw new Error('PRODUCTION_SWAP_LOAD_BOOK_STP_INVALID');
  const bids = decodeBookPricePageTree(book['bidPages'], 'PRODUCTION_SWAP_LOAD_BID_PAGES');
  const asks = decodeBookPricePageTree(book['askPages'], 'PRODUCTION_SWAP_LOAD_ASK_PAGES');
  requireBoundaryInteger(book['nextSeq'], 'PRODUCTION_SWAP_LOAD_BOOK_NEXT_SEQ_INVALID');
  const tradeCount = requireBoundaryInteger(book['tradeCount'], 'PRODUCTION_SWAP_LOAD_BOOK_TRADE_COUNT_INVALID');
  for (const field of ['tradeQtySum', 'lastTradePriceTicks', 'lastAcceptedUsdAskPriceTicks', 'eventHash'] as const) {
    requireBigInt(book[field], `PRODUCTION_SWAP_LOAD_BOOK_${field.toUpperCase()}_INVALID`);
  }
  const executableAskPriceTicks = decodeExecutableAskPrices(asks);
  return {
    tradeCount,
    bestBidPriceTicks: decodeBestBidPrice(bids),
    bestAskPriceTicks: executableAskPriceTicks[0]!,
    executableAskPriceTicks,
  };
};
