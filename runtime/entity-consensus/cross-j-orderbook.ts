import type { EntityState, Env } from '../types';
import {
  normalizeSwapOfferForOrderbook,
  type SwapCancelEvent,
} from '../entity-tx/handlers/account';
import { type OrderbookExtState } from '../orderbook';
import { removeBookOrderById } from '../orderbook/cross-j';
import {
  assertCrossJurisdictionOrderAdmissible,
  crossJurisdictionBookOwnerRef,
  getCrossJurisdictionBookAdmissionError,
  isCrossJurisdictionBookAdmissionPending,
  markCrossJurisdictionBookAdmissionClosed,
} from '../cross-jurisdiction-orderbook';
import { createStructuredLogger, shortOrder } from '../logger';

export type OrderbookOfferForMatch = ReturnType<typeof normalizeSwapOfferForOrderbook>;

const crossJBookLog = createStructuredLogger('crossj.orderbook');

export const normalizeEntityRef = (value: string): string => String(value || '').toLowerCase();

export const deterministicEntityTimestamp = (state: EntityState, env?: Env): number =>
  Number(state.timestamp || env?.timestamp || 0);

export const applyCommittedSwapCancelsToOrderbook = (
  env: Env,
  state: EntityState,
  cancels: SwapCancelEvent[],
): void => {
  if (cancels.length === 0) return;
  const ext = state.orderbookExt as OrderbookExtState | undefined;
  if (!ext) return;
  crossJBookLog.debug('committed_cancel.apply', { count: cancels.length });
  for (const { accountId, offerId } of cancels) {
    const namespacedOrderId = `${accountId}:${offerId}`;
    if (removeBookOrderById(env, state, namespacedOrderId)) {
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

export const findEntityStateById = (env: Env, entityId: string): EntityState | null => {
  const target = normalizeEntityRef(entityId);
  for (const replica of env.eReplicas?.values?.() || []) {
    const candidate = normalizeEntityRef(replica?.state?.entityId || replica?.entityId || '');
    if (candidate === target) return replica.state;
  }
  return null;
};

export const findAccountByCounterparty = (state: EntityState | null | undefined, counterpartyId: string) => {
  if (!state?.accounts) return null;
  const target = normalizeEntityRef(counterpartyId);
  for (const [accountId, account] of state.accounts.entries()) {
    if (normalizeEntityRef(accountId) === target) return account;
  }
  return null;
};

export const findSwapOfferOwnerState = (
  env: Env,
  currentEntityState: EntityState,
  accountId: string,
  offerId: string,
): EntityState | null => {
  const account = findAccountByCounterparty(currentEntityState, accountId);
  if (account?.swapOffers?.has(offerId)) return currentEntityState;
  const currentId = normalizeEntityRef(currentEntityState.entityId);
  for (const replica of env.eReplicas?.values?.() || []) {
    const state = replica?.state;
    if (!state || normalizeEntityRef(state.entityId) === currentId) continue;
    const remoteAccount = findAccountByCounterparty(state, accountId);
    if (remoteAccount?.swapOffers?.has(offerId)) return state;
  }
  return null;
};

export {
  assertCrossJurisdictionOrderAdmissible,
  crossJurisdictionBookOwnerRef,
  getCrossJurisdictionBookAdmissionError,
  isCrossJurisdictionBookAdmissionPending,
  markCrossJurisdictionBookAdmissionClosed,
};
