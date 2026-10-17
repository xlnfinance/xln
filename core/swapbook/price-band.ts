import { SWAP_CONSTANTS } from '../config/constants';

export const deriveSameOrderbookPriceBandBounds = (
  anchor: bigint,
): Readonly<{ minAllowed: bigint; maxAllowed: bigint }> => {
  if (anchor <= 0n) throw new Error('ORDERBOOK_PRICE_BAND_ANCHOR_INVALID');
  const offset = (anchor * BigInt(SWAP_CONSTANTS.PRICE_REJECT_BPS)) / BigInt(SWAP_CONSTANTS.BPS_BASE);
  return { minAllowed: anchor - offset, maxAllowed: anchor + offset };
};

/** Canonical market anchor; the Entity alone adds its committed policy for an empty book. */
export const resolveOrderbookPriceReference = (
  bestBid: bigint | null,
  bestAsk: bigint | null,
): Readonly<{ anchor: bigint | null; label: string }> => {
  if (bestBid !== null && bestAsk !== null) {
    return { anchor: (bestBid + bestAsk) / 2n, label: 'midpoint' };
  }
  if (bestBid !== null) return { anchor: bestBid, label: 'bestBid' };
  if (bestAsk !== null) return { anchor: bestAsk, label: 'bestAsk' };
  return { anchor: null, label: 'unanchored' };
};
