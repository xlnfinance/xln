import type { SameJurisdictionWorkingOrderbookOffer } from '../../../../../../orderbook/swap-execution';
import { commitBookOverlayInto } from '../../../../../../orderbook';
import { markWorkingOrderbookOffer } from '../../../../../../orderbook/swap-execution';
import { haltRuntimeFailure } from '../../../../../../protocol/errors/failure-taxonomy';
import { SwapNetAuthorizationError } from '../../../../../../account/swap/swap-net-authorization';
import {
  keepIdenticalRestingOrder,
  materializeSameOffer,
  prepareSameOffer,
} from './admission';
import { applySameOfferCommand, resumeCrossedSameBook } from './command';
import { processSameCommandEvents, rejectFeeUnauthorizedOffer } from './results';
import {
  containSamePairFailure,
  buildLiveSameOfferMeta,
  type SameOrderbookPass,
} from './pass';
import type { PreparedSameOffer } from './offer-types';

type SameCommandResult = NonNullable<ReturnType<typeof applySameOfferCommand>>;

const commitSameCommandResult = (
  pass: SameOrderbookPass,
  offer: PreparedSameOffer,
  result: SameCommandResult,
): void => {
  try {
    processSameCommandEvents(pass, offer, result);
    pass.ext.pairDimensions.set(offer.bookKey, {
      baseTokenDecimals: offer.baseTokenDecimals,
      quoteTokenDecimals: offer.quoteTokenDecimals,
    });
    const acceptedBook = commitBookOverlayInto(result.state, offer.book);
    pass.bookCache.set(offer.bookKey, acceptedBook);
    if (!pass.debugRebuildProjectionOnly) {
      pass.bookUpdates.push({ pairId: offer.bookKey, book: acceptedBook });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof SwapNetAuthorizationError) {
      rejectFeeUnauthorizedOffer(pass, offer);
      return;
    }
    containSamePairFailure(
      pass,
      offer.bookKey,
      offer.accountId,
      offer.offer.offerId,
      message,
    );
  }
};

const prepareCrossedRestingTaker = (
  pass: SameOrderbookPass,
  trigger: PreparedSameOffer,
  takerOrderId: string,
): PreparedSameOffer => {
  const live = buildLiveSameOfferMeta(pass, takerOrderId);
  if (!live) {
    throw haltRuntimeFailure(
      'ORDERBOOK_SAME_SNAPSHOT_MISSING',
      `ORDERBOOK_SAME_SNAPSHOT_MISSING: pair=${trigger.bookKey} order=${takerOrderId}`,
    );
  }
  const working = markWorkingOrderbookOffer(live);
  if (working.orderbookKind !== 'same-jurisdiction') {
    throw haltRuntimeFailure(
      'ORDERBOOK_SAME_SNAPSHOT_MISSING',
      `ORDERBOOK_SAME_SNAPSHOT_MISSING: pair=${trigger.bookKey} cross-order=${takerOrderId}`,
    );
  }
  const materialized = materializeSameOffer(pass, working);
  const prepared = materialized ? prepareSameOffer(pass, materialized) : null;
  if (!prepared || !keepIdenticalRestingOrder(pass, prepared)) {
    throw haltRuntimeFailure(
      'ORDERBOOK_CACHE_MISMATCH',
      `ORDERBOOK_CACHE_MISMATCH: pair=${trigger.bookKey} order=${takerOrderId}`,
    );
  }
  return prepared;
};

export const processSameOrderbookOffer = (
  pass: SameOrderbookPass,
  offer: SameJurisdictionWorkingOrderbookOffer,
): void => {
  const materialized = materializeSameOffer(pass, offer);
  if (!materialized) return;
  const prepared = prepareSameOffer(pass, materialized);
  if (!prepared) return;
  if (keepIdenticalRestingOrder(pass, prepared)) {
    const resumed = resumeCrossedSameBook(pass, prepared);
    if (!resumed) return;
    const taker = prepareCrossedRestingTaker(pass, prepared, resumed.takerOrderId);
    commitSameCommandResult(pass, taker, resumed);
    return;
  }
  const result = applySameOfferCommand(pass, prepared);
  if (!result) return;
  commitSameCommandResult(pass, prepared, result);
};
