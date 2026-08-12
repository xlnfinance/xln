import {
  deterministicEntityTimestamp,
  findAccountByCounterparty,
  getCrossJurisdictionBookAdmissionError,
  isCrossJurisdictionBookRiskRejection,
  isCrossJurisdictionBookAdmissionPending,
} from '../../orderbook/cross-j/orderbook';
import {
  markWorkingOrderbookOffer,
  type NormalizedOrderbookOffer,
  type WorkingOrderbookOffer,
} from '../../orderbook/swap-execution';
import { shortOrder } from '../../infra/logger';
import type { EntityRuntimeContext } from '../runtime-context';
import type { EntityState } from '../types';
import { entityLog } from './entity-log';

type EntityAccountState = EntityState['accounts'] extends Map<string, infer State> ? State : never;

const hasQueuedOrderLifecycleTx = (account: EntityAccountState, offerId: string): boolean => {
  const isLifecycleTx = (tx: EntityAccountState['mempool'][number]): boolean =>
    (tx.type === 'swap_resolve' || tx.type === 'cross_swap_fill_ack' || tx.type === 'swap_cancel_request') &&
    tx.data.offerId === offerId;
  return (account.mempool ?? []).some(isLifecycleTx) || (account.pendingFrame?.accountTxs ?? []).some(isLifecycleTx);
};

/**
 * Committed offers are written by a single canonical producer that always sets
 * price and quantized amounts together, and rewrites all of them on
 * requantization. A missing or non-positive field therefore means corrupt or
 * pre-canonical Account state. Recovering it from the candidate would let the
 * Entity projection define the price it is supposed to be checked against, so
 * reject loudly instead.
 */
const requireCommittedOfferAmount = (
  value: bigint | undefined,
  field: string,
  offer: NormalizedOrderbookOffer,
): bigint => {
  if (typeof value !== 'bigint' || value <= 0n) {
    throw new Error(
      `ORDERBOOK_ORDER_COMMITTED_INCOMPLETE: account=${offer.accountId} offer=${offer.offerId} field=${field}`,
    );
  }
  return value;
};

const requireCommittedSwapOffer = (
  state: EntityState,
  offer: NormalizedOrderbookOffer,
): EntityAccountState => {
  const account = findAccountByCounterparty(state, offer.accountId);
  const committedOffer = account?.state.swapOffers?.get(offer.offerId);
  if (!account || !committedOffer) {
    throw new Error(`ORDERBOOK_ORDER_NOT_COMMITTED: account=${offer.accountId} offer=${offer.offerId}`);
  }
  if (hasQueuedOrderLifecycleTx(account, offer.offerId)) {
    throw new Error(`ORDERBOOK_ORDER_NOT_READY: account=${offer.accountId} offer=${offer.offerId}`);
  }
  const committedPriceTicks = requireCommittedOfferAmount(committedOffer.priceTicks, 'priceTicks', offer);
  const committedGive = requireCommittedOfferAmount(committedOffer.quantizedGive, 'quantizedGive', offer);
  const committedWant = requireCommittedOfferAmount(committedOffer.quantizedWant, 'quantizedWant', offer);
  // The producer keeps the quantized amounts equal to the live amounts; a split
  // between them means the offer was mutated outside the canonical transition.
  if (committedGive !== committedOffer.giveAmount || committedWant !== committedOffer.wantAmount) {
    throw new Error(
      `ORDERBOOK_ORDER_COMMITTED_QUANTIZATION_DRIFT: account=${offer.accountId} offer=${offer.offerId} ` +
        `give=${committedOffer.giveAmount.toString()}/${committedGive.toString()} ` +
        `want=${committedOffer.wantAmount.toString()}/${committedWant.toString()}`,
    );
  }
  // The book candidate carries the already-quantized amounts as its live
  // amounts. When it also restates them, both must agree before comparison.
  if (
    (offer.quantizedGive !== undefined && offer.quantizedGive !== offer.giveAmount) ||
    (offer.quantizedWant !== undefined && offer.quantizedWant !== offer.wantAmount)
  ) {
    throw new Error(
      `ORDERBOOK_ORDER_CANDIDATE_QUANTIZATION_DRIFT: account=${offer.accountId} offer=${offer.offerId}`,
    );
  }
  if (
    committedOffer.giveTokenId !== offer.giveTokenId ||
    committedOffer.wantTokenId !== offer.wantTokenId ||
    committedGive !== offer.giveAmount ||
    committedWant !== offer.wantAmount ||
    committedOffer.maxFee !== offer.maxFee ||
    committedOffer.minNetReceive !== offer.minNetReceive ||
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
  const committedOffer = account.state.swapOffers.get(offer.offerId);
  if (!committedOffer) {
    throw new Error(`ORDERBOOK_ORDER_NOT_COMMITTED: account=${offer.accountId} offer=${offer.offerId}`);
  }
  const delta = account.state.deltas?.get(committedOffer.giveTokenId);
  const requiredHold = requireCommittedOfferAmount(committedOffer.quantizedGive, 'quantizedGive', offer);
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
    if (account?.state.swapOffers?.has(offer.offerId)) requireCommittedSwapOffer(state, offer);
    const admissionError = getCrossJurisdictionBookAdmissionError(
      state,
      offer.crossJurisdiction,
      deterministicEntityTimestamp(state, env),
    );
    if (admissionError) {
      if (
        isCrossJurisdictionBookAdmissionPending(admissionError) ||
        isCrossJurisdictionBookRiskRejection(admissionError)
      ) {
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
