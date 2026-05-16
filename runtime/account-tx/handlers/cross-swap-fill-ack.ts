import type { AccountMachine, AccountTx } from '../../types';
import { MAX_SWAP_FILL_RATIO } from '../../swap-execution';
import { validateCrossJurisdictionFillProgress, withCrossJurisdictionFillProgress } from '../../cross-jurisdiction';
import { recordSwapClosedLifecycle, recordSwapResolveLifecycle } from './swap-history';

type CrossSwapFillAckTx = Extract<AccountTx, { type: 'cross_swap_fill_ack' }>;

export async function handleCrossSwapFillAck(
  accountMachine: AccountMachine,
  accountTx: CrossSwapFillAckTx,
  byLeft: boolean,
  currentHeight: number,
): Promise<{ success: boolean; events: string[]; error?: string; swapOfferCancelled?: { offerId: string; accountId: string } }> {
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
    if (cumulativeSourceAmount !== undefined && cumulativeSourceAmount !== currentSource) {
      return { success: false, error: `Cross-j cancel source mismatch: expected ${currentSource}, got ${cumulativeSourceAmount}`, events };
    }
    if (cumulativeTargetAmount !== undefined && cumulativeTargetAmount !== currentTarget) {
      return { success: false, error: `Cross-j cancel target mismatch: expected ${currentTarget}, got ${cumulativeTargetAmount}`, events };
    }
    route.status = 'clear_requested';
    route.clearingPolicy = 'cancel_and_clear';
    route.updatedAt = accountMachine.currentFrame?.timestamp ?? Date.now();
    offer.crossJurisdiction = route;
    accountMachine.swapOffers?.delete(offerId);
    recordSwapClosedLifecycle(accountMachine, offerId);
    recordSwapResolveLifecycle(accountMachine, offerId, currentHeight, {
      fillRatio: currentRatio,
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

  const validatedFill = validateCrossJurisdictionFillProgress(route, {
    fillSeq,
    cumulativeFillRatio,
    incrementalSourceAmount,
    incrementalTargetAmount,
    cumulativeSourceAmount,
    cumulativeTargetAmount,
  });
  if (!validatedFill.ok) {
    return { success: false, error: `Cross-j fill ack invalid: ${validatedFill.error}`, events };
  }
  const fill = validatedFill.value;
  if (executionSourceAmount !== undefined && executionSourceAmount !== fill.incrementalSourceAmount) {
    return { success: false, error: `Cross-j source execution mismatch: expected ${fill.incrementalSourceAmount}, got ${executionSourceAmount}`, events };
  }
  if (executionTargetAmount !== undefined && executionTargetAmount !== fill.incrementalTargetAmount) {
    return { success: false, error: `Cross-j target execution mismatch: expected ${fill.incrementalTargetAmount}, got ${executionTargetAmount}`, events };
  }

  const nextRoute = withCrossJurisdictionFillProgress(
    route,
    fill,
    accountMachine.currentFrame?.timestamp ?? Date.now(),
  );
  Object.assign(route, nextRoute);
  if (priceTicks !== undefined) route.priceTicks = priceTicks;
  if (pairId) route.venueId ||= pairId;
  offer.crossJurisdiction = route;

  const sourceTotal = BigInt(route.source.amount);
  const targetTotal = BigInt(route.target.amount);
  const full = fill.nextRatio >= MAX_SWAP_FILL_RATIO || fill.cumulativeSourceAmount >= sourceTotal || fill.cumulativeTargetAmount >= targetTotal;
  const shouldClose = full || cancelRemainder;
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
      events.push(`🌉 Cross-j offer ${offerId.slice(0, 8)} closed after dust remainder`);
    } else {
      offer.giveAmount = remainingSource;
      offer.wantAmount = remainingTarget;
      offer.quantizedGive = remainingSource;
      offer.quantizedWant = remainingTarget;
      offer.minFillRatio = 0;
      const nextPriceTicks = route.priceTicks ?? offer.priceTicks;
      if (nextPriceTicks !== undefined) offer.priceTicks = nextPriceTicks;
      events.push(`🌉 Cross-j offer ${offerId.slice(0, 8)} filled to ${fill.nextRatio}/65535, ${remainingSource} source remaining`);
    }
  }

  recordSwapResolveLifecycle(accountMachine, offerId, currentHeight, {
    fillRatio: fill.nextRatio,
    cancelRemainder: shouldClose,
    height: currentHeight,
    executionGiveAmount: fill.incrementalSourceAmount,
    executionWantAmount: fill.incrementalTargetAmount,
    ...(comment ? { comment } : {}),
  });

  return {
    success: true,
    events,
    ...(shouldClose ? { swapOfferCancelled: { offerId, accountId: offer.makerIsLeft ? accountMachine.leftEntity : accountMachine.rightEntity } } : {}),
  };
}
