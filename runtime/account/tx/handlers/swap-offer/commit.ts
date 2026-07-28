import type {
  AccountState,
  SwapOffer,
} from '../../../../types';
import type { SwapOfferEvent } from '../../../../entity/tx/handlers/account';
import { deriveDelta } from '../../../utils';
import { cloneCrossJurisdictionRoute } from '../../../../extensions/cross-j';
import { ensureDelta } from '../../delta-utils';
import { addHold } from '../../hold-utils';
import { recordSwapOfferLifecycle } from '../swap-history';
import type {
  SwapOfferAdmission,
  SwapOfferTx,
} from './admission';
import type { PreparedSwapOfferAmounts } from './quantization';

type SwapOfferResult = {
  success: boolean;
  events: string[];
  error?: string;
  swapOfferCreated?: SwapOfferEvent;
};

export const commitSwapOffer = (
  account: AccountState,
  tx: SwapOfferTx,
  admission: SwapOfferAdmission,
  prepared: PreparedSwapOfferAmounts,
  currentHeight: number,
): SwapOfferResult => {
  const {
    offerId,
    giveTokenId,
    wantTokenId,
    timeInForce,
    crossJurisdiction,
  } = tx.data;
  const {
    priceTicks,
    effectiveGiveAmount,
    effectiveWantAmount,
  } = prepared;
  const delta = ensureDelta(account, giveTokenId);
  // A cross-j source pull already owns the economic lock. Adding a second hold
  // here would double-reserve the same funds; same-j offers lock capacity now.
  if (!crossJurisdiction) {
    const available = deriveDelta(delta, admission.makerIsLeft).outCapacity;
    if (effectiveGiveAmount > available) {
      return {
        success: false,
        error: `Insufficient capacity: need ${effectiveGiveAmount}, available ${available}`,
        events: [],
      };
    }
  }
  const publicRoute = crossJurisdiction
    ? cloneCrossJurisdictionRoute(crossJurisdiction)
    : undefined;
  const offer: SwapOffer = {
    offerId,
    giveTokenId,
    giveAmount: effectiveGiveAmount,
    wantTokenId,
    wantAmount: effectiveWantAmount,
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
    const holdError = addHold(
      delta,
      admission.makerIsLeft ? 'left' : 'right',
      effectiveGiveAmount,
    );
    if (holdError) return { success: false, error: holdError, events: [] };
  }
  account.swapOffers!.set(offerId, offer);
  recordSwapOfferLifecycle(account, offer);
  const events = [
    `📊 Swap offer created: ${offerId.slice(0,8)}... give ` +
    `${effectiveGiveAmount} token${giveTokenId} for ` +
    `${effectiveWantAmount} token${wantTokenId}`,
  ];
  return {
    success: true,
    events,
    swapOfferCreated: {
      offerId,
      makerIsLeft: admission.makerIsLeft,
      fromEntity: admission.leftEntity,
      toEntity: admission.rightEntity,
      createdHeight: currentHeight,
      giveTokenId,
      giveAmount: effectiveGiveAmount,
      wantTokenId,
      wantAmount: effectiveWantAmount,
      priceTicks,
      ...(timeInForce !== undefined ? { timeInForce } : {}),
      ...(publicRoute ? { crossJurisdiction: publicRoute } : {}),
    },
  };
};
