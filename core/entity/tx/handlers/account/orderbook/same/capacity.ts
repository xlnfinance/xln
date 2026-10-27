import { deriveDelta } from '../../../../../../account/utils';
import { createDefaultDelta } from '../../../../../../account/state/delta';
import {
  baseAmountFromLotsForDecimals, quoteAmountFromWeightedLotsForDecimals, deriveSide,
  type ApplyCommandOptions,
} from '../../../../../../swapbook';
import type { NormalizedOrderbookOffer } from '../../../../../../swapbook/swap-execution';
import { buildLiveSameOfferMeta, type SameOrderbookPass } from './pass';

const availableCapacity = (
  pass: SameOrderbookPass,
  offer: NormalizedOrderbookOffer,
  delta: ReturnType<typeof createDefaultDelta>,
): bigint => {
  const account = pass.hubState.accounts.get(offer.accountId);
  if (!account) throw new Error(`ORDERBOOK_ACCOUNT_LOOKUP_FAILED:${offer.accountId}`);
  let available = deriveDelta(delta, !offer.makerIsLeft).outCapacity;
  for (const { accountId, tx } of pass.accountTxs) {
    if (accountId !== offer.accountId || tx.type !== 'swap_resolve' || tx.data.fillRatio === 0) continue;
    const queuedOffer = account.state.swapOffers.get(tx.data.offerId);
    if (queuedOffer?.wantTokenId === offer.wantTokenId) {
      // Matcher resolutions always bind exact execution amounts.
      if (tx.data.executionWantAmount === undefined) throw new Error('ORDERBOOK_RESOLVE_EXECUTION_MISSING');
      available -= tx.data.executionWantAmount;
    }
  }
  return available;
};

/** Command-local reservations disappear with a rejected FOK/fee preview. */
export const sameMatchCapacity = (pass: SameOrderbookPass): NonNullable<ApplyCommandOptions['admitMatch']> => {
  const consumed = new Map<string, bigint>();
  const leg = (orderId: string, price: bigint, qty: bigint) => {
    const offer = pass.orderbookOfferMeta.get(orderId) ?? buildLiveSameOfferMeta(pass, orderId);
    if (!offer) throw new Error(`ORDERBOOK_SAME_SNAPSHOT_MISSING:${orderId}`);
    const account = pass.hubState.accounts.get(offer.accountId);
    if (!account) throw new Error(`ORDERBOOK_ACCOUNT_LOOKUP_FAILED:${offer.accountId}`);
    const ask = deriveSide(offer.giveTokenId, offer.wantTokenId) === 1;
    const baseDecimals = ask ? offer.giveTokenDecimals : offer.wantTokenDecimals;
    const quoteDecimals = ask ? offer.wantTokenDecimals : offer.giveTokenDecimals;
    const amount = ask
      ? quoteAmountFromWeightedLotsForDecimals(baseDecimals, quoteDecimals, price * qty)
      : baseAmountFromLotsForDecimals(baseDecimals, qty);
    const key = `${offer.accountId}:${offer.wantTokenId}`;
    const delta = account.state.deltas.get(offer.wantTokenId) ?? createDefaultDelta(offer.wantTokenId);
    const available = availableCapacity(pass, offer, delta);
    return { key, amount, available: available - (consumed.get(key) ?? 0n) };
  };
  return (maker, takerOrderId, price, qty) => {
    const makerLeg = leg(maker.orderId, price, qty);
    if (makerLeg.amount > makerLeg.available) return 'cancel-maker';
    const takerLeg = leg(takerOrderId, price, qty);
    if (takerLeg.amount > takerLeg.available) return 'cancel-taker';
    // Check both counterparties before reserving either: no one-sided resolve.
    for (const entry of [makerLeg, takerLeg]) consumed.set(entry.key, (consumed.get(entry.key) ?? 0n) + entry.amount);
    return 'fill';
  };
};
