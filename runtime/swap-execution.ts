import { asOfferId, compareCanonicalText, swapKey, type OfferId, type SwapKey } from './swap-keys.ts';
import { deriveSide } from './orderbook/types.ts';

export const MAX_SWAP_FILL_RATIO = 65535;

export interface SwapOfferLike {
  giveTokenId: number;
  wantTokenId: number;
  giveAmount: bigint;
  quantizedGive?: bigint;
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
}

export { asOfferId, compareCanonicalText, swapKey, type OfferId, type SwapKey };

export function deriveCanonicalSwapFillRatio(effectiveGive: bigint, filledGive: bigint): number {
  if (effectiveGive <= 0n || filledGive <= 0n) return 0;
  if (filledGive >= effectiveGive) return MAX_SWAP_FILL_RATIO;

  const max = BigInt(MAX_SWAP_FILL_RATIO);
  let ratio = Number((filledGive * max + effectiveGive - 1n) / effectiveGive);
  if (ratio < 0) ratio = 0;
  if (ratio > MAX_SWAP_FILL_RATIO) ratio = MAX_SWAP_FILL_RATIO;

  while (ratio > 0 && ((effectiveGive * BigInt(ratio - 1)) / max) >= filledGive) {
    ratio -= 1;
  }
  while (ratio < MAX_SWAP_FILL_RATIO && ((effectiveGive * BigInt(ratio)) / max) < filledGive) {
    ratio += 1;
  }

  return ratio;
}

export function buildSwapResolveDataFromOrderbookFill(
  offer: SwapOfferLike,
  executionBaseWei: bigint,
  executionQuoteWei: bigint,
  cancelRemainder: boolean,
): {
  fillRatio: number;
  cancelRemainder: boolean;
  executionGiveAmount?: bigint;
  executionWantAmount?: bigint;
} {
  const offerSide = deriveSide(offer.giveTokenId, offer.wantTokenId);
  const executionGiveAmount = offerSide === 0 ? executionQuoteWei : executionBaseWei;
  const executionWantAmount = offerSide === 0 ? executionBaseWei : executionQuoteWei;
  const effectiveGive = offer.quantizedGive ?? offer.giveAmount;
  const fillRatio =
    executionGiveAmount > 0n && executionWantAmount > 0n
      ? deriveCanonicalSwapFillRatio(effectiveGive, executionGiveAmount)
      : 0;

  return {
    fillRatio: Math.min(fillRatio, MAX_SWAP_FILL_RATIO),
    cancelRemainder,
    ...(executionGiveAmount > 0n && executionWantAmount > 0n
      ? { executionGiveAmount, executionWantAmount }
      : {}),
  };
}
