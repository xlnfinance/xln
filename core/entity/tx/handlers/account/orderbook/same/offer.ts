import type { SameJurisdictionWorkingOrderbookOffer } from '../../../../../../orderbook/swap-execution';
import { commitBookOverlayInto, getBookOrders } from '../../../../../../orderbook';
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
  classifySameBookMaker,
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

const drainCrossedSameBook = (
  pass: SameOrderbookPass,
  seed: PreparedSameOffer,
): void => {
  let current = seed;
  const limit = seed.book.orders.size;
  for (let resumedCount = 0; ; resumedCount += 1) {
    const resumed = resumeCrossedSameBook(pass, current);
    if (!resumed) return;
    if (resumedCount >= limit) {
      throw haltRuntimeFailure(
        'ORDERBOOK_SAME_DRAIN_NON_TERMINATING',
        `ORDERBOOK_SAME_DRAIN_NON_TERMINATING: pair=${seed.bookKey} limit=${limit}`,
      );
    }
    const taker = prepareCrossedRestingTaker(pass, current, resumed.takerOrderId);
    commitSameCommandResult(pass, taker, resumed);
    const nextBook = pass.bookCache.get(seed.bookKey);
    if (!nextBook) {
      throw haltRuntimeFailure(
        'ORDERBOOK_CACHE_MISMATCH',
        `ORDERBOOK_CACHE_MISMATCH: pair=${seed.bookKey} missing-after-resume`,
      );
    }
    current = { ...current, book: nextBook };
  }
};

const findSamePairResumeSeed = (
  pass: SameOrderbookPass,
  pairId: string,
): PreparedSameOffer | null => {
  const book = pass.bookCache.get(pairId) ?? pass.ext.books.get(pairId);
  if (!book) return null;
  for (const order of getBookOrders(book)) {
    if (classifySameBookMaker(pass, pairId, order) !== 'eligible') continue;
    const live = buildLiveSameOfferMeta(pass, order.orderId);
    if (!live) continue;
    const working = markWorkingOrderbookOffer(live);
    if (working.orderbookKind !== 'same-jurisdiction') {
      throw haltRuntimeFailure(
        'ORDERBOOK_CACHE_MISMATCH',
        `ORDERBOOK_CACHE_MISMATCH: pair=${pairId} cross-order=${order.orderId}`,
      );
    }
    const materialized = materializeSameOffer(pass, working);
    const prepared = materialized ? prepareSameOffer(pass, materialized) : null;
    if (prepared && keepIdenticalRestingOrder(pass, prepared)) return prepared;
  }
  return null;
};

export const resumeCrossedSameOrderbookPair = (
  pass: SameOrderbookPass,
  pairId: string,
): void => {
  const seed = findSamePairResumeSeed(pass, pairId);
  if (seed) drainCrossedSameBook(pass, seed);
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
    drainCrossedSameBook(pass, prepared);
    return;
  }
  const result = applySameOfferCommand(pass, prepared);
  if (!result) return;
  commitSameCommandResult(pass, prepared, result);
};
