import { haltRuntimeFailure } from "../../protocol/errors/failure-taxonomy";

import type { CrossJurisdictionSwapRoute } from '../../types/cross-jurisdiction';
import type { EntityState } from '../../entity/types';
import type { RuntimeOverlayRecord } from '../../types/account';
import type { OrderbookExtState } from '..';
import {
  applyCommand,
  getBookOrder,
  getOrderbookPairsForOrder,
  materializeCommittedRemainder,
  MAX_ORDERBOOK_QTY_LOTS,
  reduceBookOrderQuantity,
  replaceOrderbookPair,
  type Side,
} from '..';

const normalizeEntityRef = (value: string): string => String(value || '').toLowerCase();

const crossJurisdictionBookOrderIdFor = (sourceEntityId: string, orderId: string): string =>
  `${normalizeEntityRef(sourceEntityId)}:${String(orderId)}`;

const crossJurisdictionBookOrderId = (route: CrossJurisdictionSwapRoute): string =>
  crossJurisdictionBookOrderIdFor(route.source.entityId, route.orderId);

export const removeBookOrderById = (
  state: EntityState,
  namespacedOrderId: string,
  storageChanges: RuntimeOverlayRecord[],
): boolean => {
  const ext = state.orderbookExt as OrderbookExtState | undefined;
  if (!ext) return false;

  const matches = getOrderbookPairsForOrder(ext, namespacedOrderId)
    .flatMap((pairId) => {
      const book = ext.books.get(pairId);
      if (!book) return [];
      const order = getBookOrder(book, namespacedOrderId);
      return order ? [{ pairId, book, ownerId: order.ownerId }] : [];
    });

  if (matches.length > 1) {
    throw haltRuntimeFailure("ORDERBOOK_DUPLICATE_BOOK_ORDER", `ORDERBOOK_DUPLICATE_BOOK_ORDER: order=${namespacedOrderId} matches=${matches.length}`);
  }

  const match = matches[0];
  if (!match) return false;

  const result = applyCommand(match.book, {
    kind: 1,
    ownerId: match.ownerId,
    orderId: namespacedOrderId,
  });
  replaceOrderbookPair(ext, match.pairId, result.state);
  storageChanges.push({ family: 'book', entityId: state.entityId, pairId: match.pairId });
  return true;
};

const hasBookOrderById = (
  state: EntityState,
  namespacedOrderId: string,
): boolean => {
  const ext = state.orderbookExt as OrderbookExtState | undefined;
  if (!ext) return false;
  return getOrderbookPairsForOrder(ext, namespacedOrderId)
    .some((pairId) => {
      const book = ext.books.get(pairId);
      return Boolean(book && getBookOrder(book, namespacedOrderId));
    });
};

export const removeCrossJurisdictionBookOrder = (
  state: EntityState,
  route: CrossJurisdictionSwapRoute,
  storageChanges: RuntimeOverlayRecord[],
): boolean => removeBookOrderById(state, crossJurisdictionBookOrderId(route), storageChanges);

export const hasCrossJurisdictionBookOrder = (
  state: EntityState,
  route: CrossJurisdictionSwapRoute,
): boolean => hasBookOrderById(state, crossJurisdictionBookOrderId(route));

export const removeCrossJurisdictionBookOrderByRouteId = (
  state: EntityState,
  sourceEntityId: string,
  orderId: string,
  storageChanges: RuntimeOverlayRecord[],
): boolean => removeBookOrderById(
  state,
  crossJurisdictionBookOrderIdFor(sourceEntityId, orderId),
  storageChanges,
);

const resizeBookOrderById = (
  state: EntityState,
  namespacedOrderId: string,
  nextQtyLots: bigint,
  storageChanges: RuntimeOverlayRecord[],
): boolean => {
  if (nextQtyLots <= 0n || nextQtyLots > MAX_ORDERBOOK_QTY_LOTS) {
    throw haltRuntimeFailure("ORDERBOOK_RESIZE_INVALID", `ORDERBOOK_RESIZE_INVALID: order=${namespacedOrderId} qty=${nextQtyLots.toString()}`);
  }
  const ext = state.orderbookExt as OrderbookExtState | undefined;
  if (!ext) return false;

  const matches = getOrderbookPairsForOrder(ext, namespacedOrderId)
    .flatMap((pairId) => {
      const book = ext.books.get(pairId);
      if (!book) return [];
      const order = getBookOrder(book, namespacedOrderId);
      return order ? [{ pairId, book, order }] : [];
    });
  if (matches.length > 1) {
    throw haltRuntimeFailure("ORDERBOOK_DUPLICATE_BOOK_ORDER", `ORDERBOOK_DUPLICATE_BOOK_ORDER: order=${namespacedOrderId} matches=${matches.length}`);
  }
  const match = matches[0];
  if (!match) return false;

  // This is not matcher repair. Cross-j book quantity changes only when the
  // book owner applies an explicit committed account-ACK progress event.
  const working = reduceBookOrderQuantity(match.book, namespacedOrderId, nextQtyLots);
  replaceOrderbookPair(ext, match.pairId, working);
  storageChanges.push({ family: 'book', entityId: state.entityId, pairId: match.pairId });
  return true;
};

export const resizeCrossJurisdictionBookOrderByRouteId = (
  state: EntityState,
  sourceEntityId: string,
  orderId: string,
  nextQtyLots: bigint,
  storageChanges: RuntimeOverlayRecord[],
): boolean => resizeBookOrderById(
  state,
  crossJurisdictionBookOrderIdFor(sourceEntityId, orderId),
  nextQtyLots,
  storageChanges,
);

export const materializeCrossJurisdictionBookRemainder = (
  state: EntityState,
  input: {
    pairId: string;
    sourceEntityId: string;
    orderId: string;
    ownerId: string;
    side: Side;
    priceTicks: bigint;
    qtyLots: bigint;
  },
  storageChanges: RuntimeOverlayRecord[],
): boolean => {
  const ext = state.orderbookExt as OrderbookExtState | undefined;
  if (!ext) return false;
  const namespacedOrderId = crossJurisdictionBookOrderIdFor(input.sourceEntityId, input.orderId);
  const existingPairs = getOrderbookPairsForOrder(ext, namespacedOrderId);
  if (existingPairs.length > 0) {
    throw haltRuntimeFailure("ORDERBOOK_REMAINDER_ALREADY_PRESENT", `ORDERBOOK_REMAINDER_ALREADY_PRESENT: order=${namespacedOrderId}`);
  }
  const book = ext.books.get(input.pairId);
  if (!book) return false;
  const nextBook = materializeCommittedRemainder(book, {
    orderId: namespacedOrderId,
    ownerId: input.ownerId,
    side: input.side,
    priceTicks: input.priceTicks,
    qtyLots: input.qtyLots,
  });
  replaceOrderbookPair(ext, input.pairId, nextBook);
  storageChanges.push({ family: 'book', entityId: state.entityId, pairId: input.pairId });
  return true;
};
