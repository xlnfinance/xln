import {
  deterministicEntityTimestamp,
  findAccountByCounterparty,
  getCrossJurisdictionBookAdmissionError,
  isCrossJurisdictionBookAdmissionPending,
} from '../../orderbook/cross-j-orderbook';
import {
  markWorkingOrderbookOffer,
  type NormalizedOrderbookOffer,
  type WorkingOrderbookOffer,
} from '../../orderbook/swap-execution';
import { shortOrder } from '../../infra/logger';
import type { EntityRuntimeContext } from '../runtime-context';
import type { EntityState } from '../types';
import { entityLog } from './shared';

type EntityAccountState = EntityState['accounts'] extends Map<string, infer State> ? State : never;

const hasQueuedOrderLifecycleTx = (account: EntityAccountState, offerId: string): boolean => {
  const isLifecycleTx = (tx: EntityAccountState['mempool'][number]): boolean =>
    (tx.type === 'swap_resolve' || tx.type === 'cross_swap_fill_ack' || tx.type === 'swap_cancel_request') &&
    tx.data.offerId === offerId;
  return (account.mempool ?? []).some(isLifecycleTx) || (account.pendingFrame?.accountTxs ?? []).some(isLifecycleTx);
};

const requireCommittedSwapOffer = (
  state: EntityState,
  offer: NormalizedOrderbookOffer,
): EntityAccountState => {
  const account = findAccountByCounterparty(state, offer.accountId);
  const committedOffer = account?.swapOffers?.get(offer.offerId);
  if (!account || !committedOffer) {
    throw new Error(`ORDERBOOK_ORDER_NOT_COMMITTED: account=${offer.accountId} offer=${offer.offerId}`);
  }
  if (hasQueuedOrderLifecycleTx(account, offer.offerId)) {
    throw new Error(`ORDERBOOK_ORDER_NOT_READY: account=${offer.accountId} offer=${offer.offerId}`);
  }
  const committedPriceTicks = committedOffer.priceTicks ?? offer.priceTicks;
  if (
    committedOffer.giveTokenId !== offer.giveTokenId ||
    committedOffer.wantTokenId !== offer.wantTokenId ||
    (committedOffer.quantizedGive ?? committedOffer.giveAmount) !== (offer.quantizedGive ?? offer.giveAmount) ||
    (committedOffer.quantizedWant ?? committedOffer.wantAmount) !== (offer.quantizedWant ?? offer.wantAmount) ||
    committedPriceTicks !== offer.priceTicks ||
    committedOffer.makerIsLeft !== offer.makerIsLeft ||
    Boolean(committedOffer.crossJurisdiction) !== Boolean(offer.crossJurisdiction)
  ) {
    throw new Error(`ORDERBOOK_ORDER_COMMITTED_MISMATCH: account=${offer.accountId} offer=${offer.offerId}`);
  }
  return account;
};

const assertSameJurisdictionOrderHoldCommitted = (
  account: EntityAccountState,
  offer: NormalizedOrderbookOffer,
): void => {
  const committedOffer = account.swapOffers.get(offer.offerId);
  if (!committedOffer) {
    throw new Error(`ORDERBOOK_ORDER_NOT_COMMITTED: account=${offer.accountId} offer=${offer.offerId}`);
  }
  const delta = account.deltas?.get(committedOffer.giveTokenId);
  const requiredHold = committedOffer.quantizedGive ?? committedOffer.giveAmount;
  const committedHold = committedOffer.makerIsLeft ? (delta?.leftHold ?? 0n) : (delta?.rightHold ?? 0n);
  if (requiredHold <= 0n || committedHold < requiredHold) {
    throw new Error(
      `ORDERBOOK_ORDER_HOLD_NOT_COMMITTED: account=${offer.accountId} offer=${offer.offerId} ` +
        `required=${requiredHold.toString()} committed=${committedHold.toString()}`,
    );
  }
};

/**
 * Admit only an offer whose bilateral Account commitment already exists.
 * Entity orderbook events are projections; they can never create liquidity.
 */
export const admitOrderbookOfferForMatching = (
  env: EntityRuntimeContext,
  state: EntityState,
  offer: NormalizedOrderbookOffer,
): WorkingOrderbookOffer | null => {
  if (offer.crossJurisdiction) {
    const crossStatus = offer.crossJurisdiction.status;
    if (crossStatus !== 'resting' && crossStatus !== 'partially_filled') {
      throw new Error(`CROSS_J_ORDERBOOK_ROUTE_NOT_WORKING: offer=${offer.offerId} status=${crossStatus}`);
    }
    const account = findAccountByCounterparty(state, offer.accountId);
    if ((account?.status ?? 'active') !== 'active') return null;
    if (account?.swapOffers?.has(offer.offerId)) requireCommittedSwapOffer(state, offer);
    const admissionError = getCrossJurisdictionBookAdmissionError(
      state,
      offer.crossJurisdiction,
      deterministicEntityTimestamp(state, env),
    );
    if (admissionError) {
      if (isCrossJurisdictionBookAdmissionPending(admissionError)) {
        entityLog.debug('crossj.orderbook.admission_pending', {
          offer: shortOrder(offer.offerId, 8),
          reason: admissionError,
        });
        return null;
      }
      throw new Error(admissionError);
    }
  } else {
    const account = requireCommittedSwapOffer(state, offer);
    if ((account.status ?? 'active') !== 'active') return null;
    assertSameJurisdictionOrderHoldCommitted(account, offer);
  }
  return markWorkingOrderbookOffer(offer);
};
