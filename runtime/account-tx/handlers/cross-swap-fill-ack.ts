import type { AccountMachine, AccountTx, CrossJurisdictionSwapRoute } from '../../types';
import type { SwapOfferEvent } from '../../entity-tx/handlers/account';
import { MAX_SWAP_FILL_RATIO } from '../../swap-execution';
import {
  buildCrossJurisdictionPullBinding,
  requireCrossJurisdictionFillProgress,
  transitionCrossJurisdictionRouteStatus,
  withCrossJurisdictionFillProgress,
} from '../../cross-jurisdiction';
import { recordSwapClosedLifecycle, recordSwapResolveLifecycle } from './swap-history';

type CrossSwapFillAckTx = Extract<AccountTx, { type: 'cross_swap_fill_ack' }>;
const deterministicAccountTimestamp = (accountMachine: AccountMachine): number =>
  Number(accountMachine.pendingFrame?.timestamp ?? accountMachine.currentFrame?.timestamp ?? 0);

const syncSourcePullBinding = (accountMachine: AccountMachine, route: CrossJurisdictionSwapRoute): void => {
  const sourcePullId = route?.sourcePull?.pullId;
  if (!sourcePullId) return;
  const pull = accountMachine.pulls?.get(sourcePullId);
  if (!pull) return;
  pull.crossJurisdiction = buildCrossJurisdictionPullBinding(route, 'source');
};

export async function handleCrossSwapFillAck(
  accountMachine: AccountMachine,
  accountTx: CrossSwapFillAckTx,
  byLeft: boolean,
  currentHeight: number,
): Promise<{
  success: boolean;
  events: string[];
  error?: string;
  swapOfferCreated?: SwapOfferEvent;
  swapOfferCancelled?: { offerId: string; accountId: string };
}> {
  const {
    offerId,
    fillSeq,
    cumulativeFillRatio,
    incrementalSourceAmount,
    incrementalTargetAmount,
    cumulativeSourceAmount,
    cumulativeTargetAmount,
    executionSourceAmount,
    executionTargetAmount,
    fillNumerator,
    fillDenominator,
    priceImprovementMode = 'source_savings',
    priceImprovementAmount = 0n,
    priceImprovementTokenId,
    cancelRemainder = false,
    comment,
    priceTicks,
    pairId,
  } = accountTx.data;
  const events: string[] = [];
  const offer = accountMachine.swapOffers?.get(offerId);
  if (!offer) return { success: false, error: `Offer ${offerId} not found`, events };
  if (!offer.crossJurisdiction) {
    return { success: false, error: `Offer ${offerId} is not cross-jurisdictional`, events };
  }

  const callerIsLeft = byLeft;
  if (callerIsLeft === offer.makerIsLeft) {
    return { success: false, error: `Only counterparty can ack cross-j fill`, events };
  }

  const route = offer.crossJurisdiction;
  const currentRatio = Math.max(
    0,
    Math.min(MAX_SWAP_FILL_RATIO, Math.floor(Number(route.cumulativeFillRatio ?? route.claimedRatio ?? 0) || 0)),
  );
  if (cancelRemainder && Math.max(0, Math.min(MAX_SWAP_FILL_RATIO, Math.floor(Number(cumulativeFillRatio) || 0))) === currentRatio) {
    const sourceTotal = BigInt(route.source.amount);
    const targetTotal = BigInt(route.target.amount);
    const currentSource = route.filledSourceAmount ?? route.sourceClaimed ?? ((sourceTotal * BigInt(currentRatio)) / BigInt(MAX_SWAP_FILL_RATIO));
    const currentTarget = route.filledTargetAmount ?? route.targetClaimed ?? ((targetTotal * BigInt(currentRatio)) / BigInt(MAX_SWAP_FILL_RATIO));
    if (cumulativeSourceAmount === undefined || cumulativeSourceAmount !== currentSource) {
      return { success: false, error: `Cross-j cancel source mismatch: expected ${currentSource}, got ${cumulativeSourceAmount}`, events };
    }
    if (cumulativeTargetAmount === undefined || cumulativeTargetAmount !== currentTarget) {
      return { success: false, error: `Cross-j cancel target mismatch: expected ${currentTarget}, got ${cumulativeTargetAmount}`, events };
    }
    transitionCrossJurisdictionRouteStatus(route, 'clear_requested', deterministicAccountTimestamp(accountMachine));
    route.clearingPolicy = 'cancel_and_clear';
    offer.crossJurisdiction = route;
    syncSourcePullBinding(accountMachine, route);
    accountMachine.swapOffers?.delete(offerId);
    recordSwapClosedLifecycle(accountMachine, offerId);
    recordSwapResolveLifecycle(accountMachine, offerId, currentHeight, {
      fillRatio: currentRatio,
      ...(route.fillNumerator !== undefined ? { fillNumerator: route.fillNumerator } : {}),
      ...(route.fillDenominator !== undefined ? { fillDenominator: route.fillDenominator } : {}),
      cancelRemainder: true,
      height: currentHeight,
      executionGiveAmount: 0n,
      executionWantAmount: 0n,
      ...(comment ? { comment } : {}),
    });
    events.push(`🌉 Cross-j offer ${offerId.slice(0, 8)} cancel requested at ${currentRatio}/65535`);
    return {
      success: true,
      events,
      swapOfferCancelled: { offerId, accountId: offer.makerIsLeft ? accountMachine.leftEntity : accountMachine.rightEntity },
    };
  }

  let fill;
  try {
    fill = requireCrossJurisdictionFillProgress(route, {
      fillSeq,
      cumulativeFillRatio,
      fillNumerator,
      fillDenominator,
      incrementalSourceAmount,
      incrementalTargetAmount,
      cumulativeSourceAmount,
      cumulativeTargetAmount,
    }, 'Cross-j fill ack invalid');
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error), events };
  }
  const expectedExecutionSource = priceImprovementMode === 'source_savings' && priceImprovementAmount > 0n
    ? fill.incrementalSourceAmount - priceImprovementAmount
    : fill.incrementalSourceAmount;
  const expectedExecutionTarget = priceImprovementMode === 'target_bonus' && priceImprovementAmount > 0n
    ? fill.incrementalTargetAmount + priceImprovementAmount
    : fill.incrementalTargetAmount;
  if (priceImprovementAmount < 0n) {
    return { success: false, error: `Cross-j price improvement must be non-negative`, events };
  }
  if (priceImprovementAmount > 0n && priceImprovementMode === 'none') {
    return { success: false, error: `Cross-j price improvement disabled`, events };
  }
  if (priceImprovementAmount > 0n && priceImprovementMode === 'source_savings' && priceImprovementTokenId !== route.source.tokenId) {
    return { success: false, error: `Cross-j source savings token mismatch`, events };
  }
  if (priceImprovementAmount > 0n && priceImprovementMode === 'target_bonus' && priceImprovementTokenId !== route.target.tokenId) {
    return { success: false, error: `Cross-j target bonus token mismatch`, events };
  }
  if (expectedExecutionSource <= 0n || expectedExecutionTarget <= 0n) {
    return { success: false, error: `Cross-j execution amount after improvement must be positive`, events };
  }
  if (executionSourceAmount !== undefined && executionSourceAmount !== expectedExecutionSource) {
    return { success: false, error: `Cross-j source execution mismatch: expected ${expectedExecutionSource}, got ${executionSourceAmount}`, events };
  }
  if (executionTargetAmount !== undefined && executionTargetAmount !== expectedExecutionTarget) {
    return { success: false, error: `Cross-j target execution mismatch: expected ${expectedExecutionTarget}, got ${executionTargetAmount}`, events };
  }
  const sourceTotal = BigInt(route.source.amount);
  const previousExactSourceAmount = fill.previousSourceAmount;
  if (fill.fillNumerator !== undefined && fill.fillDenominator !== undefined) {
    // Exact fill ratio is hash-ledger/order progress, not execution economics.
    // Source-savings price improvement may spend less source at execution time;
    // it must not reduce the committed ratio or a full improved fill would fail
    // validation and leave the owner-side order stuck in the book.
    const exactSourceAmount = previousExactSourceAmount + fill.incrementalSourceAmount;
    if (fill.fillNumerator * sourceTotal !== exactSourceAmount * fill.fillDenominator) {
      return {
        success: false,
        error: `Cross-j exact fill ratio mismatch: ${fill.fillNumerator}/${fill.fillDenominator} != ${exactSourceAmount}/${sourceTotal}`,
        events,
      };
    }
  }

  const nextRoute = withCrossJurisdictionFillProgress(
    route,
    fill,
    deterministicAccountTimestamp(accountMachine),
  );
  Object.assign(route, nextRoute);
  if (priceImprovementAmount > 0n) {
    if (priceImprovementMode === 'source_savings') {
      route.priceImprovementSourceAmount = (route.priceImprovementSourceAmount ?? 0n) + priceImprovementAmount;
    } else if (priceImprovementMode === 'target_bonus') {
      route.priceImprovementTargetAmount = (route.priceImprovementTargetAmount ?? 0n) + priceImprovementAmount;
    }
  }
  if (priceTicks !== undefined) route.priceTicks = priceTicks;
  if (pairId) route.venueId ||= pairId;
  offer.crossJurisdiction = route;
  syncSourcePullBinding(accountMachine, route);

  const targetTotal = BigInt(route.target.amount);
  const full = fill.nextRatio >= MAX_SWAP_FILL_RATIO ||
    fill.cumulativeSourceAmount >= sourceTotal ||
    fill.cumulativeTargetAmount >= targetTotal;
  const shouldClose = full || cancelRemainder;
  let closedByDust = false;
  let remainingOfferEvent: SwapOfferEvent | undefined;
  if (shouldClose) {
    accountMachine.swapOffers?.delete(offerId);
    recordSwapClosedLifecycle(accountMachine, offerId);
    events.push(`🌉 Cross-j offer ${offerId.slice(0, 8)} closed at ${fill.nextRatio}/65535`);
  } else {
    const remainingSource = sourceTotal - fill.cumulativeSourceAmount;
    const remainingTarget = targetTotal - fill.cumulativeTargetAmount;
    if (remainingSource <= 0n || remainingTarget <= 0n) {
      accountMachine.swapOffers?.delete(offerId);
      recordSwapClosedLifecycle(accountMachine, offerId);
      closedByDust = true;
      events.push(`🌉 Cross-j offer ${offerId.slice(0, 8)} closed after dust remainder`);
    } else {
      offer.giveAmount = remainingSource;
      offer.wantAmount = remainingTarget;
      offer.quantizedGive = remainingSource;
      offer.quantizedWant = remainingTarget;
      offer.minFillRatio = 0;
      const nextPriceTicks = route.priceTicks ?? offer.priceTicks;
      if (nextPriceTicks !== undefined) offer.priceTicks = nextPriceTicks;
      remainingOfferEvent = {
        offerId,
        makerIsLeft: offer.makerIsLeft,
        fromEntity: accountMachine.leftEntity,
        toEntity: accountMachine.rightEntity,
        createdHeight: offer.createdHeight,
        giveTokenId: offer.giveTokenId,
        giveAmount: offer.giveAmount,
        wantTokenId: offer.wantTokenId,
        wantAmount: offer.wantAmount,
        ...(offer.priceTicks !== undefined ? { priceTicks: offer.priceTicks } : {}),
        ...(offer.timeInForce !== undefined ? { timeInForce: offer.timeInForce } : {}),
        minFillRatio: offer.minFillRatio,
        crossJurisdiction: offer.crossJurisdiction,
      };
      events.push(`🌉 Cross-j offer ${offerId.slice(0, 8)} filled to ${fill.nextRatio}/65535, ${remainingSource} source remaining`);
    }
  }

  recordSwapResolveLifecycle(accountMachine, offerId, currentHeight, {
    fillRatio: fill.nextRatio,
    ...(fill.fillNumerator !== undefined ? { fillNumerator: fill.fillNumerator } : {}),
    ...(fill.fillDenominator !== undefined ? { fillDenominator: fill.fillDenominator } : {}),
    cancelRemainder: shouldClose || closedByDust,
    height: currentHeight,
    executionGiveAmount: executionSourceAmount ?? fill.incrementalSourceAmount,
    executionWantAmount: executionTargetAmount ?? fill.incrementalTargetAmount,
    ...(comment ? { comment } : {}),
  }, {
    giveTokenId: offer.giveTokenId,
    giveAmount: sourceTotal,
    wantTokenId: offer.wantTokenId,
    wantAmount: targetTotal,
    ...(offer.priceTicks !== undefined ? { priceTicks: offer.priceTicks } : {}),
    createdHeight: offer.createdHeight,
  });

  return {
    success: true,
    events,
    ...(remainingOfferEvent ? { swapOfferCreated: remainingOfferEvent } : {}),
    ...(shouldClose || closedByDust
      ? { swapOfferCancelled: { offerId, accountId: offer.makerIsLeft ? accountMachine.leftEntity : accountMachine.rightEntity } }
      : {}),
  };
}
