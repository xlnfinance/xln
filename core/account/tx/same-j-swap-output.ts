import type {
  AccountOutput,
  AccountSwapOfferSnapshot,
  AccountTx,
  SwapOffer,
} from '../../types/account';
import type { AccountDraftReplica } from '../state/account-state-draft';

type SameJurisdictionSwapOutput = Extract<
  AccountOutput,
  { kind: 'swapOfferUpsert' | 'swapOfferRemove' | 'swapCancelRequest' }
>;

const requireSameJurisdictionOffer = (
  account: AccountDraftReplica,
  offerId: string,
): SwapOffer => {
  const offer = account.state.swapOffers.get(offerId);
  if (!offer) throw new Error(`SAME_J_SWAP_OUTPUT_OFFER_MISSING:${offerId}`);
  if (offer.crossJurisdiction) {
    throw new Error(`SAME_J_SWAP_OUTPUT_CROSS_J_OFFER:${offerId}`);
  }
  return offer;
};

const snapshotSameJurisdictionOffer = (
  account: AccountDraftReplica,
  offer: SwapOffer,
): AccountSwapOfferSnapshot => ({
  offerId: offer.offerId,
  leftEntity: account.state.leftEntity,
  rightEntity: account.state.rightEntity,
  giveTokenId: offer.giveTokenId,
  giveTokenDecimals: offer.giveTokenDecimals,
  giveAmount: offer.giveAmount,
  wantTokenId: offer.wantTokenId,
  wantTokenDecimals: offer.wantTokenDecimals,
  wantAmount: offer.wantAmount,
  maxFee: offer.maxFee,
  minNetReceive: offer.minNetReceive,
  priceTicks: offer.priceTicks,
  ...(offer.timeInForce !== undefined ? { timeInForce: offer.timeInForce } : {}),
  makerIsLeft: offer.makerIsLeft,
  createdHeight: offer.createdHeight,
  quantizedGive: offer.quantizedGive,
  quantizedWant: offer.quantizedWant,
  // This marker is created only at the Account-machine output boundary. It
  // lets Entity consume the exact post-transition snapshot before the worker
  // materializes that Account shell, matching the Rust authority path.
  accountOutputVerified: true,
});

const upsertOutput = (
  account: AccountDraftReplica,
  offerId: string,
): SameJurisdictionSwapOutput => ({
  kind: 'swapOfferUpsert',
  offer: snapshotSameJurisdictionOffer(
    account,
    requireSameJurisdictionOffer(account, offerId),
  ),
});

/** Emits only same-j effects, in signed AccountTx order, from post-transition state. */
export const collectSameJurisdictionSwapOutputs = (
  account: AccountDraftReplica,
  tx: AccountTx,
): readonly SameJurisdictionSwapOutput[] => {
  if (tx.type === 'swap_offer') {
    return tx.data.crossJurisdiction ? [] : [upsertOutput(account, tx.data.offerId)];
  }
  if (tx.type === 'swap_resolve') {
    return account.state.swapOffers.has(tx.data.offerId)
      ? [upsertOutput(account, tx.data.offerId)]
      : [{ kind: 'swapOfferRemove', offerId: tx.data.offerId }];
  }
  if (tx.type === 'swap_cancel_request') {
    const offer = account.state.swapOffers.get(tx.data.offerId);
    if (!offer) throw new Error(`SAME_J_SWAP_OUTPUT_OFFER_MISSING:${tx.data.offerId}`);
    return offer.crossJurisdiction
      ? []
      : [{ kind: 'swapCancelRequest', offerId: tx.data.offerId }];
  }
  return [];
};
