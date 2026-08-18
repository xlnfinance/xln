import { haltRuntimeFailure } from "../../../../../../protocol/errors/failure-taxonomy";

import {
  forkBookState,
  getBookOrder,
  getSwapExactQuoteLotMultipleAtPriceForDimensions,
  MAX_ORDERBOOK_QTY_LOTS,
} from '../../../../../../orderbook';
import { getSwapPairPolicyByBaseQuote } from '../../../../../../account/utils';
import { swapKey, type CrossJurisdictionWorkingOrderbookOffer } from '../../../../../../orderbook/swap-execution';
import { createEmptyPairBook } from '../helpers';
import {
  hasQueuedCrossSwapAckForEntityState,
  hasQueuedSwapResolveForEntityState,
} from '../queue';
import {
  assertPendingBookFillAckLive,
  getCrossMarketOffer,
} from './pass';
import {
  crossBookQtyLots,
} from './book';
import type {
  CrossOrderbookPass,
  PreparedCrossOffer,
} from './types';

const validateExistingCrossOrder = (
  prepared: PreparedCrossOffer,
): boolean => {
  const order = getBookOrder(prepared.committedBook, prepared.namespacedOrderId);
  if (!order) return false;
  const { marketOffer, qtyLots } = prepared;
  if (
    order.ownerId !== marketOffer.makerId ||
    order.side !== marketOffer.side ||
    order.priceTicks !== marketOffer.priceTicks ||
    order.qtyLots !== qtyLots
  ) {
    throw haltRuntimeFailure("ORDERBOOK_CROSS_J_DUPLICATE_SNAPSHOT_MISMATCH", `ORDERBOOK_CROSS_J_DUPLICATE_SNAPSHOT_MISMATCH: ` +
      `pair=${marketOffer.pairId} order=${prepared.namespacedOrderId} ` +
      `storedOwner=${order.ownerId} canonicalOwner=${marketOffer.makerId} ` +
      `storedQty=${order.qtyLots.toString()} canonicalQty=${qtyLots.toString()} ` +
      `storedPrice=${order.priceTicks.toString()} ` +
      `canonicalPrice=${marketOffer.priceTicks.toString()}`);
  }
  return true;
};

export const prepareCrossOrderbookOffer = (
  pass: CrossOrderbookPass,
  rawOffer: CrossJurisdictionWorkingOrderbookOffer,
): PreparedCrossOffer | null => {
  const accountId = rawOffer.accountId;
  const namespacedOrderId = swapKey(accountId, rawOffer.offerId);
  const marketOffer = getCrossMarketOffer(pass, rawOffer);
  if (!marketOffer) {
    pass.rejectInvalidCrossOffer(accountId, rawOffer.offerId, 'invalid-cross-j-route');
    return null;
  }
  const qtyLots = crossBookQtyLots(marketOffer.baseTokenId, marketOffer.baseAmount);
  if (qtyLots <= 0n) {
    pass.rejectInvalidCrossOffer(
      accountId,
      rawOffer.offerId,
      `cross-dust-remainder:${marketOffer.baseAmount.toString()}`,
    );
    return null;
  }
  if (qtyLots > MAX_ORDERBOOK_QTY_LOTS) {
    pass.rejectInvalidCrossOffer(
      accountId,
      rawOffer.offerId,
      `invalid-cross-qty:${qtyLots.toString()}`,
    );
    return null;
  }
  const normalized = marketOffer.offer;
  const baseTokenDecimals = marketOffer.side === 1
    ? normalized.giveTokenDecimals
    : normalized.wantTokenDecimals;
  const quoteTokenDecimals = marketOffer.side === 1
    ? normalized.wantTokenDecimals
    : normalized.giveTokenDecimals;
  const exactQuoteLots = getSwapExactQuoteLotMultipleAtPriceForDimensions(
    baseTokenDecimals,
    quoteTokenDecimals,
    marketOffer.priceTicks,
  );
  if (qtyLots % exactQuoteLots !== 0n) {
    pass.rejectInvalidCrossOffer(
      accountId,
      rawOffer.offerId,
      `cross-quote-lot-misaligned:${qtyLots.toString()}:${exactQuoteLots.toString()}`,
    );
    return null;
  }
  pass.crossLiveOfferMeta.set(namespacedOrderId, marketOffer);
  if (
    assertPendingBookFillAckLive(pass, accountId, rawOffer.offerId) ||
    hasQueuedCrossSwapAckForEntityState(pass.hubState, accountId, rawOffer.offerId)
  ) {
    pass.suspendedOrderIds.add(namespacedOrderId);
    return null;
  }
  if (
    hasQueuedSwapResolveForEntityState(
      pass.hubState,
      pass.queuedSwapResolutions,
      accountId,
      rawOffer.offerId,
    )
  ) {
    return null;
  }
  let committedBook = pass.bookCache.get(marketOffer.pairId);
  if (!committedBook) {
    const publishedBook = pass.ext.books.get(marketOffer.pairId);
    committedBook = publishedBook
      ? forkBookState(publishedBook)
      : createEmptyPairBook(
      getSwapPairPolicyByBaseQuote(
        rawOffer.giveTokenId,
        rawOffer.wantTokenId,
      ).bookBucketWidthTicks,
    );
    pass.bookCache.set(marketOffer.pairId, committedBook);
  }
  const prepared = {
    rawOffer,
    accountId,
    namespacedOrderId,
    marketOffer,
    qtyLots,
    committedBook,
  };
  if (validateExistingCrossOrder(prepared)) {
    pass.bookCache.set(marketOffer.pairId, committedBook);
    return null;
  }
  return prepared;
};
