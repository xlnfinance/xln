import type { AccountState, AccountTx } from '../../../../types/account';
import { FINANCIAL, LIMITS } from '../../../../config/constants';
import { getAccountSwapMarketLimitError } from '../../../swap-limits';
import { assertSwapNetAuthorization } from '../../../swap-net-authorization';

export type SwapOfferTx = Extract<AccountTx, { type: 'swap_offer' }>;

export type SwapOfferAdmission = {
  leftEntity: string;
  rightEntity: string;
  makerIsLeft: boolean;
};

const validateOfferCapacityLimits = (
  account: AccountState,
  tx: SwapOfferTx,
): string | null => {
  const { offerId, crossJurisdiction } = tx.data;
  if (offerId.includes(':')) {
    return `Invalid offerId: colons not allowed (got ${offerId})`;
  }
  if (account.swapOffers!.has(offerId)) return `Offer ${offerId} already exists`;
  if (account.swapOffers!.size >= LIMITS.MAX_ACCOUNT_SWAP_OFFERS) {
    return `Too many open swap offers: max ${LIMITS.MAX_ACCOUNT_SWAP_OFFERS}`;
  }
  const offers = Array.from(account.swapOffers!.values());
  const sameJurisdictionCount = offers.filter(offer => !offer.crossJurisdiction).length;
  if (
    !crossJurisdiction &&
    sameJurisdictionCount >= LIMITS.MAX_ACCOUNT_SAME_J_SWAP_OFFERS
  ) {
    return `Too many open same-j swap offers: max ${LIMITS.MAX_ACCOUNT_SAME_J_SWAP_OFFERS}`;
  }
  const crossJurisdictionCount = offers.length - sameJurisdictionCount;
  if (
    crossJurisdiction &&
    crossJurisdictionCount >= LIMITS.MAX_ACCOUNT_CROSS_J_SWAP_OFFERS
  ) {
    return `Too many open cross-j swap offers: max ${LIMITS.MAX_ACCOUNT_CROSS_J_SWAP_OFFERS}`;
  }
  return null;
};

const validateOfferShape = (tx: SwapOfferTx): string | null => {
  const {
    giveTokenId,
    giveAmount,
    wantTokenId,
    wantAmount,
    timeInForce,
    crossJurisdiction,
  } = tx.data;
  if (giveAmount < FINANCIAL.MIN_PAYMENT_AMOUNT || giveAmount > FINANCIAL.MAX_PAYMENT_AMOUNT) {
    return `Invalid giveAmount: ${giveAmount} (min ${FINANCIAL.MIN_PAYMENT_AMOUNT}, max ${FINANCIAL.MAX_PAYMENT_AMOUNT})`;
  }
  if (wantAmount < FINANCIAL.MIN_PAYMENT_AMOUNT || wantAmount > FINANCIAL.MAX_PAYMENT_AMOUNT) {
    return `Invalid wantAmount: ${wantAmount} (min ${FINANCIAL.MIN_PAYMENT_AMOUNT}, max ${FINANCIAL.MAX_PAYMENT_AMOUNT})`;
  }
  if (tx.data.maxFee >= wantAmount || tx.data.minNetReceive <= 0n) {
    return 'SWAP_NET_AUTH_INITIAL_TERMS_INVALID';
  }
  try {
    assertSwapNetAuthorization(tx.data, 0n, 0n, 0n);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  if (giveTokenId === wantTokenId && !crossJurisdiction) {
    return `Cannot swap same token: ${giveTokenId}`;
  }
  if (
    crossJurisdiction &&
    (
      crossJurisdiction.status !== 'resting' ||
      !crossJurisdiction.sourcePull ||
      !crossJurisdiction.targetPull
    )
  ) {
    return 'Cross-j swap must be prepared before entering the book';
  }
  if (timeInForce !== undefined && ![0, 1, 2].includes(timeInForce)) {
    return `Invalid timeInForce: ${String(timeInForce)}`;
  }
  return null;
};

export const validateSwapOfferAdmission = (
  account: AccountState,
  tx: SwapOfferTx,
  byLeft: boolean,
): { admission?: SwapOfferAdmission; error?: string } => {
  const limitError = validateOfferCapacityLimits(account, tx);
  if (limitError) return { error: limitError };
  const shapeError = validateOfferShape(tx);
  if (shapeError) return { error: shapeError };
  const { leftEntity, rightEntity } = account;
  const proposerEntityId = byLeft ? leftEntity : rightEntity;
  const route = tx.data.crossJurisdiction;
  const makerIsLeft = route
    ? route.makerEntityId.toLowerCase() === leftEntity.toLowerCase()
    : byLeft;
  const makerEntityId = makerIsLeft ? leftEntity : rightEntity;
  if (
    route &&
    (
      route.makerEntityId.toLowerCase() !== makerEntityId.toLowerCase() ||
      ![route.makerEntityId, route.source.counterpartyEntityId]
        .some(entityId => entityId.toLowerCase() === proposerEntityId.toLowerCase())
    )
  ) {
    return { error: 'Cross-j swap proposer must be the maker or source hub' };
  }
  const marketLimitError = getAccountSwapMarketLimitError(account.swapOffers!.values(), {
    giveTokenId: tx.data.giveTokenId,
    wantTokenId: tx.data.wantTokenId,
    ...(route ? { crossJurisdiction: route } : {}),
    makerIsLeft,
  });
  if (marketLimitError) return { error: marketLimitError };
  return { admission: { leftEntity, rightEntity, makerIsLeft } };
};
