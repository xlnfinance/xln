import type { EntityState } from '../../../types';
import {
  applyCommand,
  deriveSide,
  getBestAsk,
  getBestBid,
  getSwapLotScale,
  type BookState,
  type OrderbookExtState,
} from '../../../../orderbook';
import { SWAP_CONSTANTS } from '../../../../config/constants';
import type { SwapPairPolicy } from '../../../../account/utils';
import { createStructuredLogger, shortId, shortOrder } from '../../../../infra/logger';
import type {
  NormalizedOrderbookOffer,
  SameJurisdictionWorkingOrderbookOffer,
} from '../../../../orderbook/swap-execution';
import { normalizeSwapOfferForOrderbook } from '../../../../orderbook/swap-execution';
import {
  hasQueuedSwapResolveForEntityState,
  queueUniqueSwapResolveForEntityState,
  type AccountTxTarget,
} from './orderbook-queue';
import { resolveStoredOfferEntityRefs } from './orderbook-offers';
import {
  parseNamespacedOrderId,
  resolvePairBandReference,
} from './orderbook-matching-helpers';

const orderbookSameLog = createStructuredLogger('orderbook.same');

type RecordDebugProjectionReject = (
  accountId: string,
  offerId: string,
  reason: string,
) => true;
type RejectInvalidOffer = (
  accountId: string,
  offerId: string,
  reason: string,
) => void;

export type SameOrderbookProcessInput = {
  hubState: EntityState;
  ext: OrderbookExtState;
  sameAccountSwapOffers: SameJurisdictionWorkingOrderbookOffer[];
  minTradeSize: bigint;
  swapTakerFeeBps: number;
  bookCache: Map<string, BookState>;
  bookUpdates: { pairId: string; book: BookState }[];
  accountTxs: AccountTxTarget[];
  queuedSwapResolutions: Set<string>;
  debugRebuildProjectionOnly: boolean;
  recordDebugProjectionReject: RecordDebugProjectionReject;
  rejectInvalidOffer: RejectInvalidOffer;
};

export type SameOrderbookPass = SameOrderbookProcessInput & {
  orderbookOfferMeta: Map<string, NormalizedOrderbookOffer>;
  suspendedSameOrderIds: Set<string>;
  sweptPairs: Set<string>;
  pairSweepCount: number;
};

export const createSameOrderbookPass = (
  input: SameOrderbookProcessInput,
): SameOrderbookPass => ({
  ...input,
  orderbookOfferMeta: new Map(),
  suspendedSameOrderIds: new Set(),
  sweptPairs: new Set(),
  pairSweepCount: 0,
});

const buildLiveSameOfferMeta = (
  pass: SameOrderbookPass,
  namespacedOrderId: string,
): NormalizedOrderbookOffer | null => {
  const { accountId, offerId } = parseNamespacedOrderId(
    namespacedOrderId,
    'ORDERBOOK_MALFORMED_BOOK_ORDER',
  );
  const account = pass.hubState.accounts.get(accountId);
  const liveOffer = account?.state.swapOffers?.get(offerId);
  if (!account || !liveOffer || liveOffer.crossJurisdiction) return null;
  const entityRefs = resolveStoredOfferEntityRefs(account.state, liveOffer);
  return normalizeSwapOfferForOrderbook(
    {
      offerId,
      makerIsLeft: liveOffer.makerIsLeft,
      fromEntity: entityRefs.fromEntity,
      toEntity: entityRefs.toEntity,
      createdHeight: liveOffer.createdHeight,
      giveTokenId: liveOffer.giveTokenId,
      giveAmount: liveOffer.giveAmount,
      wantTokenId: liveOffer.wantTokenId,
      wantAmount: liveOffer.wantAmount,
      maxFee: liveOffer.maxFee,
      minNetReceive: liveOffer.minNetReceive,
      priceTicks: liveOffer.priceTicks,
      timeInForce: liveOffer.timeInForce,
    },
    accountId,
  );
};

export const containSamePairFailure = (
  pass: SameOrderbookPass,
  pairId: string,
  accountId: string,
  offerId: string,
  message: string,
): void => {
  orderbookSameLog.debug('pair.command_failed', {
    pair: pairId,
    offer: shortOrder(offerId, 8),
    account: shortId(accountId, 8),
    error: message,
  });
  if (pass.debugRebuildProjectionOnly) {
    pass.recordDebugProjectionReject(accountId, offerId, `pair-error:${message}`);
    return;
  }
  throw new Error(
    `ORDERBOOK_PAIR_COMMAND_FAILED: pair=${pairId} account=${accountId} ` +
    `offer=${offerId} error=${message}`,
  );
};

export const sweepSamePairOutOfBandOffers = (
  pass: SameOrderbookPass,
  pairId: string,
  pairPolicy: SwapPairPolicy,
  hasExplicitPairPolicy: boolean,
  currentBook: BookState,
): BookState => {
  const bestBid = getBestBid(currentBook);
  const bestAsk = getBestAsk(currentBook);
  const { anchor, label } = resolvePairBandReference(
    pairPolicy,
    hasExplicitPairPolicy,
    bestBid,
    bestAsk,
  );
  if (anchor === null) return currentBook;
  const minAllowed =
    anchor - (anchor * BigInt(SWAP_CONSTANTS.PRICE_REJECT_BPS)) /
    BigInt(SWAP_CONSTANTS.BPS_BASE);
  const maxAllowed =
    anchor + (anchor * BigInt(SWAP_CONSTANTS.PRICE_REJECT_BPS)) /
    BigInt(SWAP_CONSTANTS.BPS_BASE);
  let nextBook = currentBook;
  let removed = 0;
  // Iterate the pre-sweep snapshot: each cancel derives a new immutable book.
  for (const order of [...currentBook.orders.values()]) {
    if (pass.suspendedSameOrderIds.has(order.orderId)) continue;
    const liveOffer = buildLiveSameOfferMeta(pass, order.orderId);
    if (!liveOffer) {
      throw new Error(
        `ORDERBOOK_SAME_SNAPSHOT_MISSING: pair=${pairId} order=${order.orderId}`,
      );
    }
    if (order.priceTicks >= minAllowed && order.priceTicks <= maxAllowed) continue;
    removed += 1;
    orderbookSameLog.debug('sweep.out_of_band', {
      offer: shortOrder(liveOffer.offerId, 8),
      pair: pairId,
      price: order.priceTicks.toString(),
      rejectPct: SWAP_CONSTANTS.PRICE_REJECT_BPS / 100,
      bandLabel: label,
      bandAnchor: anchor.toString(),
    });
    if (pass.debugRebuildProjectionOnly) {
      pass.recordDebugProjectionReject(
        liveOffer.accountId,
        liveOffer.offerId,
        `outside-anchor-band:${order.priceTicks.toString()}`,
      );
      continue;
    }
    nextBook = applyCommand(nextBook, {
      kind: 1,
      ownerId: order.ownerId,
      orderId: order.orderId,
    }).state;
    queueUniqueSwapResolveForEntityState(
      pass.accountTxs,
      pass.hubState,
      pass.queuedSwapResolutions,
      liveOffer.accountId,
      {
        offerId: liveOffer.offerId,
        fillRatio: 0,
        cancelRemainder: true,
        comment: `outside-anchor-band:${order.priceTicks.toString()}`,
      },
    );
  }
  if (removed === 0) return currentBook;
  pass.pairSweepCount += 1;
  return nextBook;
};

export const assertSameBookMatchesAccounts = (
  pass: SameOrderbookPass,
  pairId: string,
  initialBook: BookState,
): BookState => {
  let book = initialBook;
  for (const order of [...initialBook.orders.values()]) {
    const { accountId } = parseNamespacedOrderId(
      order.orderId,
      'ORDERBOOK_MALFORMED_BOOK_ORDER',
    );
    const account = pass.hubState.accounts.get(accountId);
    if ((account?.status ?? 'active') !== 'active') {
      book = applyCommand(book, {
        kind: 1,
        ownerId: order.ownerId,
        orderId: order.orderId,
      }).state;
      pass.bookCache.set(pairId, book);
      pass.bookUpdates.push({ pairId, book });
      orderbookSameLog.debug('book.remove_disputed_account', {
        pair: pairId,
        order: shortOrder(order.orderId, 20),
        account: shortId(accountId, 8),
      });
      continue;
    }
    const meta =
      pass.orderbookOfferMeta.get(order.orderId) ??
      buildLiveSameOfferMeta(pass, order.orderId);
    if (!meta) {
      throw new Error(
        `ORDERBOOK_SAME_SNAPSHOT_MISSING: pair=${pairId} order=${order.orderId}`,
      );
    }
    if (
      hasQueuedSwapResolveForEntityState(
        pass.hubState,
        pass.queuedSwapResolutions,
        meta.accountId,
        meta.offerId,
      )
    ) {
      pass.suspendedSameOrderIds.add(order.orderId);
      continue;
    }
    pass.orderbookOfferMeta.set(order.orderId, meta);
    const side = deriveSide(meta.giveTokenId, meta.wantTokenId);
    const baseTokenId = side === 1 ? meta.giveTokenId : meta.wantTokenId;
    const baseAmount =
      side === 1 ? (meta.quantizedGive ?? meta.giveAmount) : meta.wantAmount;
    if (
      order.priceTicks !== meta.priceTicks ||
      order.ownerId !== (meta.makerIsLeft ? meta.fromEntity : meta.toEntity) ||
      order.qtyLots !== baseAmount / getSwapLotScale(baseTokenId)
    ) {
      throw new Error(
        `ORDERBOOK_CACHE_MISMATCH: pair=${pairId} order=${order.orderId} ` +
        `storedPrice=${order.priceTicks.toString()} ` +
        `canonicalPrice=${meta.priceTicks.toString()}`,
      );
    }
  }
  return book;
};
