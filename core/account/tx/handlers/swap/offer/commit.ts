import type { SwapOffer } from '../../../../../types/account';
import type { AccountDraftReplica } from '../../../../state/account-state-draft';
import type { ApplyAccountTxResult } from '../../../apply-types';
import { accountTxSwapOfferCreated, accountTxValidationRejected } from '../../../apply-result';
import { deriveDelta } from '../../../../utils';
import { cloneCrossJurisdictionRoute } from '../../../../../extensions/cross-j';
import { commitDeltaDraft, createDeltaDraft } from '../../../delta-utils';
import { addHold } from '../../../hold-utils';
import type { SwapOfferAdmission, SwapOfferTx } from './admission';
import type { PreparedSwapOfferAmounts } from './quantization';
import {
  requantizeSwapNetAuthorization,
  type SwapNetAuthorization,
} from '../../../../swap/swap-net-authorization';

export const commitSwapOffer = (
  account: AccountDraftReplica,
  tx: SwapOfferTx,
  admission: SwapOfferAdmission,
  prepared: PreparedSwapOfferAmounts,
  currentHeight: number,
): ApplyAccountTxResult => {
  const {
    offerId, giveTokenId, giveTokenDecimals, wantTokenId, wantTokenDecimals,
    timeInForce, crossJurisdiction,
  } = tx.data;
  const { priceTicks, effectiveGiveAmount, effectiveWantAmount } = prepared;
  let authorization: SwapNetAuthorization;
  try {
    authorization = requantizeSwapNetAuthorization(
      tx.data,
      effectiveGiveAmount,
      effectiveWantAmount,
    );
  } catch (error) {
    return accountTxValidationRejected(
      error instanceof Error ? error.message : String(error),
      [],
    );
  }
  const delta = createDeltaDraft(account.state, giveTokenId);
  // A cross-j source pull already owns the economic lock. Adding a second hold
  // here would double-reserve the same funds; same-j offers lock capacity now.
  if (!crossJurisdiction) {
    const available = deriveDelta(delta, admission.makerIsLeft).outCapacity;
    if (effectiveGiveAmount > available) {
      return accountTxValidationRejected(
        `Insufficient capacity: need ${effectiveGiveAmount}, available ${available}`,
        [],
      );
    }
  }
  const publicRoute = crossJurisdiction ? cloneCrossJurisdictionRoute(crossJurisdiction) : undefined;
  const offer: SwapOffer = {
    offerId,
    giveTokenId,
    giveTokenDecimals,
    giveAmount: effectiveGiveAmount,
    wantTokenId,
    wantTokenDecimals,
    wantAmount: effectiveWantAmount,
    ...authorization,
    priceTicks,
    ...(timeInForce !== undefined ? { timeInForce } : {}),
    makerIsLeft: admission.makerIsLeft,
    createdHeight: currentHeight,
    quantizedGive: effectiveGiveAmount,
    quantizedWant: effectiveWantAmount,
    ...(publicRoute ? { crossJurisdiction: publicRoute } : {}),
  };
  // Holds and swapOffers are both hashed Account state. Validation and commit
  // therefore run this same mutation path; a validation-only shadow path would
  // produce a different AccountFrame root.
  if (!crossJurisdiction) {
    const holdError = addHold(delta, admission.makerIsLeft ? 'left' : 'right', effectiveGiveAmount);
    if (holdError) return accountTxValidationRejected(holdError, []);
  }
  commitDeltaDraft(account.state, delta);
  account.state.swapOffers.put(offerId, offer);
  const events = [
    `📊 Swap offer created: ${offerId.slice(0, 8)}... give ` +
      `${effectiveGiveAmount} token${giveTokenId} for ` +
      `${effectiveWantAmount} token${wantTokenId}`,
  ];
  return accountTxSwapOfferCreated(events, {
    offerId,
    makerIsLeft: admission.makerIsLeft,
    fromEntity: admission.leftEntity,
    toEntity: admission.rightEntity,
    createdHeight: currentHeight,
    giveTokenId,
    giveTokenDecimals,
    giveAmount: effectiveGiveAmount,
    wantTokenId,
    wantTokenDecimals,
    wantAmount: effectiveWantAmount,
    ...authorization,
    priceTicks,
    ...(timeInForce !== undefined ? { timeInForce } : {}),
    ...(publicRoute ? { crossJurisdiction: publicRoute } : {}),
  });
};
