import { finalizeCrossOrderbookAcks } from './orderbook-matching-cross-acks';
import {
  crossBookQtyLots,
  primeCommittedCrossBooks,
} from './orderbook-matching-cross-book';
import { processCrossOrderbookOffer } from './orderbook-matching-cross-offer';
import { createCrossOrderbookPass } from './orderbook-matching-cross-pass';
import type { CrossOrderbookProcessInput } from './orderbook-matching-cross-types';

export { crossBookQtyLots };

/**
 * Cross-j matching has three ordered phases: verify the committed projection,
 * simulate every offer, then atomically materialize conserved fill ACKs.
 */
export const processCrossJurisdictionOrderbookOffers = (
  input: CrossOrderbookProcessInput,
): void => {
  const pass = createCrossOrderbookPass(input);
  primeCommittedCrossBooks(pass);
  for (const offer of input.crossJurisdictionSwapOffers) {
    processCrossOrderbookOffer(pass, offer);
  }
  finalizeCrossOrderbookAcks(pass);
};
