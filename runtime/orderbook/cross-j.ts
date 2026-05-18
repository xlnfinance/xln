import type { CrossJurisdictionSwapRoute, EntityState, Env } from '../types';
import type { OrderbookExtState } from './index';
import { applyCommand, getBookOrder, getOrderbookPairsForOrder, replaceOrderbookPair } from './index';
import { markStorageEntityDirty, recordOrderbookPairUpdate } from '../env-events';

const normalizeEntityRef = (value: string): string => String(value || '').toLowerCase();

export const crossJurisdictionBookOrderIdFor = (sourceEntityId: string, orderId: string): string =>
  `${normalizeEntityRef(sourceEntityId)}:${String(orderId)}`;

export const crossJurisdictionBookOrderId = (route: CrossJurisdictionSwapRoute): string =>
  crossJurisdictionBookOrderIdFor(route.source.entityId, route.orderId);

export const removeBookOrderById = (
  env: Env,
  state: EntityState,
  namespacedOrderId: string,
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
    throw new Error(
      `ORDERBOOK_DUPLICATE_BOOK_ORDER: order=${namespacedOrderId} matches=${matches.length}`,
    );
  }

  const match = matches[0];
  if (!match) return false;

  const result = applyCommand(match.book, {
    kind: 1,
    ownerId: match.ownerId,
    orderId: namespacedOrderId,
  });
  replaceOrderbookPair(ext, match.pairId, result.state);
  recordOrderbookPairUpdate(env, {
    entityId: state.entityId,
    pairId: match.pairId,
    book: result.state,
  });
  markStorageEntityDirty(env, state.entityId);
  return true;
};

export const hasBookOrderById = (
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
  env: Env,
  state: EntityState,
  route: CrossJurisdictionSwapRoute,
): boolean => removeBookOrderById(env, state, crossJurisdictionBookOrderId(route));

export const hasCrossJurisdictionBookOrder = (
  state: EntityState,
  route: CrossJurisdictionSwapRoute,
): boolean => hasBookOrderById(state, crossJurisdictionBookOrderId(route));

export const removeCrossJurisdictionBookOrderByRouteId = (
  env: Env,
  state: EntityState,
  sourceEntityId: string,
  orderId: string,
): boolean => removeBookOrderById(env, state, crossJurisdictionBookOrderIdFor(sourceEntityId, orderId));
