import type { CrossJurisdictionSwapStatus } from '../../../types/cross-jurisdiction';
import { RuntimeAdapterError } from '../errors';
import type { RuntimeAdapterReadQuery } from '../types';
import { envHeight, findReplica, readAtHeight, type RuntimeAdapterResolveContext } from './context';

/** Current local order status, not proof that both remote Accounts have settled. */
export type RuntimeAdapterCrossOrder = Readonly<{
  runtimeId: string | null;
  runtimeHeight: number;
  entityId: string;
  entityHeight: number;
  orderId: string;
  status: CrossJurisdictionSwapStatus;
  updatedAt: number;
}>;

export const readCommittedCrossOrder = (
  ctx: RuntimeAdapterResolveContext,
  entityId: string,
  encodedOrderId: string,
  query?: RuntimeAdapterReadQuery,
): RuntimeAdapterCrossOrder => {
  if (readAtHeight(query) !== null)
    throw new RuntimeAdapterError('E_BAD_QUERY', 'cross-order reads describe current committed state');
  let orderId: string;
  try {
    orderId = decodeURIComponent(encodedOrderId);
  } catch {
    throw new RuntimeAdapterError('E_BAD_PATH', 'cross-order id has invalid encoding');
  }
  if (!orderId || orderId.length > 256)
    throw new RuntimeAdapterError('E_BAD_PATH', 'cross-order id must contain 1 to 256 characters');
  const state = findReplica(ctx.env, entityId)?.state;
  const route = state?.crossJurisdictionSwaps?.get(orderId);
  if (!state || !route) throw new RuntimeAdapterError('E_NOT_FOUND', 'cross order not found for this Entity');
  // Explicit public fields only: raw routes carry registry secrets. A close
  // proof can precede Account commit, so neither proof nor fill upgrades status.
  return {
    runtimeId: ctx.env.runtimeId ?? null,
    runtimeHeight: envHeight(ctx.env),
    entityId: state.entityId,
    entityHeight: state.height,
    orderId: route.orderId,
    status: route.status,
    updatedAt: route.updatedAt,
  };
};
