import type { AccountMachine, AccountTx } from '../../types';
import { MAX_SWAP_FILL_RATIO } from '../../swap-execution';
import { recordSwapClosedLifecycle, recordSwapResolveLifecycle } from './swap-history';

type CrossSwapFillAckTx = Extract<AccountTx, { type: 'cross_swap_fill_ack' }>;

const clampRatio = (value: unknown): number =>
  Math.max(0, Math.min(MAX_SWAP_FILL_RATIO, Math.floor(Number(value) || 0)));

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
  const previousSeq = Math.max(0, Math.floor(Number(route.fillSeq ?? 0) || 0));
  if (fillSeq !== undefined && Math.floor(Number(fillSeq)) !== previousSeq + 1) {
    return {
      success: false,
      error: `Cross-j fill sequence mismatch: expected ${previousSeq + 1}, got ${fillSeq}`,
      events,
    };
  }
  const previousRatio = Math.max(clampRatio(route.claimedRatio), clampRatio(route.cumulativeFillRatio));
  const nextRatio = clampRatio(cumulativeFillRatio);
  if (nextRatio < previousRatio) {
    return {
      success: false,
      error: `Cross-j fill ratio regression: ${nextRatio} < ${previousRatio}`,
      events,
    };
  }
  if (nextRatio === previousRatio && !cancelRemainder) {
    events.push(`🌉 Cross-j fill ack ignored: ${offerId.slice(0, 8)} already at ${previousRatio}/65535`);
    return { success: true, events };
  }

  const sourceTotal = BigInt(route.source.amount);
  const targetTotal = BigInt(route.target.amount);
  const previousSource = route.sourceClaimed ?? ((sourceTotal * BigInt(previousRatio)) / BigInt(MAX_SWAP_FILL_RATIO));
  const previousTarget = route.targetClaimed ?? ((targetTotal * BigInt(previousRatio)) / BigInt(MAX_SWAP_FILL_RATIO));
  const nextSource = (sourceTotal * BigInt(nextRatio)) / BigInt(MAX_SWAP_FILL_RATIO);
  const nextTarget = (targetTotal * BigInt(nextRatio)) / BigInt(MAX_SWAP_FILL_RATIO);
  if (cumulativeSourceAmount !== undefined && cumulativeSourceAmount !== nextSource) {
    return {
      success: false,
      error: `Cross-j cumulative source mismatch: expected ${nextSource}, got ${cumulativeSourceAmount}`,
      events,
    };
  }
  if (cumulativeTargetAmount !== undefined && cumulativeTargetAmount !== nextTarget) {
    return {
      success: false,
      error: `Cross-j cumulative target mismatch: expected ${nextTarget}, got ${cumulativeTargetAmount}`,
      events,
    };
  }
  if (nextSource < previousSource || nextTarget < previousTarget) {
    return { success: false, error: `Cross-j cumulative claim regression`, events };
  }
  const deltaSource = nextSource - previousSource;
  const deltaTarget = nextTarget - previousTarget;

  if (incrementalSourceAmount !== undefined && incrementalSourceAmount !== deltaSource) {
    return {
      success: false,
      error: `Cross-j incremental source mismatch: expected ${deltaSource}, got ${incrementalSourceAmount}`,
      events,
    };
  }
  if (incrementalTargetAmount !== undefined && incrementalTargetAmount !== deltaTarget) {
    return {
      success: false,
      error: `Cross-j incremental target mismatch: expected ${deltaTarget}, got ${incrementalTargetAmount}`,
      events,
    };
  }
  if (executionSourceAmount !== undefined && executionSourceAmount !== deltaSource) {
    return {
      success: false,
      error: `Cross-j source execution mismatch: expected ${deltaSource}, got ${executionSourceAmount}`,
      events,
    };
  }
  if (executionTargetAmount !== undefined && executionTargetAmount !== deltaTarget) {
    return {
      success: false,
      error: `Cross-j target execution mismatch: expected ${deltaTarget}, got ${executionTargetAmount}`,
      events,
    };
  }

  route.claimedRatio = nextRatio;
  route.cumulativeFillRatio = nextRatio;
  route.fillSeq = fillSeq !== undefined ? Math.floor(Number(fillSeq)) : previousSeq + 1;
  route.sourceClaimed = nextSource;
  route.targetClaimed = nextTarget;
  route.filledSourceAmount = nextSource;
  route.filledTargetAmount = nextTarget;
  if (priceTicks !== undefined) route.priceTicks = priceTicks;
  if (pairId) route.venueId ||= pairId;
  route.updatedAt = accountMachine.currentFrame?.timestamp ?? Date.now();
  route.status = nextRatio >= MAX_SWAP_FILL_RATIO ? 'clear_requested' : 'partially_filled';
  offer.crossJurisdiction = route;

  const full = nextRatio >= MAX_SWAP_FILL_RATIO || nextSource >= sourceTotal || nextTarget >= targetTotal;
  const shouldClose = full || cancelRemainder;
  if (shouldClose) {
    accountMachine.swapOffers?.delete(offerId);
    recordSwapClosedLifecycle(accountMachine, offerId);
    events.push(`🌉 Cross-j offer ${offerId.slice(0, 8)} closed at ${nextRatio}/65535`);
  } else {
    const remainingSource = sourceTotal - nextSource;
    const remainingTarget = targetTotal - nextTarget;
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
      events.push(`🌉 Cross-j offer ${offerId.slice(0, 8)} filled to ${nextRatio}/65535, ${remainingSource} source remaining`);
    }
  }

  recordSwapResolveLifecycle(accountMachine, offerId, currentHeight, {
    fillRatio: nextRatio,
    cancelRemainder: shouldClose,
    height: currentHeight,
    executionGiveAmount: deltaSource,
    executionWantAmount: deltaTarget,
    ...(comment ? { comment } : {}),
  });

  return {
    success: true,
    events,
    ...(shouldClose ? { swapOfferCancelled: { offerId, accountId: offer.makerIsLeft ? accountMachine.leftEntity : accountMachine.rightEntity } } : {}),
  };
}
