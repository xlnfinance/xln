import { asOfferId, compareCanonicalText, swapKey, type OfferId, type SwapKey } from './swap-keys.ts';
import { deriveSide } from './orderbook/types.ts';
import type { CrossJurisdictionSwapRoute } from './types';

export const MAX_SWAP_FILL_RATIO = 65535;

export interface SwapOfferLike {
  giveTokenId: number;
  wantTokenId: number;
  giveAmount: bigint;
  quantizedGive?: bigint;
  quantizedWant?: bigint;
}

export interface NormalizedOrderbookOffer extends SwapOfferLike {
  offerId: string;
  accountId: string;
  makerIsLeft: boolean;
  fromEntity: string;
  toEntity: string;
  wantAmount: bigint;
  priceTicks: bigint;
  timeInForce: 0 | 1 | 2;
  minFillRatio: number;
  createdHeight: number;
  crossJurisdiction?: CrossJurisdictionSwapRoute;
}

export const WORKING_ORDERBOOK_OFFER_BRAND: unique symbol = Symbol('WORKING_ORDERBOOK_OFFER_BRAND');

// Only entity-level admission may create WorkingOrderbookOffer. The shared
// book matcher must never receive raw UI/account events or uncommitted locks.
export type SameJurisdictionWorkingOrderbookOffer = NormalizedOrderbookOffer & {
  readonly [WORKING_ORDERBOOK_OFFER_BRAND]: true;
  readonly orderbookKind: 'same-jurisdiction';
  readonly crossJurisdiction?: undefined;
};

export type CrossJurisdictionWorkingOrderbookOffer = NormalizedOrderbookOffer & {
  readonly [WORKING_ORDERBOOK_OFFER_BRAND]: true;
  readonly orderbookKind: 'cross-jurisdiction';
  readonly crossJurisdiction: CrossJurisdictionSwapRoute;
};

export type WorkingOrderbookOffer = SameJurisdictionWorkingOrderbookOffer | CrossJurisdictionWorkingOrderbookOffer;

export function isWorkingOrderbookOffer(offer: unknown): offer is WorkingOrderbookOffer {
  return Boolean(
    offer &&
      typeof offer === 'object' &&
      (offer as { [WORKING_ORDERBOOK_OFFER_BRAND]?: unknown })[WORKING_ORDERBOOK_OFFER_BRAND] === true,
  );
}

export function markWorkingOrderbookOffer(offer: NormalizedOrderbookOffer): WorkingOrderbookOffer {
  if (offer.crossJurisdiction) {
    return {
      ...offer,
      [WORKING_ORDERBOOK_OFFER_BRAND]: true,
      orderbookKind: 'cross-jurisdiction',
    } as CrossJurisdictionWorkingOrderbookOffer;
  }
  const { crossJurisdiction: _crossJurisdiction, ...sameOffer } = offer;
  return {
    ...sameOffer,
    [WORKING_ORDERBOOK_OFFER_BRAND]: true,
    orderbookKind: 'same-jurisdiction',
  } as SameJurisdictionWorkingOrderbookOffer;
}

export { asOfferId, compareCanonicalText, swapKey, type OfferId, type SwapKey };

export interface ExactFillRatio {
  numerator: bigint;
  denominator: bigint;
}

const bigintGcd = (left: bigint, right: bigint): bigint => {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) {
    const next = a % b;
    a = b;
    b = next;
  }
  return a === 0n ? 1n : a;
};

export function reduceExactFillRatio(numerator: bigint, denominator: bigint): ExactFillRatio {
  if (denominator <= 0n) {
    throw new Error(`EXACT_FILL_RATIO_INVALID_DENOMINATOR:${denominator.toString()}`);
  }
  const boundedNumerator = numerator <= 0n ? 0n : numerator >= denominator ? denominator : numerator;
  if (boundedNumerator === 0n) return { numerator: 0n, denominator: 1n };
  if (boundedNumerator === denominator) return { numerator: 1n, denominator: 1n };
  const divisor = bigintGcd(boundedNumerator, denominator);
  return {
    numerator: boundedNumerator / divisor,
    denominator: denominator / divisor,
  };
}

export function exactFillRatioToUint16(ratio: ExactFillRatio): number {
  if (ratio.denominator <= 0n) {
    throw new Error(`EXACT_FILL_RATIO_INVALID_DENOMINATOR:${ratio.denominator.toString()}`);
  }
  if (ratio.numerator <= 0n) return 0;
  if (ratio.numerator >= ratio.denominator) return MAX_SWAP_FILL_RATIO;

  const max = BigInt(MAX_SWAP_FILL_RATIO);
  let coarse = Number((ratio.numerator * max + ratio.denominator - 1n) / ratio.denominator);
  if (coarse < 0) coarse = 0;
  if (coarse > MAX_SWAP_FILL_RATIO) coarse = MAX_SWAP_FILL_RATIO;

  while (coarse > 0 && (ratio.denominator * BigInt(coarse - 1)) / max >= ratio.numerator) {
    coarse -= 1;
  }
  while (coarse < MAX_SWAP_FILL_RATIO && (ratio.denominator * BigInt(coarse)) / max < ratio.numerator) {
    coarse += 1;
  }

  return coarse;
}

export function deriveExactSwapFillRatio(effectiveGive: bigint, filledGive: bigint): ExactFillRatio {
  if (effectiveGive <= 0n || filledGive <= 0n) return { numerator: 0n, denominator: 1n };
  return reduceExactFillRatio(filledGive, effectiveGive);
}

export function deriveCanonicalSwapFillRatio(effectiveGive: bigint, filledGive: bigint): number {
  return exactFillRatioToUint16(deriveExactSwapFillRatio(effectiveGive, filledGive));
}

export function buildSwapResolveDataFromOrderbookFill(
  offer: SwapOfferLike,
  executionBaseWei: bigint,
  executionQuoteWei: bigint,
  cancelRemainder: boolean,
): {
  fillRatio: number;
  fillNumerator: bigint;
  fillDenominator: bigint;
  cancelRemainder: boolean;
  executionGiveAmount?: bigint;
  executionWantAmount?: bigint;
} {
  const offerSide = deriveSide(offer.giveTokenId, offer.wantTokenId);
  const executionGiveAmount = offerSide === 0 ? executionQuoteWei : executionBaseWei;
  const executionWantAmount = offerSide === 0 ? executionBaseWei : executionQuoteWei;
  const effectiveGive = offer.quantizedGive ?? offer.giveAmount;
  const exactFillRatio =
    executionGiveAmount > 0n && executionWantAmount > 0n
      ? deriveExactSwapFillRatio(effectiveGive, executionGiveAmount)
      : { numerator: 0n, denominator: 1n };
  const fillRatio = exactFillRatioToUint16(exactFillRatio);

  return {
    fillRatio: Math.min(fillRatio, MAX_SWAP_FILL_RATIO),
    fillNumerator: exactFillRatio.numerator,
    fillDenominator: exactFillRatio.denominator,
    cancelRemainder,
    ...(executionGiveAmount > 0n && executionWantAmount > 0n ? { executionGiveAmount, executionWantAmount } : {}),
  };
}

export function calculateSwapTakerFeeAmount(filledWantAmount: bigint, takerFeeBps: number): bigint {
  if (filledWantAmount <= 0n) return 0n;
  const normalizedBps = Number.isFinite(takerFeeBps) ? Math.max(0, Math.min(10_000, Math.floor(takerFeeBps))) : 0;
  if (normalizedBps <= 0) return 0n;
  return (filledWantAmount * BigInt(normalizedBps)) / 10_000n;
}
