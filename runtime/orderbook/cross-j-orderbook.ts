import type { CrossJurisdictionBookAdmission, EntityState, Env, RuntimeOverlayRecord } from '../types';
import {
  normalizeSwapOfferForOrderbook,
  type SwapCancelEvent,
} from '../entity/tx/handlers/account';
import { type OrderbookExtState } from './index';
import { removeBookOrderById } from './cross-j';
import {
  assertCrossJurisdictionOrderAdmissible,
  crossJurisdictionBookAdmissionKeyFor,
  crossJurisdictionBookOwnerRef,
  getCrossJurisdictionBookAdmissionError,
  isCrossJurisdictionBookAdmissionPending,
  markCrossJurisdictionBookAdmissionClosed,
} from '../extensions/cross-j/orderbook';
import { createStructuredLogger, shortOrder } from '../infra/logger';

export type OrderbookOfferForMatch = ReturnType<typeof normalizeSwapOfferForOrderbook>;

const crossJBookLog = createStructuredLogger('crossj.orderbook');

export const normalizeEntityRef = (value: string): string => String(value || '').toLowerCase();

export const deterministicEntityTimestamp = (state: EntityState, env?: Env): number =>
  Number(state.timestamp || env?.timestamp || 0);

export const applyCommittedSwapCancelsToOrderbook = (
  env: Env,
  state: EntityState,
  cancels: SwapCancelEvent[],
  storageChanges: RuntimeOverlayRecord[] = [],
): void => {
  if (cancels.length === 0) return;
  const ext = state.orderbookExt as OrderbookExtState | undefined;
  if (!ext) return;
  crossJBookLog.debug('committed_cancel.apply', { count: cancels.length });
  for (const { accountId, offerId } of cancels) {
    const namespacedOrderId = `${accountId}:${offerId}`;
    if (removeBookOrderById(state, namespacedOrderId, storageChanges)) {
      const offer = findAccountByCounterparty(state, accountId)?.swapOffers?.get(offerId);
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
};

export const findAccountByCounterparty = (state: EntityState | null | undefined, counterpartyId: string) => {
  if (!state?.accounts) return null;
  const target = normalizeEntityRef(counterpartyId);
  for (const [accountId, account] of state.accounts.entries()) {
    if (normalizeEntityRef(accountId) === target) return account;
  }
  return null;
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
    if (expectedRouteHash) {
      const directRouteHash = String(direct.routeHash || direct.route?.routeHash || '').toLowerCase();
      if (!directRouteHash || directRouteHash !== expectedRouteHash) return null;
    }
    return direct;
  }
  if (!admissions || admissions.size === 0) return null;
  if (!expectedRouteHash) return null;

  let match: CrossJurisdictionBookAdmission | null = null;
  for (const admission of admissions.values()) {
    if (String(admission.route?.orderId || admission.orderId || '') !== orderId) continue;
    const admissionRouteHash = String(admission.routeHash || admission.route?.routeHash || '').toLowerCase();
    if (!admissionRouteHash || admissionRouteHash !== expectedRouteHash) continue;
    if (match) {
      throw new Error(`CROSS_J_BOOK_ADMISSION_AMBIGUOUS: order=${orderId} routeHash=${routeHash}`);
    }
    match = admission;
  }
  return match;
};

export {
  assertCrossJurisdictionOrderAdmissible,
  crossJurisdictionBookOwnerRef,
  getCrossJurisdictionBookAdmissionError,
  isCrossJurisdictionBookAdmissionPending,
  markCrossJurisdictionBookAdmissionClosed,
};
