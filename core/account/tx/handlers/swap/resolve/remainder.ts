import type { AccountDraftState } from '../../../../state/account-state-draft';
import { MAX_SWAP_FILL_RATIO } from '../../../../../orderbook/swap-execution';
import {
  deriveSide,
  requantizeRemainingSwapBaseAtPriceForDimensions,
} from '../../../../../orderbook/types';
import { releaseHold } from '../../../hold-utils';
import type {
  AppliedSwapResolve,
  SwapResolveFailure,
} from './types';
import { accountTxValidationRejected } from '../../../apply-result';
import {
  requantizeSwapNetAuthorization,
  type SwapNetAuthorization,
} from '../../../../swap/swap-net-authorization';
import { commitDeltaDraft } from '../../../delta-utils';

export type SwapResolveRemainderResult =
  | {
      ok: true;
      swapOfferCancelled?: { offerId: string; accountId: string };
    }
  | SwapResolveFailure;

const failure = (events: string[], error: string): SwapResolveFailure =>
  accountTxValidationRejected(error, events);

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
  account: AccountDraftState,
  resolve: AppliedSwapResolve,
  events: string[],
  message: string,
): SwapResolveRemainderResult => {
  commitDeltaDraft(account, resolve.giveDelta);
  commitDeltaDraft(account, resolve.wantDelta);
  account.swapOffers.del(resolve.offerId);
  const makerId = resolve.offer.makerIsLeft
    ? account.leftEntity
    : account.rightEntity;
  events.push(`📊 Swap offer ${resolve.offerId.slice(0, 8)}... ${message}`);
  return {
    ok: true,
    swapOfferCancelled: { offerId: resolve.offerId, accountId: makerId },
  };
};

export const applySwapResolveRemainder = (
  account: AccountDraftState,
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
  const side = deriveSide(resolve.offer.giveTokenId, resolve.offer.wantTokenId);
  const canonicalBaseAmount = side === 1
    ? resolve.canonicalQuantizedGive
    : resolve.canonicalQuantizedWant;
  const filledBaseAmount = side === 1 ? resolve.filledGive : resolve.filledWant;
  const remainingBaseAmount = canonicalBaseAmount - filledBaseAmount;
  const priceTicks = resolve.canonicalPriceTicks;
  const requantized = requantizeRemainingSwapBaseAtPriceForDimensions(
    resolve.offer.giveTokenId,
    resolve.offer.wantTokenId,
    remainingBaseAmount,
    priceTicks,
    {
      giveTokenDecimals: resolve.offer.giveTokenDecimals,
      wantTokenDecimals: resolve.offer.wantTokenDecimals,
    },
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
  const releasedGive = remainingGive - requantized.effectiveGive;
  if (releasedGive < 0n) {
    return failure(
      events,
      `Swap remainder exceeds held give: remaining=${remainingGive} required=${requantized.effectiveGive}`,
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
    releasedGive,
    events,
  );
  if (dustFailure) return dustFailure;
  // Patricia leaves are immutable by identity. A partial fill must replace the
  // resting offer instead of mutating the object returned by `get()`: changing
  // that frozen leaf would either throw after bilateral ACK or leave its parent
  // hash stale. Same-j offers have no nested cross-j route, so this bounded
  // scalar copy is the complete canonical replacement value.
  const remainingOffer = {
    ...resolve.offer,
    giveAmount: requantized.effectiveGive,
    wantAmount: requantized.effectiveWant,
    maxFee: authorization.maxFee,
    minNetReceive: authorization.minNetReceive,
    priceTicks,
    quantizedGive: requantized.effectiveGive,
    quantizedWant: requantized.effectiveWant,
  };
  commitDeltaDraft(account, resolve.giveDelta);
  commitDeltaDraft(account, resolve.wantDelta);
  account.swapOffers.put(resolve.offerId, remainingOffer);
  events.push(
    `📊 Swap offer ${resolve.offerId.slice(0, 8)}... partially filled, ` +
    `${remainingOffer.giveAmount} remaining`,
  );
  return { ok: true };
};
