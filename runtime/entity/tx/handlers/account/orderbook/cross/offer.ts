import { haltRuntimeFailure } from "../../../../../../protocol/errors/failure-taxonomy";

import {
  applyCommand,
  commitBookOverlay,
  getSwapExactQuoteLotMultipleAtPriceForDimensions,
} from '../../../../../../orderbook';
import { createStructuredLogger, shortOrder } from '../../../../../../infra/logger';
import { resolveCrossJurisdictionExecutionPriceTicks } from '../../../../../../extensions/cross-j/orderbook';
import {
  aggregateCrossTradeFills,
  buildCrossMarketOfferFromBookOrder,
  collectTradeEvents,
  parseNamespacedOrderId,
  rejectEventsForOrder,
} from '../helpers';
import { hasQueuedCrossSwapAckForEntityState } from '../queue';
import { prepareCrossOrderbookOffer } from './admission';
import { classifyCrossBookMaker } from './book';
import { getWorkingCrossBook } from './pass';
import type {
  CrossOrderbookPass,
  PreparedCrossOffer,
} from './types';
import type { CrossJurisdictionWorkingOrderbookOffer } from '../../../../../../orderbook/swap-execution';

const orderbookCrossLog = createStructuredLogger('orderbook.cross');

// Cross-j price improvement always returns unused source to the buyer, so the
// executed price is the ask even when the resting order is a bid.
const crossExecutionPriceTicks = (
  makerPriceTicks: bigint,
  takerPriceTicks: bigint,
  takerSide: 0 | 1,
): bigint => takerSide === 1 ? takerPriceTicks : makerPriceTicks;

const crossExecutionQtyMultiple = (
  offer: PreparedCrossOffer,
  priceTicks: bigint,
): bigint => {
  const normalized = offer.marketOffer.offer;
  const baseTokenDecimals = offer.marketOffer.side === 1
    ? normalized.giveTokenDecimals
    : normalized.wantTokenDecimals;
  const quoteTokenDecimals = offer.marketOffer.side === 1
    ? normalized.wantTokenDecimals
    : normalized.giveTokenDecimals;
  return getSwapExactQuoteLotMultipleAtPriceForDimensions(
    baseTokenDecimals,
    quoteTokenDecimals,
    priceTicks,
  );
};

const applySpeculativeCrossCommand = (
  pass: CrossOrderbookPass,
  offer: PreparedCrossOffer,
): ReturnType<typeof applyCommand> | null => {
  try {
    return applyCommand(
      getWorkingCrossBook(pass, offer.marketOffer.pairId, offer.committedBook),
      {
        kind: 0,
        ownerId: offer.marketOffer.makerId,
        orderId: offer.namespacedOrderId,
        side: offer.marketOffer.side,
        tif: offer.rawOffer.timeInForce,
        postOnly: pass.debugRebuildProjectionOnly,
        priceTicks: offer.marketOffer.priceTicks,
        qtyLots: offer.qtyLots,
      },
      {
        suspendedOrderIds: pass.suspendedOrderIds,
        makerDisposition: maker => classifyCrossBookMaker(
          pass,
          offer.marketOffer.pairId,
          maker,
        ),
        executionPriceTicksForMatch: crossExecutionPriceTicks,
        executionQtyMultipleAtPrice: (priceTicks) => crossExecutionQtyMultiple(offer, priceTicks),
      },
    );
  } catch (error) {
    pass.rejectInvalidCrossOffer(
      offer.accountId,
      offer.rawOffer.offerId,
      `cross-pair-error:${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
};

const canonicalCrossTradeEvents = (
  pass: CrossOrderbookPass,
  events: ReturnType<typeof collectTradeEvents>,
): ReturnType<typeof collectTradeEvents> => events.map(event => {
  const maker =
    pass.crossLiveOfferMeta.get(event.makerOrderId) ??
    buildCrossMarketOfferFromBookOrder(pass.hubState, event.makerOrderId);
  const taker =
    pass.crossLiveOfferMeta.get(event.takerOrderId) ??
    buildCrossMarketOfferFromBookOrder(pass.hubState, event.takerOrderId);
  if (!maker || !taker) {
    throw haltRuntimeFailure("ORDERBOOK_CROSS_J_TRADE_META_MISSING", `ORDERBOOK_CROSS_J_TRADE_META_MISSING:` +
      `maker=${event.makerOrderId}:taker=${event.takerOrderId}`);
  }
  pass.crossLiveOfferMeta.set(event.makerOrderId, maker);
  pass.crossLiveOfferMeta.set(event.takerOrderId, taker);
  return {
    ...event,
    price: resolveCrossJurisdictionExecutionPriceTicks(maker, taker),
  };
});

const commitRestingCrossOffer = (
  pass: CrossOrderbookPass,
  offer: PreparedCrossOffer,
  result: ReturnType<typeof applyCommand>,
): void => {
  if (collectTradeEvents(result.events).length > 0) {
    throw haltRuntimeFailure("ORDERBOOK_CROSS_J_COMMITTED_WRITE_TRADED", `ORDERBOOK_CROSS_J_COMMITTED_WRITE_TRADED: order=${offer.namespacedOrderId}`);
  }
  // Keep the active Book overlay until the owning Entity frame certifies once.
  // Sealing here would publish a detached Book and bypass the candidate map's
  // dirty-key proof, while later same-tick offers still need this exact overlay.
  pass.bookCache.set(offer.marketOffer.pairId, result.state);
  pass.workingBookCache.set(offer.marketOffer.pairId, result.state);
  pass.bookUpdates.push({ pairId: offer.marketOffer.pairId, book: result.state });
};

const aggregateCrossTrades = (
  pass: CrossOrderbookPass,
  trades: ReturnType<typeof collectTradeEvents>,
): void => {
  for (const event of trades) {
    orderbookCrossLog.debug('trade', {
      maker: shortOrder(event.makerOrderId, 20),
      taker: shortOrder(event.takerOrderId, 20),
      qty: event.qty,
      price: event.price.toString(),
    });
    // Each matched route now has an Account/hash-ledger ACK in flight.
    pass.suspendedOrderIds.add(event.makerOrderId);
    pass.suspendedOrderIds.add(event.takerOrderId);
  }
  for (const [orderId, fill] of aggregateCrossTradeFills(trades)) {
    const meta =
      pass.crossLiveOfferMeta.get(orderId) ??
      buildCrossMarketOfferFromBookOrder(pass.hubState, orderId);
    if (!meta) {
      throw haltRuntimeFailure("ORDERBOOK_CROSS_J_FILL_META_MISSING", `ORDERBOOK_CROSS_J_FILL_META_MISSING: order=${orderId}`);
    }
    const { accountId, offerId } = parseNamespacedOrderId(
      orderId,
      'ORDERBOOK_CROSS_J_MALFORMED_FILL_ORDER',
    );
    if (
      hasQueuedCrossSwapAckForEntityState(
        pass.hubState,
        accountId,
        offerId,
      )
    ) {
      continue;
    }
    const current = pass.aggregatedFills.get(orderId);
    if (current) {
      current.filledLots += fill.filledLots;
      current.weightedCost += fill.weightedCost;
    } else {
      pass.aggregatedFills.set(orderId, {
        filledLots: fill.filledLots,
        weightedCost: fill.weightedCost,
      });
    }
  }
};

export const processCrossOrderbookOffer = (
  pass: CrossOrderbookPass,
  rawOffer: CrossJurisdictionWorkingOrderbookOffer,
): void => {
  const offer = prepareCrossOrderbookOffer(pass, rawOffer);
  if (!offer) return;
  const result = applySpeculativeCrossCommand(pass, offer);
  if (!result) return;
  const rejects = rejectEventsForOrder(result.events, offer.namespacedOrderId);
  const trades = canonicalCrossTradeEvents(pass, collectTradeEvents(result.events));
  if (rejects.length > 0 && trades.length === 0) {
    pass.rejectInvalidCrossOffer(
      offer.accountId,
      rawOffer.offerId,
      `cross-post-only-reject:${rejects.map(event => event.reason).join(',')}`,
    );
    return;
  }
  if (pass.debugRebuildProjectionOnly) {
    if (trades.length > 0) {
      pass.recordDebugProjectionReject(
        offer.accountId,
        rawOffer.offerId,
        `debug-rebuild-cross-trade:${trades.length}`,
      );
    }
    return;
  }
  const working = commitBookOverlay(result.state);
  pass.workingBookCache.set(offer.marketOffer.pairId, working);
  if (
    trades.length === 0 &&
    !pass.speculativeTradePairs.has(offer.marketOffer.pairId)
  ) {
    commitRestingCrossOffer(pass, offer, { ...result, state: working });
  }
  if (trades.length > 0) {
    pass.speculativeTradePairs.add(offer.marketOffer.pairId);
  }
  aggregateCrossTrades(pass, trades);
};
