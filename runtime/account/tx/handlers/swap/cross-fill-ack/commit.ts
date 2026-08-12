import type { AccountReplica } from '../../../../../types/account';
import type { CrossJurisdictionSwapRoute } from '../../../../../types/cross-jurisdiction';
import {
  CROSS_J_MAX_FILL_RATIO,
  buildCommittedCrossJurisdictionPullBinding,
  getCrossJurisdictionCommittedFillAmounts,
  getCrossJurisdictionCommittedProofRatio,
  requireCrossJurisdictionFillProgress,
  transitionCrossJurisdictionRouteStatus,
} from '../../../../../extensions/cross-j';
import {
  recordSwapClosedLifecycle,
  recordSwapResolveLifecycle,
} from '../lifecycle/history';
import { rejectCrossSwapFillAck } from './admission';
import type {
  CrossSwapFillAckResult,
  PreparedCrossSwapFillAck,
} from './types';

export type CrossFillProgress = ReturnType<
  typeof requireCrossJurisdictionFillProgress
>;

export const syncSourcePullBinding = (
  account: AccountReplica,
  route: CrossJurisdictionSwapRoute,
): void => {
  const pullId = route.sourcePull?.pullId;
  if (!pullId) return;
  const pull = account.state.pulls?.get(pullId);
  if (pull) {
    pull.crossJurisdiction =
      buildCommittedCrossJurisdictionPullBinding(route, 'source');
  }
};

export const cancelledOfferResult = (
  prepared: PreparedCrossSwapFillAck,
): CrossSwapFillAckResult => ({
  success: true,
  events: prepared.events,
  swapOfferCancelled: {
    offerId: prepared.tx.data.offerId,
    accountId: prepared.offer.makerIsLeft
      ? prepared.account.state.leftEntity
      : prepared.account.state.rightEntity,
  },
});

export const applyUnfilledCrossSwapCancellation = (
  prepared: PreparedCrossSwapFillAck,
  timestamp: number,
  height: number,
): CrossSwapFillAckResult | null => {
  const { tx, route, account, offer, currentRatio, events } = prepared;
  const proofRatio = getCrossJurisdictionCommittedProofRatio({
    orderId: tx.data.offerId,
    cumulativeFillRatio: tx.data.cumulativeFillRatio,
    fillNumerator: tx.data.fillNumerator,
    fillDenominator: tx.data.fillDenominator,
  });
  if (!tx.data.cancelRemainder || proofRatio !== currentRatio) return null;
  const committed = getCrossJurisdictionCommittedFillAmounts(route);
  if (
    tx.data.cumulativeSourceAmount === undefined ||
    tx.data.cumulativeSourceAmount !== committed.filledSourceAmount
  ) {
    return rejectCrossSwapFillAck(
      prepared,
      `Cross-j cancel source mismatch: expected ${committed.filledSourceAmount}, ` +
      `got ${tx.data.cumulativeSourceAmount}`,
    );
  }
  if (
    tx.data.cumulativeTargetAmount === undefined ||
    tx.data.cumulativeTargetAmount !== committed.filledTargetAmount
  ) {
    return rejectCrossSwapFillAck(
      prepared,
      `Cross-j cancel target mismatch: expected ${committed.filledTargetAmount}, ` +
      `got ${tx.data.cumulativeTargetAmount}`,
    );
  }
  transitionCrossJurisdictionRouteStatus(route, 'clear_requested', timestamp);
  route.clearingPolicy = 'cancel_and_clear';
  offer.crossJurisdiction = route;
  syncSourcePullBinding(account, route);
  recordSwapResolveLifecycle(account, tx.data.offerId, height, {
    fillRatio: currentRatio,
    ...(route.fillNumerator !== undefined
      ? { fillNumerator: route.fillNumerator }
      : {}),
    ...(route.fillDenominator !== undefined
      ? { fillDenominator: route.fillDenominator }
      : {}),
    cancelRemainder: true,
    height,
    executionGiveAmount: 0n,
    executionWantAmount: 0n,
    ...(tx.data.comment ? { comment: tx.data.comment } : {}),
  });
  account.state.swapOffers?.delete(tx.data.offerId);
  recordSwapClosedLifecycle(account, tx.data.offerId);
  events.push(
    `🌉 Cross-j offer ${tx.data.offerId.slice(0, 8)} cancel requested at ` +
    `${currentRatio}/${CROSS_J_MAX_FILL_RATIO}`,
  );
  return cancelledOfferResult(prepared);
};

export const validateCrossSwapFillProgress = (
  prepared: PreparedCrossSwapFillAck,
): { ok: true; fill: CrossFillProgress } | {
  ok: false;
  result: CrossSwapFillAckResult;
} => {
  const { tx, route } = prepared;
  let fill: CrossFillProgress;
  try {
    fill = requireCrossJurisdictionFillProgress(
      route,
      {
        fillSeq: tx.data.fillSeq,
        cumulativeFillRatio: tx.data.cumulativeFillRatio,
        fillNumerator: tx.data.fillNumerator,
        fillDenominator: tx.data.fillDenominator,
        incrementalSourceAmount: tx.data.incrementalSourceAmount,
        incrementalTargetAmount: tx.data.incrementalTargetAmount,
        cumulativeSourceAmount: tx.data.cumulativeSourceAmount,
        cumulativeTargetAmount: tx.data.cumulativeTargetAmount,
      },
      'Cross-j fill ack invalid',
    );
  } catch (error) {
    return {
      ok: false,
      result: rejectCrossSwapFillAck(
        prepared,
        error instanceof Error ? error.message : String(error),
      ),
    };
  }
  const improvement = tx.data.priceImprovementAmount ?? 0n;
  const executionSource =
    improvement > 0n ? fill.incrementalSourceAmount - improvement :
      fill.incrementalSourceAmount;
  const executionTarget = fill.incrementalTargetAmount;
  const reject = (error: string) => ({
    ok: false as const,
    result: rejectCrossSwapFillAck(prepared, error),
  });
  if (improvement < 0n) {
    return reject('Cross-j price improvement must be non-negative');
  }
  if (
    improvement > 0n &&
    tx.data.priceImprovementTokenId !== route.source.tokenId
  ) {
    return reject('Cross-j source savings token mismatch');
  }
  if (executionSource <= 0n || executionTarget <= 0n) {
    return reject('Cross-j execution amount after improvement must be positive');
  }
  if (
    tx.data.executionSourceAmount !== undefined &&
    tx.data.executionSourceAmount !== executionSource
  ) {
    return reject(
      `Cross-j source execution mismatch: expected ${executionSource}, ` +
      `got ${tx.data.executionSourceAmount}`,
    );
  }
  if (
    tx.data.executionTargetAmount !== undefined &&
    tx.data.executionTargetAmount !== executionTarget
  ) {
    return reject(
      `Cross-j target execution mismatch: expected ${executionTarget}, ` +
      `got ${tx.data.executionTargetAmount}`,
    );
  }
  return { ok: true, fill };
};
