import { getTokenInfo } from '../../account/utils';
import { getSwapExactQuoteLotMultipleAtPriceForDimensions, getSwapLotScale, ORDERBOOK_PRICE_SCALE } from '../types';

/**
 * Canonical executable cross-j book quantity.
 *
 * A book lot expands back to `lotScale` base units. Rounding a remainder up
 * would advertise more than the signed route owns; a later match either
 * overfills the Pull or produces a cache mismatch. Floor is therefore the
 * only conservative representation. A sub-lot remainder is closed through
 * the route's explicit dust/cancel policy, never by minting one extra lot.
 */
export const crossJurisdictionBookQtyLots = (
  baseTokenId: number,
  baseAmount: bigint,
): bigint => {
  if (baseAmount <= 0n) return 0n;
  return baseAmount / getSwapLotScale(baseTokenId);
};

/** Cap a resting route by both signed legs at its committed limit price. */
export const crossJurisdictionExecutableQtyLots = (
  baseTokenId: number,
  quoteTokenId: number,
  baseAmount: bigint,
  quoteAmount: bigint,
  priceTicks: bigint,
): bigint => {
  const baseDecimals = getTokenInfo(baseTokenId).decimals;
  const quoteDecimals = getTokenInfo(quoteTokenId).decimals;
  const numerator = getSwapLotScale(baseTokenId) * priceTicks * 10n ** BigInt(quoteDecimals);
  if (numerator <= 0n || quoteAmount <= 0n) return 0n;
  const denominator = ORDERBOOK_PRICE_SCALE * 10n ** BigInt(baseDecimals);
  const quoteBound = ((quoteAmount + 1n) * denominator - 1n) / numerator;
  const lots = crossJurisdictionBookQtyLots(baseTokenId, baseAmount);
  const bounded = lots < quoteBound ? lots : quoteBound;
  const exact = getSwapExactQuoteLotMultipleAtPriceForDimensions(baseDecimals, quoteDecimals, priceTicks);
  return bounded - bounded % exact;
};
