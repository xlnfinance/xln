import {
  assertCrossJurisdictionPriceImprovementMode,
  getCrossJurisdictionCommittedFillAmounts,
  getCrossJurisdictionCommittedProofRatio,
} from '../../../extensions/cross-j';
import type {
  CrossSwapFillAckAdmission,
  CrossSwapFillAckResult,
  CrossSwapFillAckTx,
  PreparedCrossSwapFillAck,
} from './cross-swap-fill-ack-types';
import type { AccountReplica } from '../../../types/account';

const reject = (
  events: string[],
  error: string,
): CrossSwapFillAckAdmission => ({
  ok: false,
  result: { success: false, error, events },
});

export const prepareCrossSwapFillAck = (
  account: AccountReplica,
  tx: CrossSwapFillAckTx,
  byLeft: boolean,
): CrossSwapFillAckAdmission => {
  const events: string[] = [];
  const priceImprovementMode = (
    tx.data as { priceImprovementMode?: unknown }
  ).priceImprovementMode;
  try {
    assertCrossJurisdictionPriceImprovementMode(
      priceImprovementMode,
      tx.data.offerId,
    );
  } catch (error) {
    return reject(events, error instanceof Error ? error.message : String(error));
  }
  const offer = account.state.swapOffers?.get(tx.data.offerId);
  if (!offer) return reject(events, `Offer ${tx.data.offerId} not found`);
  if (!offer.crossJurisdiction) {
    return reject(
      events,
      `Offer ${tx.data.offerId} is not cross-jurisdictional`,
    );
  }
  if (byLeft === offer.makerIsLeft) {
    return reject(events, 'Only counterparty can ack cross-j fill');
  }
  const route = offer.crossJurisdiction;
  if (
    tx.data.routeHash &&
    route.routeHash &&
    tx.data.routeHash.toLowerCase() !== route.routeHash.toLowerCase()
  ) {
    return reject(
      events,
      `Cross-j route hash mismatch: ${tx.data.routeHash} != ${route.routeHash}`,
    );
  }
  const committedFill = getCrossJurisdictionCommittedFillAmounts(route);
  const currentRatio = committedFill.fillRatio;
  const proofRatio = getCrossJurisdictionCommittedProofRatio({
    orderId: tx.data.offerId,
    cumulativeFillRatio: tx.data.cumulativeFillRatio,
    fillNumerator: tx.data.fillNumerator,
    fillDenominator: tx.data.fillDenominator,
  });
  const currentFillSeq = Math.max(
    0,
    Math.floor(Number(route.fillSeq ?? 0) || 0),
  );
  if (
    tx.data.previousFillSeq !== undefined &&
    Math.floor(Number(tx.data.previousFillSeq)) !== currentFillSeq &&
    !(tx.data.cancelRemainder && proofRatio === currentRatio)
  ) {
    return reject(
      events,
      `Cross-j previous fill seq mismatch: expected ${currentFillSeq}, ` +
      `got ${tx.data.previousFillSeq}`,
    );
  }
  return {
    ok: true,
    prepared: {
      account,
      tx,
      offer,
      route,
      events,
      currentRatio,
      currentFillSeq,
    },
  };
};

export const rejectCrossSwapFillAck = (
  prepared: PreparedCrossSwapFillAck,
  error: string,
): CrossSwapFillAckResult => ({
  success: false,
  error,
  events: prepared.events,
});
