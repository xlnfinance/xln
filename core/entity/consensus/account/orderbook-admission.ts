import { haltRuntimeFailure } from "../../../protocol/errors/failure-taxonomy";

import {
  deterministicEntityTimestamp,
  findAccountByCounterparty,
  getTypedCrossJurisdictionBookAdmissionFailure,
} from '../../../orderbook/cross-j/orderbook';
import {
  markWorkingOrderbookOffer,
  type NormalizedOrderbookOffer,
  type WorkingOrderbookOffer,
} from '../../../orderbook/swap-execution';
import { shortOrder } from '../../../support/logger';
import type { EntityRuntimeContext } from '../../runtime-context';
import type { EntityState } from '../../types';
import { entityLog } from '../entity-log';

type EntityAccountState = EntityState['accounts'] extends ReadonlyMap<string, infer State> ? State : never;

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
    throw haltRuntimeFailure("ORDERBOOK_ORDER_COMMITTED_INCOMPLETE", `ORDERBOOK_ORDER_COMMITTED_INCOMPLETE: account=${offer.accountId} offer=${offer.offerId} field=${field}`);
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
    throw haltRuntimeFailure("ORDERBOOK_ORDER_NOT_COMMITTED", `ORDERBOOK_ORDER_NOT_COMMITTED: account=${offer.accountId} offer=${offer.offerId}`);
  }
  if (hasQueuedOrderLifecycleTx(account, offer.offerId)) {
    throw haltRuntimeFailure("ORDERBOOK_ORDER_NOT_READY", `ORDERBOOK_ORDER_NOT_READY: account=${offer.accountId} offer=${offer.offerId}`);
  }
  const committedPriceTicks = requireCommittedOfferAmount(committedOffer.priceTicks, 'priceTicks', offer);
  const committedGive = requireCommittedOfferAmount(committedOffer.quantizedGive, 'quantizedGive', offer);
  const committedWant = requireCommittedOfferAmount(committedOffer.quantizedWant, 'quantizedWant', offer);
  // The producer keeps the quantized amounts equal to the live amounts; a split
  // between them means the offer was mutated outside the canonical transition.
  if (committedGive !== committedOffer.giveAmount || committedWant !== committedOffer.wantAmount) {
    throw haltRuntimeFailure("ORDERBOOK_ORDER_COMMITTED_QUANTIZATION_DRIFT", `ORDERBOOK_ORDER_COMMITTED_QUANTIZATION_DRIFT: account=${offer.accountId} offer=${offer.offerId} ` +
        `give=${committedOffer.giveAmount.toString()}/${committedGive.toString()} ` +
        `want=${committedOffer.wantAmount.toString()}/${committedWant.toString()}`);
  }
  // The book candidate carries the already-quantized amounts as its live
  // amounts. When it also restates them, both must agree before comparison.
  if (
    (offer.quantizedGive !== undefined && offer.quantizedGive !== offer.giveAmount) ||
    (offer.quantizedWant !== undefined && offer.quantizedWant !== offer.wantAmount)
  ) {
    throw haltRuntimeFailure("ORDERBOOK_ORDER_CANDIDATE_QUANTIZATION_DRIFT", `ORDERBOOK_ORDER_CANDIDATE_QUANTIZATION_DRIFT: account=${offer.accountId} offer=${offer.offerId}`);
  }
  if (
    committedOffer.giveTokenId !== offer.giveTokenId ||
    committedOffer.giveTokenDecimals !== offer.giveTokenDecimals ||
    committedOffer.wantTokenId !== offer.wantTokenId ||
    committedOffer.wantTokenDecimals !== offer.wantTokenDecimals ||
    committedGive !== offer.giveAmount ||
    committedWant !== offer.wantAmount ||
    committedOffer.maxFee !== offer.maxFee ||
    committedOffer.minNetReceive !== offer.minNetReceive ||
    committedPriceTicks !== offer.priceTicks ||
    committedOffer.makerIsLeft !== offer.makerIsLeft ||
    Boolean(committedOffer.crossJurisdiction) !== Boolean(offer.crossJurisdiction)
  ) {
    throw haltRuntimeFailure("ORDERBOOK_ORDER_COMMITTED_MISMATCH", `ORDERBOOK_ORDER_COMMITTED_MISMATCH: account=${offer.accountId} offer=${offer.offerId}`);
  }
  return account;
};

const assertSameJurisdictionOrderHoldCommitted = (
  account: EntityAccountState,
  offer: NormalizedOrderbookOffer,
): void => {
  const committedOffer = account.state.swapOffers.get(offer.offerId);
  if (!committedOffer) {
    throw haltRuntimeFailure("ORDERBOOK_ORDER_NOT_COMMITTED", `ORDERBOOK_ORDER_NOT_COMMITTED: account=${offer.accountId} offer=${offer.offerId}`);
  }
  const delta = account.state.deltas?.get(committedOffer.giveTokenId);
  const requiredHold = requireCommittedOfferAmount(committedOffer.quantizedGive, 'quantizedGive', offer);
  const committedHold = committedOffer.makerIsLeft ? (delta?.leftHold ?? 0n) : (delta?.rightHold ?? 0n);
  if (requiredHold <= 0n || committedHold < requiredHold) {
    throw haltRuntimeFailure("ORDERBOOK_ORDER_HOLD_NOT_COMMITTED", `ORDERBOOK_ORDER_HOLD_NOT_COMMITTED: account=${offer.accountId} offer=${offer.offerId} ` +
        `required=${requiredHold.toString()} committed=${committedHold.toString()}`);
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
      throw haltRuntimeFailure("CROSS_J_ORDERBOOK_ROUTE_NOT_WORKING", `CROSS_J_ORDERBOOK_ROUTE_NOT_WORKING: offer=${offer.offerId} status=${crossStatus}`);
    }
    const account = findAccountByCounterparty(state, offer.accountId);
    if ((account?.status ?? 'active') !== 'active') return null;
    if (account?.state.swapOffers?.has(offer.offerId)) requireCommittedSwapOffer(state, offer);
    const admissionFailure = getTypedCrossJurisdictionBookAdmissionFailure(
      state,
      offer.crossJurisdiction,
      deterministicEntityTimestamp(state, env),
    );
    if (admissionFailure) {
      if (admissionFailure.kind === 'pending' || admissionFailure.kind === 'risk_reject') {
        entityLog.debug('crossj.orderbook.admission_pending', {
          offer: shortOrder(offer.offerId, 8),
          reason: admissionFailure.message,
        });
        return null;
      }
      throw new Error(admissionFailure.message);
    }
  } else {
    const outputVerified = offer.accountOutputVerified === true;
    const account = outputVerified
      ? findAccountByCounterparty(state, offer.accountId)
      : requireCommittedSwapOffer(state, offer);
    if (!account) {
      throw haltRuntimeFailure("ORDERBOOK_ACCOUNT_OUTPUT_ACCOUNT_MISSING", `ORDERBOOK_ACCOUNT_OUTPUT_ACCOUNT_MISSING: account=${offer.accountId} offer=${offer.offerId}`);
    }
    if ((account.status ?? 'active') !== 'active') return null;
    // A Rust authority visit returns typed child-machine outputs before the
    // final Account materialization. The output is the commitment evidence:
    // the transition emits it only after placing the exact give hold and the
    // resting row in the candidate that the signed frame commits. Re-reading
    // either financial state or envelope fields from the intentionally stale
    // TS Account mirror here would reject a valid child output and reintroduce
    // a third Account synchronization visit. Rust remains the sole judge of
    // its resident pending frame and mempool when the outbound batch runs.
    if (!outputVerified) assertSameJurisdictionOrderHoldCommitted(account, offer);
  }
  return markWorkingOrderbookOffer(offer);
};
