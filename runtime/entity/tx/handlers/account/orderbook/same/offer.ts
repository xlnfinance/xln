import type { SameJurisdictionWorkingOrderbookOffer } from '../../../../../../orderbook/swap-execution';
import { SwapNetAuthorizationError } from '../../../../../../account/swap/swap-net-authorization';
import {
  keepIdenticalRestingOrder,
  materializeSameOffer,
  prepareSameOffer,
} from './admission';
import { applySameOfferCommand } from './command';
import { processSameCommandEvents, rejectFeeUnauthorizedOffer } from './results';
import {
  containSamePairFailure,
  type SameOrderbookPass,
} from './pass';

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
    pass.ext.pairDimensions.set(prepared.bookKey, {
      baseTokenDecimals: prepared.baseTokenDecimals,
      quoteTokenDecimals: prepared.quoteTokenDecimals,
    });
    pass.bookCache.set(prepared.bookKey, result.state);
    if (!pass.debugRebuildProjectionOnly) {
      pass.bookUpdates.push({ pairId: prepared.bookKey, book: result.state });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof SwapNetAuthorizationError) {
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
