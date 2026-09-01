import type { CrossJurisdictionBookAdmission, CrossJurisdictionSwapRoute } from '../../types/cross-jurisdiction';
import type { EntityState } from '../../entity/types';
import type { EntityRuntimeContext } from '../../entity/runtime-context';
import type { RuntimeOverlayRecord } from '../../types/account';
import { type OrderbookExtState } from '..';
import { removeBookOrderByIdWithPair } from '.';
import {
  assertCrossJurisdictionOrderAdmissible,
  crossJurisdictionBookAdmissionKeyFor,
  crossJurisdictionBookOwnerRef,
  findCrossJurisdictionBookAdmissionKeyByRoute,
  getCrossJurisdictionBookAdmissionError,
  isCrossJurisdictionBookAdmissionPending,
  isCrossJurisdictionBookRiskRejection,
  markCrossJurisdictionBookAdmissionClosed,
} from '../../extensions/cross-j/orderbook';
import { createStructuredLogger, shortOrder } from '../../support/logger';

type CommittedSwapCancel = Readonly<{ offerId: string; accountId: string }>;

const crossJBookLog = createStructuredLogger('crossj.orderbook');

export const normalizeEntityRef = (value: string): string => String(value || '').toLowerCase();

export const deterministicEntityTimestamp = (state: EntityState, env?: EntityRuntimeContext): number =>
  Number(state.timestamp || env?.state.timestamp || 0);

export type CrossJurisdictionBookAdmissionFailure = Readonly<{
  kind: 'pending' | 'risk_reject' | 'invalid';
  message: string;
}>;

export const getTypedCrossJurisdictionBookAdmissionFailure = (
  state: EntityState,
  route: CrossJurisdictionSwapRoute,
  now: number,
): CrossJurisdictionBookAdmissionFailure | null => {
  const message = getCrossJurisdictionBookAdmissionError(state, route, now);
  if (!message) return null;
  if (isCrossJurisdictionBookAdmissionPending(message)) return { kind: 'pending', message };
  if (isCrossJurisdictionBookRiskRejection(message)) return { kind: 'risk_reject', message };
  return { kind: 'invalid', message };
};

export const applyCommittedSwapCancelsToOrderbook = (
  env: EntityRuntimeContext,
  state: EntityState,
  cancels: readonly CommittedSwapCancel[],
  storageChanges: RuntimeOverlayRecord[] = [],
): string[] => {
  if (cancels.length === 0) return [];
  const ext = state.orderbookExt as OrderbookExtState | undefined;
  if (!ext) return [];
  const touchedPairs = new Set<string>();
  crossJBookLog.debug('committed_cancel.apply', { count: cancels.length });
  for (const { accountId, offerId } of cancels) {
    const namespacedOrderId = `${accountId}:${offerId}`;
    const pairId = removeBookOrderByIdWithPair(state, namespacedOrderId, storageChanges);
    if (pairId) {
      touchedPairs.add(pairId);
      const offer = findAccountByCounterparty(state, accountId)?.state.swapOffers?.get(offerId);
      if (offer?.crossJurisdiction) {
        markCrossJurisdictionBookAdmissionClosed(
          state,
          offer.crossJurisdiction.source.entityId,
          offerId,
          deterministicEntityTimestamp(state, env),
          'committed_cancel',
        );
      }
      crossJBookLog.trace('committed_cancel.removed', { order: shortOrder(offerId) });
    }
  }
  return Array.from(touchedPairs).sort();
};

export const findAccountByCounterparty = (state: EntityState | null | undefined, counterpartyId: string) => {
  if (!state?.accounts) return null;
  const target = normalizeEntityRef(counterpartyId);
  return state.accounts.get(target) ?? null;
};

export const findCrossJurisdictionBookAdmissionForAck = (
  currentEntityState: EntityState,
  sourceEntityId: string,
  orderId: string,
  routeHash?: string,
): CrossJurisdictionBookAdmission | null => {
  const admissions = currentEntityState.crossJurisdictionBookAdmissions;
  const expectedRouteHash = String(routeHash || '').toLowerCase();
  const direct = admissions?.get(crossJurisdictionBookAdmissionKeyFor(sourceEntityId, orderId));
  if (direct) {
    if (!expectedRouteHash) return direct;
    const directRouteHash = String(
      direct.routeHash || direct.route?.routeHash || '',
    ).toLowerCase();
    return directRouteHash === expectedRouteHash ? direct : null;
  }
  if (!admissions || !expectedRouteHash) return null;
  const indexedKey = findCrossJurisdictionBookAdmissionKeyByRoute(
    currentEntityState,
    orderId,
    expectedRouteHash,
  );
  return indexedKey ? admissions.get(indexedKey) ?? null : null;
};

export {
  assertCrossJurisdictionOrderAdmissible,
  crossJurisdictionBookOwnerRef,
};
