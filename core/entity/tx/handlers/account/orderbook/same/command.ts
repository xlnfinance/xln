import {
  applyCommand,
  getSwapExactQuoteLotMultipleAtPriceForDimensions,
  OrderbookCapacityError,
  resumeCrossedBook,
} from '../../../../../../orderbook';
import { createStructuredLogger, shortId, shortOrder } from '../../../../../../support/logger';
import {
  classifySameBookMaker,
  containSamePairFailure,
  queueSameSwapResolve,
  recordZeroFillCancel,
  type SameOrderbookPass,
} from './pass';
import type { PreparedSameOffer } from './offer-types';

const orderbookSameLog = createStructuredLogger('orderbook.same');

const rejectFullBook = (
  pass: SameOrderbookPass,
  offer: PreparedSameOffer,
): void => {
  recordZeroFillCancel(pass, 'book-full');
  orderbookSameLog.debug('book.full', {
    pair: offer.bookKey,
    maxOrders: offer.book.params.maxOrders,
    offer: shortOrder(offer.offer.offerId, 8),
    account: shortId(offer.accountId, 8),
  });
  const reason = `book-full:${offer.book.params.maxOrders}`;
  if (pass.debugRebuildProjectionOnly) {
    pass.recordDebugProjectionReject(offer.accountId, offer.offer.offerId, reason);
    return;
  }
  const queued = queueSameSwapResolve(
    pass,
    offer.accountId,
    {
      offerId: offer.offer.offerId,
      fillRatio: 0,
      cancelRemainder: true,
      comment: reason,
    },
  );
  if (queued) {
    orderbookSameLog.debug('resolve.queued_cancel_full_book', {
      offer: shortOrder(offer.offer.offerId, 8),
      account: shortId(offer.accountId, 8),
    });
  }
};

export const applySameOfferCommand = (
  pass: SameOrderbookPass,
  offer: PreparedSameOffer,
): ReturnType<typeof applyCommand> | null => {
  orderbookSameLog.debug('order.add', {
    maker: shortId(offer.makerId),
    order: shortOrder(offer.namespacedOrderId, 20),
    side: offer.side,
    price: offer.priceTicks.toString(),
    qty: offer.qtyLots.toString(),
  });
  try {
    const result = applyCommand(
      // applyCommand returns a dirty-branch child overlay. The caller keeps it
      // only after every paired Account resolve passes fee authorization.
      offer.book,
      {
        kind: 0,
        ownerId: offer.makerId,
        orderId: offer.namespacedOrderId,
        side: offer.side,
        tif: offer.offer.timeInForce,
        postOnly: pass.debugRebuildProjectionOnly,
        priceTicks: offer.priceTicks,
        qtyLots: offer.qtyLots,
      },
      {
        suspendedOrderIds: pass.suspendedSameOrderIds,
        makerDisposition: maker => classifySameBookMaker(pass, offer.bookKey, maker),
        executionQtyMultipleAtPrice: (priceTicks) =>
          getSwapExactQuoteLotMultipleAtPriceForDimensions(
            offer.baseTokenDecimals,
            offer.quoteTokenDecimals,
            priceTicks,
          ),
      },
    );
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof OrderbookCapacityError) {
      rejectFullBook(pass, offer);
    } else {
      containSamePairFailure(
        pass,
        offer.bookKey,
        offer.accountId,
        offer.offer.offerId,
        message,
      );
    }
    return null;
  }
};

export const resumeCrossedSameBook = (
  pass: SameOrderbookPass,
  offer: PreparedSameOffer,
): ReturnType<typeof resumeCrossedBook> => {
  try {
    return resumeCrossedBook(offer.book, {
      suspendedOrderIds: pass.suspendedSameOrderIds,
      makerDisposition: maker => classifySameBookMaker(pass, offer.bookKey, maker),
      executionQtyMultipleAtPrice: (priceTicks) =>
        getSwapExactQuoteLotMultipleAtPriceForDimensions(
          offer.baseTokenDecimals,
          offer.quoteTokenDecimals,
          priceTicks,
        ),
    });
  } catch (error) {
    containSamePairFailure(
      pass,
      offer.bookKey,
      offer.accountId,
      offer.offer.offerId,
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
};
