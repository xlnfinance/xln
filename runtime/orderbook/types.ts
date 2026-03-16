/**
 * Orderbook Types for XLN
 *
 * Re-exports core types and adds higher-level concepts (spread, referrals).
 */

// Re-export core types
export type { Side, TIF, OrderCmd, BookEvent, BookParams, BookState } from './core';
export { createBook, applyCommand, getBestBid, getBestAsk, getSpread, computeBookHash, MAX_FILL_RATIO } from './core';

// Import for local use
import { MAX_FILL_RATIO } from './core';
import { getSwapPairOrientation, getSwapPairPolicyByBaseQuote } from '../account-utils';

// Price tick precision used for ratio encoding in orderbook flows.
// 10000 = 4 decimals (e.g. 1.2345)
export const ORDERBOOK_PRICE_SCALE = 10_000n;

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
  // Fallback for malformed directions (should not happen in valid swaps)
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
  const pairPolicy = getSwapPairPolicyByBaseQuote(base, quote);
  const stepTicks = BigInt(Math.max(1, pairPolicy.priceStepTicks));

  let priceTicks = (rawQuoteAmount * ORDERBOOK_PRICE_SCALE) / rawBaseAmount;
  if (side === 1) {
    priceTicks = ((priceTicks + stepTicks - 1n) / stepTicks) * stepTicks;
  } else {
    priceTicks = (priceTicks / stepTicks) * stepTicks;
  }
  return priceTicks > 0n ? priceTicks : 0n;
}

/** Lot granularity for swap order quantization (shared with frontend) */
export const SWAP_LOT_SCALE = 10n ** 12n;

export interface PreparedSwapOrder {
  side: 0 | 1;
  baseTokenId: number;
  quoteTokenId: number;
  priceTicks: bigint;
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
export function prepareSwapOrder(
  giveTokenId: number,
  wantTokenId: number,
  giveAmount: bigint,
  wantAmount: bigint,
): PreparedSwapOrder | null {
  if (giveAmount <= 0n || wantAmount <= 0n) return null;

  const side = deriveSide(giveTokenId, wantTokenId);
  const rawBaseAmount = side === 1 ? giveAmount : wantAmount;
  const rawQuoteAmount = side === 1 ? wantAmount : giveAmount;
  if (rawBaseAmount < SWAP_LOT_SCALE || rawQuoteAmount <= 0n) return null;

  const priceTicks = computeSwapPriceTicks(giveTokenId, wantTokenId, giveAmount, wantAmount);
  if (priceTicks <= 0n) return null;

  const quantizedBaseAmount = (rawBaseAmount / SWAP_LOT_SCALE) * SWAP_LOT_SCALE;
  if (quantizedBaseAmount <= 0n) return null;

  const quantizedQuoteAmount = (quantizedBaseAmount * priceTicks) / ORDERBOOK_PRICE_SCALE;
  if (quantizedQuoteAmount <= 0n) return null;

  const { base, quote } = canonicalPair(giveTokenId, wantTokenId);
  const effectiveGive = side === 1 ? quantizedBaseAmount : quantizedQuoteAmount;
  const effectiveWant = side === 1 ? quantizedQuoteAmount : quantizedBaseAmount;
  const unspentGiveAmount = giveAmount > effectiveGive ? giveAmount - effectiveGive : 0n;

  return {
    side,
    baseTokenId: base,
    quoteTokenId: quote,
    priceTicks,
    rawBaseAmount,
    rawQuoteAmount,
    quantizedBaseAmount,
    quantizedQuoteAmount,
    effectiveGive,
    effectiveWant,
    unspentGiveAmount,
  };
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

/** Calculate fill amount from ratio (uint16) */
export function applyFillRatio(amount: bigint, ratio: number): bigint {
  if (ratio >= MAX_FILL_RATIO) return amount;
  if (ratio <= 0) return 0n;
  return (amount * BigInt(ratio)) / BigInt(MAX_FILL_RATIO);
}

// ============================================================================
// Spread Distribution (Hub Profile)
// ============================================================================

/** Basis points constant (10000 = 100%) */
export const BPS_BASE = 10000;

/**
 * Spread distribution rules - how trade spread is allocated
 * All values in basis points, must sum to 10000 (100%)
 */
export interface SpreadDistribution {
  makerBps: number;         // Price improvement to maker
  takerBps: number;         // Rebate to taker
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

/** Default: equal 20% split to all parties */
export const DEFAULT_SPREAD_DISTRIBUTION: SpreadDistribution = {
  makerBps: 2000,
  takerBps: 2000,
  hubBps: 2000,
  makerReferrerBps: 2000,
  takerReferrerBps: 2000,
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
  minTradeSize: bigint;      // Minimum trade size in reference token
  supportedPairs: string[];  // e.g., ["1/2", "1/3"]
}

/**
 * Calculated spread allocation for a single trade
 * Amounts in reference token (quote currency)
 */
export interface SpreadAllocation {
  totalSpread: bigint;       // taker_limit - maker_price
  makerBonus: bigint;        // Added to maker's execution price
  takerRebate: bigint;       // Returned to taker
  hubRevenue: bigint;        // Hub keeps
  makerReferrerFee: bigint;  // DirectPayment to maker's referrer
  takerReferrerFee: bigint;  // DirectPayment to taker's referrer
}

/**
 * Calculate spread allocation based on distribution rules
 */
export function calculateSpreadAllocation(
  spread: bigint,
  distribution: SpreadDistribution
): SpreadAllocation {
  if (spread <= 0n) {
    return {
      totalSpread: 0n,
      makerBonus: 0n,
      takerRebate: 0n,
      hubRevenue: 0n,
      makerReferrerFee: 0n,
      takerReferrerFee: 0n,
    };
  }

  const base = BigInt(BPS_BASE);

  // Calculate each portion, rounding down
  const makerBonus = (spread * BigInt(distribution.makerBps)) / base;
  const takerRebate = (spread * BigInt(distribution.takerBps)) / base;
  const makerReferrerFee = (spread * BigInt(distribution.makerReferrerBps)) / base;
  const takerReferrerFee = (spread * BigInt(distribution.takerReferrerBps)) / base;

  // Hub gets remainder (avoids rounding dust loss)
  const hubRevenue = spread - makerBonus - takerRebate - makerReferrerFee - takerReferrerFee;

  return {
    totalSpread: spread,
    makerBonus,
    takerRebate,
    hubRevenue,
    makerReferrerFee,
    takerReferrerFee,
  };
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

  /** Referrer tracking */
  referrals: Map<string, EntityReferral>;

  /** Hub configuration */
  hubProfile: HubProfile;
}

/** Create initial orderbook extension state */
export function createOrderbookExtState(hubProfile: HubProfile): OrderbookExtState {
  return {
    books: new Map(),
    referrals: new Map(),
    hubProfile,
  };
}
