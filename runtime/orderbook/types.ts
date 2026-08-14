import { haltRuntimeFailure } from "../protocol/errors/failure-taxonomy";

/**
 * Orderbook Types for XLN
 *
 * Re-exports core types and adds higher-level concepts (spread, referrals).
 */

// Re-export core types
export type {
  Side,
  BookEvent,
  BookOrderState,
  BookState,
  PriceBucketState,
} from './core';
export {
  createBook,
  applyCommand,
  getBestBid,
  getBestAsk,
  getBookOrder,
  getBookOrders,
  getBookSideLevels,
  computeBookHash,
  MAX_ORDERBOOK_QTY_LOTS,
} from './core';

import { getSwapPairOrientation, getSwapPairPolicyByBaseQuote, getTokenInfo } from '../account/utils';

// Price tick precision used for ratio encoding in orderbook flows.
// 10000 = 4 decimals (e.g. 1.2345)
export const ORDERBOOK_PRICE_SCALE = 10_000n;

const requireTokenDecimals = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 0 || value > 255) {
    throw new Error(`SWAP_TOKEN_DECIMALS_INVALID:${String(value)}`);
  }
  return value;
};

const tokenScaleForDecimals = (decimals: number): bigint =>
  10n ** BigInt(requireTokenDecimals(decimals));

const tokenScale = (tokenId: number): bigint =>
  tokenScaleForDecimals(getTokenInfo(tokenId).decimals);

export type SwapTokenDimensions = Readonly<{
  giveTokenDecimals: number;
  wantTokenDecimals: number;
}>;

export type SwapPairDimensions = Readonly<{
  baseTokenDecimals: number;
  quoteTokenDecimals: number;
}>;

export const getStaticSwapTokenDimensions = (
  giveTokenId: number,
  wantTokenId: number,
): SwapTokenDimensions => ({
  giveTokenDecimals: getTokenInfo(giveTokenId).decimals,
  wantTokenDecimals: getTokenInfo(wantTokenId).decimals,
});

export const getSwapPairDimensions = (
  side: 0 | 1,
  dimensions: SwapTokenDimensions,
): SwapPairDimensions => side === 1
  ? {
      baseTokenDecimals: requireTokenDecimals(dimensions.giveTokenDecimals),
      quoteTokenDecimals: requireTokenDecimals(dimensions.wantTokenDecimals),
    }
  : {
      baseTokenDecimals: requireTokenDecimals(dimensions.wantTokenDecimals),
      quoteTokenDecimals: requireTokenDecimals(dimensions.giveTokenDecimals),
    };

export const equalSwapPairDimensions = (
  left: SwapPairDimensions,
  right: SwapPairDimensions,
): boolean => left.baseTokenDecimals === right.baseTokenDecimals &&
  left.quoteTokenDecimals === right.quoteTokenDecimals;

/** Preserve six decimal places of base-asset precision in book quantities. */
export const getSwapLotScale = (baseTokenId: number): bigint => {
  return getSwapLotScaleForDecimals(getTokenInfo(baseTokenId).decimals);
};

export const getSwapLotScaleForDecimals = (decimals: number): bigint =>
  10n ** BigInt(Math.max(0, requireTokenDecimals(decimals) - 6));

export const quoteAmountAtPriceForDecimals = (
  baseTokenDecimals: number,
  quoteTokenDecimals: number,
  baseAmount: bigint,
  priceTicks: bigint,
): bigint => {
  if (baseAmount <= 0n || priceTicks <= 0n) return 0n;
  return (baseAmount * priceTicks * tokenScaleForDecimals(quoteTokenDecimals)) /
    (ORDERBOOK_PRICE_SCALE * tokenScaleForDecimals(baseTokenDecimals));
};

/** Convert a human-unit price into exact raw quote units, rounding down. */
export const quoteAmountAtPrice = (
  baseTokenId: number,
  quoteTokenId: number,
  baseAmount: bigint,
  priceTicks: bigint,
): bigint => {
  return quoteAmountAtPriceForDecimals(
    getTokenInfo(baseTokenId).decimals,
    getTokenInfo(quoteTokenId).decimals,
    baseAmount,
    priceTicks,
  );
};

/** Inverse of quoteAmountAtPrice, rounding down before lot quantization. */
export const baseAmountAtPrice = (
  baseTokenId: number,
  quoteTokenId: number,
  quoteAmount: bigint,
  priceTicks: bigint,
): bigint => {
  return baseAmountAtPriceForDecimals(
    getTokenInfo(baseTokenId).decimals,
    getTokenInfo(quoteTokenId).decimals,
    quoteAmount,
    priceTicks,
  );
};

const baseAmountAtPriceForDecimals = (
  baseTokenDecimals: number,
  quoteTokenDecimals: number,
  quoteAmount: bigint,
  priceTicks: bigint,
): bigint => {
  if (quoteAmount <= 0n || priceTicks <= 0n) return 0n;
  return (quoteAmount * ORDERBOOK_PRICE_SCALE * tokenScaleForDecimals(baseTokenDecimals)) /
    (priceTicks * tokenScaleForDecimals(quoteTokenDecimals));
};

export const baseAmountAtPriceCeil = (
  baseTokenId: number,
  quoteTokenId: number,
  quoteAmount: bigint,
  priceTicks: bigint,
): bigint => {
  if (quoteAmount <= 0n || priceTicks <= 0n) return 0n;
  const numerator = quoteAmount * ORDERBOOK_PRICE_SCALE * tokenScale(baseTokenId);
  const denominator = priceTicks * tokenScale(quoteTokenId);
  return (numerator + denominator - 1n) / denominator;
};

export const baseAmountFromLots = (baseTokenId: number, qtyLots: bigint): bigint =>
  qtyLots <= 0n ? 0n : qtyLots * getSwapLotScale(baseTokenId);

export const baseAmountFromLotsForDecimals = (baseTokenDecimals: number, qtyLots: bigint): bigint =>
  qtyLots <= 0n ? 0n : qtyLots * getSwapLotScaleForDecimals(baseTokenDecimals);

export const quoteAmountFromWeightedLots = (
  baseTokenId: number,
  quoteTokenId: number,
  weightedPriceTicks: bigint,
): bigint => quoteAmountAtPrice(
  baseTokenId,
  quoteTokenId,
  getSwapLotScale(baseTokenId),
  weightedPriceTicks,
);

export const quoteAmountFromWeightedLotsForDecimals = (
  baseTokenDecimals: number,
  quoteTokenDecimals: number,
  weightedPriceTicks: bigint,
): bigint => quoteAmountAtPriceForDecimals(
  baseTokenDecimals,
  quoteTokenDecimals,
  getSwapLotScaleForDecimals(baseTokenDecimals),
  weightedPriceTicks,
);

/** Canonical pair normalization */
export function canonicalPair(tokenA: number, tokenB: number): { base: number; quote: number; pairId: string } {
  const { baseTokenId, quoteTokenId, pairId } = getSwapPairOrientation(tokenA, tokenB);
  return { base: baseTokenId, quote: quoteTokenId, pairId };
}

/** Derive side from token direction */
export function deriveSide(giveTokenId: number, wantTokenId: number): 0 | 1 {
  const { base, quote } = canonicalPair(giveTokenId, wantTokenId);
  // 1 = SELL base, 0 = BUY base
  if (giveTokenId === base && wantTokenId === quote) return 1;
  if (giveTokenId === quote && wantTokenId === base) return 0;
  // Sentinel for malformed directions (unreachable for valid swaps).
  return giveTokenId < wantTokenId ? 1 : 0;
}

/**
 * Deterministic swap price calculation in ORDERBOOK_PRICE_SCALE ticks.
 * This is the canonical function for frontend and runtime.
 *
 * Rules:
 * - side=SELL_BASE rounds UP to not sell cheaper than requested
 * - side=BUY_BASE rounds DOWN to not pay more than requested
 * - pair policy step is always enforced
 */
export function computeSwapPriceTicks(
  giveTokenId: number,
  wantTokenId: number,
  giveAmount: bigint,
  wantAmount: bigint,
): bigint {
  if (giveAmount <= 0n || wantAmount <= 0n) return 0n;

  const side = deriveSide(giveTokenId, wantTokenId);
  const rawBaseAmount = side === 1 ? giveAmount : wantAmount;
  const rawQuoteAmount = side === 1 ? wantAmount : giveAmount;
  if (rawBaseAmount <= 0n || rawQuoteAmount <= 0n) return 0n;

  const { base, quote } = canonicalPair(giveTokenId, wantTokenId);
  return computePriceTicksForBaseQuote(side, base, quote, rawBaseAmount, rawQuoteAmount);
}

export function computeSwapPriceTicksForDimensions(
  giveTokenId: number,
  wantTokenId: number,
  giveAmount: bigint,
  wantAmount: bigint,
  dimensions: SwapTokenDimensions,
): bigint {
  if (giveAmount <= 0n || wantAmount <= 0n) return 0n;
  const side = deriveSide(giveTokenId, wantTokenId);
  const rawBaseAmount = side === 1 ? giveAmount : wantAmount;
  const rawQuoteAmount = side === 1 ? wantAmount : giveAmount;
  const { base, quote } = canonicalPair(giveTokenId, wantTokenId);
  const decimals = getSwapPairDimensions(side, dimensions);
  return computePriceTicksForBaseQuoteDecimals(
    side,
    base,
    quote,
    rawBaseAmount,
    rawQuoteAmount,
    decimals.baseTokenDecimals,
    decimals.quoteTokenDecimals,
  );
}

export function computePriceTicksForBaseQuote(
  side: 0 | 1,
  baseTokenId: number,
  quoteTokenId: number,
  rawBaseAmount: bigint,
  rawQuoteAmount: bigint,
): bigint {
  return computePriceTicksForBaseQuoteDecimals(
    side,
    baseTokenId,
    quoteTokenId,
    rawBaseAmount,
    rawQuoteAmount,
    getTokenInfo(baseTokenId).decimals,
    getTokenInfo(quoteTokenId).decimals,
  );
}

export function computePriceTicksForBaseQuoteDecimals(
  side: 0 | 1,
  baseTokenId: number,
  quoteTokenId: number,
  rawBaseAmount: bigint,
  rawQuoteAmount: bigint,
  baseTokenDecimals: number,
  quoteTokenDecimals: number,
): bigint {
  if (rawBaseAmount <= 0n || rawQuoteAmount <= 0n) return 0n;

  const pairPolicy = getSwapPairPolicyByBaseQuote(baseTokenId, quoteTokenId);
  const stepTicks = BigInt(Math.max(1, pairPolicy.priceStepTicks));

  const numerator = rawQuoteAmount * tokenScaleForDecimals(baseTokenDecimals) * ORDERBOOK_PRICE_SCALE;
  const denominator = rawBaseAmount * tokenScaleForDecimals(quoteTokenDecimals);
  const remainder = numerator % denominator;
  let priceTicks = numerator / denominator;
  if (side === 1) {
    if (remainder > 0n) {
      priceTicks += 1n;
    }
    priceTicks = ((priceTicks + stepTicks - 1n) / stepTicks) * stepTicks;
  } else {
    priceTicks = (priceTicks / stepTicks) * stepTicks;
  }
  return priceTicks > 0n ? priceTicks : 0n;
}

/** Lot granularity for swap order quantization (shared with frontend) */
// Internal orderbook lot granularity. User amounts stay in bigint token units;
// the book compresses only the in-memory index, and qtyLots itself is bigint so
// large orders do not hit JS number/uint32 ceilings.
export const SWAP_LOT_SCALE = getSwapLotScale(2);

if (SWAP_LOT_SCALE % ORDERBOOK_PRICE_SCALE !== 0n) {
  throw haltRuntimeFailure("ORDERBOOK_SCALE_INVARIANT", `ORDERBOOK_SCALE_INVARIANT: SWAP_LOT_SCALE=${SWAP_LOT_SCALE} must be divisible by ORDERBOOK_PRICE_SCALE=${ORDERBOOK_PRICE_SCALE}`);
}

export interface PreparedSwapOrder {
  side: 0 | 1;
  baseTokenId: number;
  quoteTokenId: number;
  priceTicks: bigint;
  lotScale: bigint;
  rawBaseAmount: bigint;
  rawQuoteAmount: bigint;
  quantizedBaseAmount: bigint;
  quantizedQuoteAmount: bigint;
  effectiveGive: bigint;
  effectiveWant: bigint;
  unspentGiveAmount: bigint;
}

/**
 * Canonical swap-order preparation.
 * This is the single source of truth for UI/runtime agreement on:
 * - side inference
 * - base-lot quantization
 * - canonical price ticks
 * - mapped effective give/want amounts
 * - honest leftover reporting for max-spend UX
 */
const prepareSwapOrderWithDimensions = (
  giveTokenId: number,
  wantTokenId: number,
  giveAmount: bigint,
  wantAmount: bigint,
  dimensions: SwapTokenDimensions,
): PreparedSwapOrder | null => {
  if (giveAmount <= 0n || wantAmount <= 0n) return null;

  const side = deriveSide(giveTokenId, wantTokenId);
  const rawBaseAmount = side === 1 ? giveAmount : wantAmount;
  const rawQuoteAmount = side === 1 ? wantAmount : giveAmount;
  const { base, quote } = canonicalPair(giveTokenId, wantTokenId);
  const decimals = getSwapPairDimensions(side, dimensions);
  const lotScale = getSwapLotScaleForDecimals(decimals.baseTokenDecimals);
  if (rawBaseAmount < lotScale || rawQuoteAmount <= 0n) return null;

  const priceTicks = computeSwapPriceTicksForDimensions(
    giveTokenId,
    wantTokenId,
    giveAmount,
    wantAmount,
    dimensions,
  );
  if (priceTicks <= 0n) return null;

  const quantizedBaseAmount = (rawBaseAmount / lotScale) * lotScale;
  if (quantizedBaseAmount <= 0n) return null;

  const quantizedQuoteAmount = quoteAmountAtPriceForDecimals(
    decimals.baseTokenDecimals,
    decimals.quoteTokenDecimals,
    quantizedBaseAmount,
    priceTicks,
  );
  if (quantizedQuoteAmount <= 0n) return null;

  const effectiveGive = side === 1 ? quantizedBaseAmount : quantizedQuoteAmount;
  const effectiveWant = side === 1 ? quantizedQuoteAmount : quantizedBaseAmount;
  const unspentGiveAmount = giveAmount > effectiveGive ? giveAmount - effectiveGive : 0n;

  return {
    side,
    baseTokenId: base,
    quoteTokenId: quote,
    priceTicks,
    lotScale,
    rawBaseAmount,
    rawQuoteAmount,
    quantizedBaseAmount,
    quantizedQuoteAmount,
    effectiveGive,
    effectiveWant,
    unspentGiveAmount,
  };
};

export function prepareSwapOrderForDimensions(
  giveTokenId: number,
  wantTokenId: number,
  giveAmount: bigint,
  wantAmount: bigint,
  dimensions: SwapTokenDimensions,
): PreparedSwapOrder | null {
  return prepareSwapOrderWithDimensions(
    giveTokenId,
    wantTokenId,
    giveAmount,
    wantAmount,
    dimensions,
  );
}

export function prepareSwapOrder(
  giveTokenId: number,
  wantTokenId: number,
  giveAmount: bigint,
  wantAmount: bigint,
): PreparedSwapOrder | null {
  return prepareSwapOrderWithDimensions(giveTokenId, wantTokenId, giveAmount, wantAmount, {
    giveTokenDecimals: getTokenInfo(giveTokenId).decimals,
    wantTokenDecimals: getTokenInfo(wantTokenId).decimals,
  });
}

/**
 * Quantize a swap order to lot granularity — canonical single source of truth.
 * Both frontend and runtime must use this to avoid dust.
 *
 * Returns effectiveGive/effectiveWant after quantization, or null if order becomes zero.
 */
export function quantizeSwapOrder(
  giveTokenId: number,
  wantTokenId: number,
  giveAmount: bigint,
  wantAmount: bigint,
): { effectiveGive: bigint; effectiveWant: bigint; priceTicks: bigint } | null {
  const prepared = prepareSwapOrder(giveTokenId, wantTokenId, giveAmount, wantAmount);
  if (!prepared) return null;
  return {
    effectiveGive: prepared.effectiveGive,
    effectiveWant: prepared.effectiveWant,
    priceTicks: prepared.priceTicks,
  };
}

/**
 * Re-quantize the remaining leg of an existing order while preserving its priceTicks.
 * This keeps subsequent partial fills aligned to lot granularity.
 */
const requantizeRemainingSwapWithDimensions = (
  giveTokenId: number,
  wantTokenId: number,
  remainingGiveAmount: bigint,
  priceTicks: bigint,
  dimensions: SwapTokenDimensions,
): { effectiveGive: bigint; effectiveWant: bigint; releasedGiveDust: bigint } | null => {
  if (remainingGiveAmount <= 0n || priceTicks <= 0n) return null;

  const side = deriveSide(giveTokenId, wantTokenId);
  const decimals = getSwapPairDimensions(side, dimensions);
  const lotScale = getSwapLotScaleForDecimals(decimals.baseTokenDecimals);
  if (side === 1) {
    const quantizedBaseAmount = (remainingGiveAmount / lotScale) * lotScale;
    if (quantizedBaseAmount <= 0n) return null;
    const quantizedQuoteAmount = quoteAmountAtPriceForDecimals(
      decimals.baseTokenDecimals,
      decimals.quoteTokenDecimals,
      quantizedBaseAmount,
      priceTicks,
    );
    if (quantizedQuoteAmount <= 0n) return null;
    return {
      effectiveGive: quantizedBaseAmount,
      effectiveWant: quantizedQuoteAmount,
      releasedGiveDust: remainingGiveAmount - quantizedBaseAmount,
    };
  }

  const remainingQuoteAmount = remainingGiveAmount;
  const rawBaseAmount = baseAmountAtPriceForDecimals(
    decimals.baseTokenDecimals,
    decimals.quoteTokenDecimals,
    remainingQuoteAmount,
    priceTicks,
  );
  const quantizedBaseAmount = (rawBaseAmount / lotScale) * lotScale;
  if (quantizedBaseAmount <= 0n) return null;
  const quantizedQuoteAmount = quoteAmountAtPriceForDecimals(
    decimals.baseTokenDecimals,
    decimals.quoteTokenDecimals,
    quantizedBaseAmount,
    priceTicks,
  );
  if (quantizedQuoteAmount <= 0n) return null;
  return {
    effectiveGive: quantizedQuoteAmount,
    effectiveWant: quantizedBaseAmount,
    releasedGiveDust: remainingGiveAmount > quantizedQuoteAmount ? remainingGiveAmount - quantizedQuoteAmount : 0n,
  };
};

export function requantizeRemainingSwapAtPriceForDimensions(
  giveTokenId: number,
  wantTokenId: number,
  remainingGiveAmount: bigint,
  priceTicks: bigint,
  dimensions: SwapTokenDimensions,
): { effectiveGive: bigint; effectiveWant: bigint; releasedGiveDust: bigint } | null {
  return requantizeRemainingSwapWithDimensions(
    giveTokenId,
    wantTokenId,
    remainingGiveAmount,
    priceTicks,
    dimensions,
  );
}

export function requantizeRemainingSwapAtPrice(
  giveTokenId: number,
  wantTokenId: number,
  remainingGiveAmount: bigint,
  priceTicks: bigint,
): { effectiveGive: bigint; effectiveWant: bigint; releasedGiveDust: bigint } | null {
  return requantizeRemainingSwapWithDimensions(
    giveTokenId,
    wantTokenId,
    remainingGiveAmount,
    priceTicks,
    {
      giveTokenDecimals: getTokenInfo(giveTokenId).decimals,
      wantTokenDecimals: getTokenInfo(wantTokenId).decimals,
    },
  );
}

// ============================================================================
// Spread Distribution (Hub Profile)
// ============================================================================

/** Basis points constant (10000 = 100%) */
const BPS_BASE = 10000;

/**
 * Spread distribution rules - how trade spread is allocated
 * All values in basis points, must sum to 10000 (100%)
 */
export interface SpreadDistribution {
  makerBps: number;         // Price improvement to maker
  takerBps: number;         // Quote-side spread share to taker
  hubBps: number;           // Hub revenue
  makerReferrerBps: number; // Reward to maker's referrer
  takerReferrerBps: number; // Reward to taker's referrer
}

/** Validate spread distribution sums to 100% */
export function validateSpreadDistribution(dist: SpreadDistribution): boolean {
  const total = dist.makerBps + dist.takerBps + dist.hubBps +
                dist.makerReferrerBps + dist.takerReferrerBps;
  return total === BPS_BASE;
}

/** Default: 100% to taker so limit orders always get full market price improvement */
export const DEFAULT_SPREAD_DISTRIBUTION: SpreadDistribution = {
  makerBps: 0,
  takerBps: 10000,
  hubBps: 0,
  makerReferrerBps: 0,
  takerReferrerBps: 0,
};

/**
 * Hub profile - public configuration stored in gossip/on-chain
 * Users can compare hubs by their spread distribution
 */
export interface HubProfile {
  entityId: string;
  name: string;
  spreadDistribution: SpreadDistribution;
  referenceTokenId: number;  // Token for fee payments (e.g., USDC = 2)
  /** Only this signed Entity may update volatile/USD admission references. */
  usdQuoteAuthorityEntityId: string;
  minTradeSize: bigint;      // Minimum trade size in reference token
  supportedPairs: string[];  // e.g., ["1/2", "1/3"]
}

/**
 * Referrer tracking for an entity
 */
export interface EntityReferral {
  entityId: string;
  referrerId: string | null;  // Who onboarded this entity (null if organic)
  timestamp: number;
}

// ============================================================================
// Hub Orderbook Extension State
// ============================================================================

import type { BookState } from './core';

/**
 * Hub's orderbook extension state
 * Stored in EntityState.ext.orderbook
 */
export interface OrderbookExtState {
  /** Books by jurisdiction/pair: e.g., "eth/1/2" */
  books: Map<string, BookState>;

  /**
   * Hot cancel index:
   * namespacedOrderId ("accountId:offerId") -> pairIds currently containing it.
   *
   * The source of truth is still `books`. This map is derived state kept only to
   * avoid scanning every pair book on each cancel. If an older snapshot lacks it,
   * it can be rebuilt deterministically from `books`.
   */
  orderPairs: Map<string, string[]>;

  /** First accepted same-j offer commits one decimal layout per token pair. */
  pairDimensions: Map<string, SwapPairDimensions>;

  /** Referrer tracking */
  referrals: Map<string, EntityReferral>;

  /** Hub configuration */
  hubProfile: HubProfile;
}

/** Create initial orderbook extension state */
export function createOrderbookExtState(hubProfile: HubProfile): OrderbookExtState {
  return {
    books: new Map(),
    orderPairs: new Map(),
    pairDimensions: new Map(),
    referrals: new Map(),
    hubProfile,
  };
}

const addPairToOrderIndex = (index: Map<string, string[]>, orderId: string, pairId: string): void => {
  const existing = index.get(orderId);
  if (!existing) {
    index.set(orderId, [pairId]);
    return;
  }
  if (!existing.includes(pairId)) existing.push(pairId);
  existing.sort();
};

const removePairFromOrderIndex = (index: Map<string, string[]>, orderId: string, pairId: string): void => {
  const existing = index.get(orderId);
  if (!existing) return;
  const filtered = existing.filter((entry) => entry !== pairId);
  if (filtered.length === 0) index.delete(orderId);
  else index.set(orderId, filtered);
};

const normalizeOrderPairIndex = (index: Map<string, string[]>): Map<string, string[]> => {
  for (const [orderId, pairIds] of index.entries()) {
    index.set(orderId, Array.from(new Set(pairIds)).sort());
  }
  return index;
};

export function rebuildOrderbookPairIndex(ext: OrderbookExtState): Map<string, string[]> {
  const next = new Map<string, string[]>();
  for (const [pairId, book] of ext.books.entries()) {
    for (const orderId of book.orders.keys()) {
      addPairToOrderIndex(next, orderId, pairId);
    }
  }
  ext.orderPairs = next;
  return next;
}

function ensureOrderbookPairIndex(ext: OrderbookExtState): Map<string, string[]> {
  if (!(ext.orderPairs instanceof Map)) {
    return rebuildOrderbookPairIndex(ext);
  }
  return normalizeOrderPairIndex(ext.orderPairs);
}

export function replaceOrderbookPair(ext: OrderbookExtState, pairId: string, book: BookState): void {
  const orderPairs = ensureOrderbookPairIndex(ext);
  const previous = ext.books.get(pairId);
  if (previous) {
    for (const orderId of previous.orders.keys()) {
      removePairFromOrderIndex(orderPairs, orderId, pairId);
    }
  }
  ext.books.set(pairId, book);
  for (const orderId of book.orders.keys()) {
    addPairToOrderIndex(orderPairs, orderId, pairId);
  }
}

export function getOrderbookPairsForOrder(ext: OrderbookExtState, orderId: string): string[] {
  const index = ensureOrderbookPairIndex(ext);
  const indexedPairs = index.get(orderId) ?? [];
  const livePairs = indexedPairs.filter((pairId) => ext.books.get(pairId)?.orders.has(orderId));
  if (livePairs.length === 0) index.delete(orderId);
  else if (livePairs.length !== indexedPairs.length) index.set(orderId, livePairs);
  return [...livePairs];
}
