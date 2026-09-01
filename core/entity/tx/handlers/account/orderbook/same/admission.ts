import { haltRuntimeFailure } from "../../../../../../protocol/errors/failure-taxonomy";

import { equalSwapPairDimensions, forkBookState, getBestAsk, getBestBid, getBookOrder } from '../../../../../../orderbook';
import { createStructuredLogger, shortId, shortOrder } from '../../../../../../support/logger';
import type { SameJurisdictionWorkingOrderbookOffer } from '../../../../../../orderbook/swap-execution';
import {
  createEmptyPairBook,
  deriveSameOrderbookMaterialization,
  evaluateSameOrderbookPriceBand,
} from '../helpers';
import {
  hasQueuedSwapResolveForEntityState,
} from '../queue';
import {
  queueSameSwapResolve,
  sweepSamePairOutOfBandOffers,
  type SameOrderbookPass,
} from './pass';
import type {
  MaterializedSameOffer,
  PreparedSameOffer,
} from './offer-types';

const orderbookSameLog = createStructuredLogger('orderbook.same');

export const materializeSameOffer = (
  pass: SameOrderbookPass,
  offer: SameJurisdictionWorkingOrderbookOffer,
): MaterializedSameOffer | null => {
  const accountId = offer.accountId;
  if (
    hasQueuedSwapResolveForEntityState(
      pass.hubState,
      pass.queuedSwapResolutions,
      accountId,
      offer.offerId,
    )
  ) {
    return null;
  }
  orderbookSameLog.debug('offer.process', {
    offer: shortOrder(offer.offerId),
    account: shortId(accountId, 8),
  });
  const materialized = deriveSameOrderbookMaterialization(offer, pass.minTradeSize);
  if (materialized.kind === 'reject') {
    // Cancelling a committed offer with a zero fill releases a bilateral hold
    // and destroys the counterparty's expected trade. That is a financial
    // outcome, not a debug detail: name it at warn so an operator sees why an
    // order left the book.
    orderbookSameLog.warn('offer.reject_materialization', {
      offer: shortOrder(offer.offerId, 8),
      account: shortId(accountId, 8),
      reason: materialized.reason,
      message: materialized.message,
      projectionOnly: pass.debugRebuildProjectionOnly,
    });
    if (pass.debugRebuildProjectionOnly) {
      pass.recordDebugProjectionReject(accountId, offer.offerId, materialized.reason);
    } else {
      queueSameSwapResolve(pass, accountId, {
        offerId: offer.offerId,
        fillRatio: 0,
        cancelRemainder: true,
        comment: materialized.reason,
      });
    }
    return null;
  }
  const order = materialized.order;
  const committedDimensions = pass.ext.pairDimensions.get(order.pairId);
  if (committedDimensions && !equalSwapPairDimensions(committedDimensions, order)) {
    orderbookSameLog.warn('offer.reject_pair_decimals', {
      offer: shortOrder(offer.offerId, 8),
      account: shortId(accountId, 8),
      projectionOnly: pass.debugRebuildProjectionOnly,
    });
    if (pass.debugRebuildProjectionOnly) {
      pass.recordDebugProjectionReject(accountId, offer.offerId, 'pair-decimals-mismatch');
    } else {
      queueSameSwapResolve(pass, accountId, {
        offerId: offer.offerId,
        fillRatio: 0,
        cancelRemainder: true,
        comment: 'pair-decimals-mismatch',
      });
    }
    return null;
  }
  return {
    offer,
    accountId,
    bookKey: order.pairId,
    baseTokenDecimals: order.baseTokenDecimals,
    quoteTokenDecimals: order.quoteTokenDecimals,
    side: order.side,
    priceTicks: order.priceTicks,
    qtyLots: order.qtyLots,
    makerId: order.makerId,
    namespacedOrderId: order.namespacedOrderId,
    pairPolicy: order.pairPolicy,
    hasExplicitPairPolicy: order.hasExplicitPairPolicy,
    bucketWidthTicks: order.bucketWidthTicks,
  };
};

const rejectOutsidePriceBand = (
  pass: SameOrderbookPass,
  offer: MaterializedSameOffer,
  reason: string,
): void => {
  if (pass.debugRebuildProjectionOnly) {
    pass.recordDebugProjectionReject(offer.accountId, offer.offer.offerId, reason);
    return;
  }
  queueSameSwapResolve(
    pass,
    offer.accountId,
    {
      offerId: offer.offer.offerId,
      fillRatio: 0,
      cancelRemainder: true,
      comment: reason,
    },
  );
};

export const prepareSameOffer = (
  pass: SameOrderbookPass,
  offer: MaterializedSameOffer,
): PreparedSameOffer | null => {
  let book = pass.bookCache.get(offer.bookKey);
  if (!book) {
    const committed = pass.ext.books.get(offer.bookKey);
    book = committed ? forkBookState(committed) : undefined;
    if (book) pass.bookCache.set(offer.bookKey, book);
  }
  book = book ?? forkBookState(createEmptyPairBook(offer.bucketWidthTicks));
  if (!pass.sweptPairs.has(offer.bookKey)) {
    pass.sweptPairs.add(offer.bookKey);
    const swept = sweepSamePairOutOfBandOffers(
      pass,
      offer.bookKey,
      offer.pairPolicy,
      offer.hasExplicitPairPolicy,
      book,
    );
    if (swept !== book) {
      book = swept;
      pass.bookCache.set(offer.bookKey, book);
      pass.bookUpdates.push({ pairId: offer.bookKey, book });
    }
  }
  const bestBid = getBestBid(book);
  const bestAsk = getBestAsk(book);
  const band = evaluateSameOrderbookPriceBand({
    priceTicks: offer.priceTicks,
    side: offer.side,
    bestBid,
    bestAsk,
    pairPolicy: offer.pairPolicy,
    hasExplicitPairPolicy: offer.hasExplicitPairPolicy,
  });
  if (band.rejectReason) {
    orderbookSameLog.warn('offer.reject_price_band', {
      offer: shortOrder(offer.offer.offerId, 8),
      account: shortId(offer.accountId, 8),
      reason: band.rejectReason,
      message: band.rejectMessage,
      projectionOnly: pass.debugRebuildProjectionOnly,
    });
    rejectOutsidePriceBand(pass, offer, band.rejectReason);
    return null;
  }
  if (band.warnMessage) {
    orderbookSameLog.debug('offer.price_band_warning', {
      offer: shortOrder(offer.offer.offerId, 8),
      account: shortId(offer.accountId, 8),
      message: band.warnMessage,
    });
  }
  pass.orderbookOfferMeta.set(offer.namespacedOrderId, {
    ...offer.offer,
    accountId: offer.accountId,
    priceTicks: offer.priceTicks,
  });
  return { ...offer, book, bestBid, bestAsk };
};

export const keepIdenticalRestingOrder = (
  pass: SameOrderbookPass,
  prepared: PreparedSameOffer,
): boolean => {
  const existing = getBookOrder(prepared.book, prepared.namespacedOrderId);
  if (!existing) return false;
  if (
    existing.ownerId !== prepared.makerId ||
    existing.side !== prepared.side ||
    existing.qtyLots !== prepared.qtyLots ||
    existing.priceTicks !== prepared.priceTicks
  ) {
    orderbookSameLog.debug('order.cache_mismatch', {
      offer: shortOrder(prepared.offer.offerId, 8),
      account: shortId(prepared.accountId, 8),
      storedPrice: existing.priceTicks.toString(),
      canonicalPrice: prepared.priceTicks.toString(),
      storedQty: existing.qtyLots.toString(),
      canonicalQty: prepared.qtyLots.toString(),
    });
    throw haltRuntimeFailure("ORDERBOOK_CACHE_MISMATCH", `ORDERBOOK_CACHE_MISMATCH: pair=${prepared.bookKey} ` +
      `order=${prepared.namespacedOrderId}`);
  }
  orderbookSameLog.debug('order.resting', {
    offer: shortOrder(prepared.offer.offerId, 8),
    account: shortId(prepared.accountId, 8),
    price: prepared.priceTicks.toString(),
    qty: prepared.qtyLots.toString(),
  });
  pass.bookCache.set(prepared.bookKey, prepared.book);
  return true;
};
