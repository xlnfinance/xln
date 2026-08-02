import {
  CROSS_J_MAX_FILL_RATIO,
  isCrossJurisdictionFillTerminal,
  transitionCrossJurisdictionRouteStatus,
  withCrossJurisdictionFillProgress,
} from '../../../extensions/cross-j';
import {
  recordSwapClosedLifecycle,
  recordSwapResolveLifecycle,
} from './swap-history';
import {
  cancelledOfferResult,
  syncSourcePullBinding,
  type CrossFillProgress,
} from './cross-swap-fill-ack-commit';
import type {
  CrossSwapFillAckResult,
  PreparedCrossSwapFillAck,
} from './cross-swap-fill-ack-types';

type FillOutcome = {
  sourceTotal: bigint;
  targetTotal: bigint;
  remainingSource: bigint;
  remainingTarget: bigint;
  shouldClose: boolean;
  dustClose: boolean;
  terminal: boolean;
};

const applyRouteFill = (
  prepared: PreparedCrossSwapFillAck,
  fill: CrossFillProgress,
  timestamp: number,
): FillOutcome => {
  const { tx, route, offer, account } = prepared;
  Object.assign(route, withCrossJurisdictionFillProgress(route, fill, timestamp));
  const improvement = tx.data.priceImprovementAmount ?? 0n;
  if (improvement > 0n) {
    route.priceImprovementSourceAmount =
      (route.priceImprovementSourceAmount ?? 0n) + improvement;
  }
  if (tx.data.priceTicks !== undefined) route.priceTicks = tx.data.priceTicks;
  if (tx.data.pairId) route.venueId ||= tx.data.pairId;
  const sourceTotal = BigInt(route.source.amount);
  const targetTotal = BigInt(route.target.amount);
  const remainingSource = sourceTotal - fill.cumulativeSourceAmount;
  const remainingTarget = targetTotal - fill.cumulativeTargetAmount;
  const { terminal, dustClose } = isCrossJurisdictionFillTerminal(route, {
    nextRatio: fill.nextRatio,
    cumulativeSourceAmount: fill.cumulativeSourceAmount,
    cumulativeTargetAmount: fill.cumulativeTargetAmount,
    ...(tx.data.cancelRemainder !== undefined ? { cancelRemainder: tx.data.cancelRemainder } : {}),
  });
  const shouldClose = terminal && !dustClose;
  if (terminal) {
    transitionCrossJurisdictionRouteStatus(route, 'clear_requested', timestamp);
    route.clearingPolicy =
      tx.data.cancelRemainder ||
      dustClose ||
      fill.nextRatio < CROSS_J_MAX_FILL_RATIO
        ? 'cancel_and_clear'
        : 'full_fill';
  }
  offer.crossJurisdiction = route;
  syncSourcePullBinding(account, route);
  return {
    sourceTotal,
    targetTotal,
    remainingSource,
    remainingTarget,
    shouldClose,
    dustClose,
    terminal,
  };
};

const recordCrossFillHistory = (
  prepared: PreparedCrossSwapFillAck,
  fill: CrossFillProgress,
  outcome: FillOutcome,
  height: number,
): void => {
  const { account, tx, offer } = prepared;
  recordSwapResolveLifecycle(
    account,
    tx.data.offerId,
    height,
    {
      fillRatio: fill.nextRatio,
      ...(fill.fillNumerator !== undefined
        ? { fillNumerator: fill.fillNumerator }
        : {}),
      ...(fill.fillDenominator !== undefined
        ? { fillDenominator: fill.fillDenominator }
        : {}),
      cancelRemainder: outcome.terminal,
      height,
      executionGiveAmount:
        tx.data.executionSourceAmount ?? fill.incrementalSourceAmount,
      executionWantAmount:
        tx.data.executionTargetAmount ?? fill.incrementalTargetAmount,
      ...(tx.data.comment ? { comment: tx.data.comment } : {}),
    },
    {
      giveTokenId: offer.giveTokenId,
      giveAmount: outcome.sourceTotal,
      wantTokenId: offer.wantTokenId,
      wantAmount: outcome.targetTotal,
      priceTicks: offer.priceTicks,
      createdHeight: offer.createdHeight,
    },
  );
};

const closeCrossOffer = (
  prepared: PreparedCrossSwapFillAck,
  fill: CrossFillProgress,
  outcome: FillOutcome,
): CrossSwapFillAckResult => {
  const { account, tx, events } = prepared;
  account.state.swapOffers?.delete(tx.data.offerId);
  recordSwapClosedLifecycle(account, tx.data.offerId);
  events.push(
    outcome.shouldClose
      ? `🌉 Cross-j offer ${tx.data.offerId.slice(0, 8)} closed at ` +
        `${fill.nextRatio}/${CROSS_J_MAX_FILL_RATIO}`
      : `🌉 Cross-j offer ${tx.data.offerId.slice(0, 8)} closed after dust remainder`,
  );
  return cancelledOfferResult(prepared);
};

const retainCrossOfferRemainder = (
  prepared: PreparedCrossSwapFillAck,
  fill: CrossFillProgress,
  outcome: FillOutcome,
): CrossSwapFillAckResult => {
  const { account, tx, offer, route, events } = prepared;
  offer.giveAmount = outcome.remainingSource;
  offer.wantAmount = outcome.remainingTarget;
  offer.quantizedGive = outcome.remainingSource;
  offer.quantizedWant = outcome.remainingTarget;
  // The route price is the cross-j index when the clearing side republished it;
  // otherwise the committed offer keeps the price it was admitted at.
  if (route.priceTicks !== undefined) offer.priceTicks = route.priceTicks;
  events.push(
    `🌉 Cross-j offer ${tx.data.offerId.slice(0, 8)} filled to ` +
    `${fill.nextRatio}/${CROSS_J_MAX_FILL_RATIO}, ` +
    `${outcome.remainingSource} source remaining`,
  );
  return {
    success: true,
    events,
    swapOfferCreated: {
      offerId: tx.data.offerId,
      makerIsLeft: offer.makerIsLeft,
      fromEntity: account.state.leftEntity,
      toEntity: account.state.rightEntity,
      createdHeight: offer.createdHeight,
      giveTokenId: offer.giveTokenId,
      giveAmount: offer.giveAmount,
      wantTokenId: offer.wantTokenId,
      wantAmount: offer.wantAmount,
      priceTicks: offer.priceTicks,
      ...(offer.timeInForce !== undefined
        ? { timeInForce: offer.timeInForce }
        : {}),
      crossJurisdiction: route,
    },
  };
};

export const commitCrossSwapFillProgress = (
  prepared: PreparedCrossSwapFillAck,
  fill: CrossFillProgress,
  timestamp: number,
  height: number,
): CrossSwapFillAckResult => {
  const outcome = applyRouteFill(prepared, fill, timestamp);
  recordCrossFillHistory(prepared, fill, outcome, height);
  return outcome.terminal
    ? closeCrossOffer(prepared, fill, outcome)
    : retainCrossOfferRemainder(prepared, fill, outcome);
};
