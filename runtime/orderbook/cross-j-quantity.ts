import { getSwapLotScale } from './types';

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
