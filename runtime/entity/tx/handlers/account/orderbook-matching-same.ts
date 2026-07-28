import { createStructuredLogger } from '../../../../infra/logger';
import { createSameOrderbookPass, type SameOrderbookProcessInput } from './orderbook-matching-same-pass';
import { processSameOrderbookOffer } from './orderbook-matching-same-offer';

const orderbookSameLog = createStructuredLogger('orderbook.same');

/**
 * Same-j offers are processed serially in their committed input order. Each
 * offer may update the cached book and enqueue exact bilateral swap_resolves
 * before the following offer is admitted.
 */
export const processSameAccountOrderbookOffers = (
  input: SameOrderbookProcessInput,
): void => {
  const pass = createSameOrderbookPass(input);
  for (const offer of input.sameAccountSwapOffers) {
    processSameOrderbookOffer(pass, offer);
  }
  if (pass.pairSweepCount > 0) {
    orderbookSameLog.debug('pass.summary', {
      pairSweep: pass.pairSweepCount,
    });
  }
};
