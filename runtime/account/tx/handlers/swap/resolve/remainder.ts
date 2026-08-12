import type { AccountState } from '../../../../../types/account';
import { MAX_SWAP_FILL_RATIO } from '../../../../../orderbook/swap-execution';
import { requantizeRemainingSwapAtPrice } from '../../../../../orderbook/types';
import { releaseHold } from '../../../hold-utils';
import type {
  AppliedSwapResolve,
  SwapResolveFailure,
} from './types';
import {
  requantizeSwapNetAuthorization,
  type SwapNetAuthorization,
} from '../../../../swap/swap-net-authorization';

export type SwapResolveRemainderResult =
  | {
      success: true;
      closeOrderInHistory: boolean;
      swapOfferCancelled?: { offerId: string; accountId: string };
    }
  | SwapResolveFailure;

const failure = (events: string[], error: string): SwapResolveFailure => ({
  success: false,
  error,
  events,
});

const releaseGiveHold = (
  resolve: AppliedSwapResolve,
  amount: bigint,
  events: string[],
): SwapResolveFailure | null => {
  if (amount <= 0n) return null;
  const error = releaseHold(
    resolve.giveDelta,
    resolve.makerHoldSide,
    amount,
    (currentHold, releaseAmount) =>
      `Hold underflow: current=${currentHold} < required=${releaseAmount}`,
  );
  return error ? failure(events, error) : null;
};

const closeSwapOffer = (
  account: AccountState,
  resolve: AppliedSwapResolve,
  events: string[],
  message: string,
): SwapResolveRemainderResult => {
  account.swapOffers.delete(resolve.offerId);
  const makerId = resolve.offer.makerIsLeft
    ? account.leftEntity
    : account.rightEntity;
  events.push(`📊 Swap offer ${resolve.offerId.slice(0, 8)}... ${message}`);
  return {
    success: true,
    closeOrderInHistory: true,
    swapOfferCancelled: { offerId: resolve.offerId, accountId: makerId },
  };
};

export const applySwapResolveRemainder = (
  account: AccountState,
  resolve: AppliedSwapResolve,
  events: string[],
): SwapResolveRemainderResult => {
  if (
    resolve.effectiveCancelRemainder ||
    resolve.canonicalFillRatio === MAX_SWAP_FILL_RATIO
  ) {
    const releaseFailure = releaseGiveHold(
      resolve,
      resolve.canonicalQuantizedGive - resolve.filledGive,
      events,
    );
    if (releaseFailure) return releaseFailure;
    return closeSwapOffer(
      account,
      resolve,
      events,
      resolve.canonicalFillRatio === MAX_SWAP_FILL_RATIO
        ? 'fully filled'
        : 'cancelled',
    );
  }

  const remainingGive = resolve.canonicalQuantizedGive - resolve.filledGive;
  const priceTicks = resolve.canonicalPriceTicks;
  const requantized = requantizeRemainingSwapAtPrice(
    resolve.offer.giveTokenId,
    resolve.offer.wantTokenId,
    remainingGive,
    priceTicks,
  );
  if (!requantized) {
    const releaseFailure = releaseGiveHold(resolve, remainingGive, events);
    if (releaseFailure) return releaseFailure;
    return closeSwapOffer(
      account,
      resolve,
      events,
      'filled remainder dropped below lot size',
    );
  }
  let authorization: SwapNetAuthorization;
  try {
    authorization = requantizeSwapNetAuthorization(
      resolve.offer,
      requantized.effectiveGive,
      requantized.effectiveWant,
    );
  } catch (error) {
    return failure(events, error instanceof Error ? error.message : String(error));
  }
  const dustFailure = releaseGiveHold(
    resolve,
    requantized.releasedGiveDust,
    events,
  );
  if (dustFailure) return dustFailure;
  resolve.offer.giveAmount = requantized.effectiveGive;
  resolve.offer.wantAmount = requantized.effectiveWant;
  resolve.offer.maxFee = authorization.maxFee;
  resolve.offer.minNetReceive = authorization.minNetReceive;
  resolve.offer.priceTicks = priceTicks;
  resolve.offer.quantizedGive = requantized.effectiveGive;
  resolve.offer.quantizedWant = requantized.effectiveWant;
  events.push(
    `📊 Swap offer ${resolve.offerId.slice(0, 8)}... partially filled, ` +
    `${resolve.offer.giveAmount} remaining`,
  );
  return { success: true, closeOrderInHistory: false };
};
