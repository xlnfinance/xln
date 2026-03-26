import { asOfferId, compareCanonicalText, type OfferId } from './swap-keys.ts';

export interface SwapOwnerSideLike {
  makerIsLeft: boolean;
}

export function sortTransformerEntries<TKey extends string, T>(
  entries: Iterable<[TKey, T]>,
): Array<[TKey, T]> {
  return Array.from(entries).sort((left, right) => compareCanonicalText(left[0], right[0]));
}

export function buildPositionalSwapFillRatioBuckets<TKey extends string, T extends SwapOwnerSideLike>(
  entries: Iterable<[TKey, T]>,
  fillRatiosByOfferId: ReadonlyMap<OfferId, number>,
): { leftFillRatios: number[]; rightFillRatios: number[] } {
  const leftFillRatios: number[] = [];
  const rightFillRatios: number[] = [];

  for (const [offerId, offer] of sortTransformerEntries(entries)) {
    const ratio = fillRatiosByOfferId.get(asOfferId(String(offerId)));
    if (ratio === undefined) {
      throw new Error(`MISSING_FILL_RATIO_FOR_OFFER:${String(offerId)}`);
    }
    if (offer.makerIsLeft) {
      rightFillRatios.push(ratio);
    } else {
      leftFillRatios.push(ratio);
    }
  }

  return { leftFillRatios, rightFillRatios };
}
