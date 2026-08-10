import type { SameJurisdictionWorkingOrderbookOffer } from '../../../../orderbook/swap-execution';
import {
  keepIdenticalRestingOrder,
  materializeSameOffer,
  prepareSameOffer,
} from './orderbook-matching-same-admission';
import { applySameOfferCommand } from './orderbook-matching-same-command';
import { processSameCommandEvents, rejectFeeUnauthorizedOffer } from './orderbook-matching-same-results';
import {
  containSamePairFailure,
  type SameOrderbookPass,
} from './orderbook-matching-same-pass';

export const processSameOrderbookOffer = (
  pass: SameOrderbookPass,
  offer: SameJurisdictionWorkingOrderbookOffer,
): void => {
  const materialized = materializeSameOffer(pass, offer);
  if (!materialized) return;
  const prepared = prepareSameOffer(pass, materialized);
  if (!prepared || keepIdenticalRestingOrder(pass, prepared)) return;
  const result = applySameOfferCommand(pass, prepared);
  if (!result) return;
  try {
    processSameCommandEvents(pass, prepared, result);
    pass.bookCache.set(prepared.bookKey, result.state);
    if (!pass.debugRebuildProjectionOnly) {
      pass.bookUpdates.push({ pairId: prepared.bookKey, book: result.state });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('SWAP_NET_AUTH_')) {
      rejectFeeUnauthorizedOffer(pass, prepared);
      return;
    }
    containSamePairFailure(
      pass,
      prepared.bookKey,
      prepared.accountId,
      prepared.offer.offerId,
      message,
    );
  }
};
