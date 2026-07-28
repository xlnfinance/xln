import { getBestAsk, getBestBid, getBookOrder } from '../../../../orderbook';
import { createStructuredLogger, shortId, shortOrder } from '../../../../infra/logger';
import type { SameJurisdictionWorkingOrderbookOffer } from '../../../../orderbook/swap-execution';
import {
  createEmptyPairBook,
  deriveSameOrderbookMaterialization,
  evaluateSameOrderbookPriceBand,
} from './orderbook-matching-helpers';
import {
  hasQueuedSwapResolveForEntityState,
  queueUniqueSwapResolveForEntityState,
} from './orderbook-queue';
import {
  assertSameBookMatchesAccounts,
  sweepSamePairOutOfBandOffers,
  type SameOrderbookPass,
} from './orderbook-matching-same-pass';
import type {
  MaterializedSameOffer,
  PreparedSameOffer,
} from './orderbook-matching-same-offer-types';

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
    orderbookSameLog.debug('offer.reject_materialization', {
      offer: shortOrder(offer.offerId, 8),
      account: shortId(accountId, 8),
      reason: materialized.reason,
      message: materialized.message,
    });
    pass.rejectInvalidOffer(accountId, offer.offerId, materialized.reason);
    return null;
  }
  const order = materialized.order;
  return {
    offer,
    accountId,
    bookKey: order.pairId,
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
  queueUniqueSwapResolveForEntityState(
    pass.accountTxs,
    pass.hubState,
    pass.queuedSwapResolutions,
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
  let book = pass.bookCache.get(offer.bookKey) ?? pass.ext.books.get(offer.bookKey);
  book = book
    ? assertSameBookMatchesAccounts(pass, offer.bookKey, book)
    : createEmptyPairBook(offer.bucketWidthTicks);
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
    orderbookSameLog.debug('offer.reject_price_band', {
      offer: shortOrder(offer.offer.offerId, 8),
      account: shortId(offer.accountId, 8),
      reason: band.rejectReason,
      message: band.rejectMessage,
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
    throw new Error(
      `ORDERBOOK_CACHE_MISMATCH: pair=${prepared.bookKey} ` +
      `order=${prepared.namespacedOrderId}`,
    );
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
