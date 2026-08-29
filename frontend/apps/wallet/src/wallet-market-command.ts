import type { RuntimePaymentEntityTx, RuntimePaymentInput } from '../../../packages/runtime-client/src/payment-command-types';
import type { WalletPaymentMath, WalletPaymentProjection } from './wallet-payment-model';
import { buildWalletEntityTxInput } from './wallet-payment-model';
import type { WalletMarketMath } from './wallet-runtime-read-boundary';
import type { WalletMarketProjection } from './wallet-market-model';

export type WalletMarketOrderDraft = Readonly<{
  hubEntityId: string;
  giveTokenId: number;
  wantTokenId: number;
  giveAmount: string;
  wantAmount: string;
  timeInForce: 0 | 1 | 2;
}>;

const paymentProjection = (projection: WalletMarketProjection): WalletPaymentProjection => ({
  height: projection.height,
  activeEntityId: projection.activeEntityId,
  activeEntityLabel: projection.activeEntityLabel,
  signerId: projection.signerId,
  entities: projection.entities,
  recipients: projection.recipients,
  tokens: projection.tokens,
  accounts: projection.accounts,
});

const requireHubCapacity = (
  projection: WalletMarketProjection,
  hubEntityId: string,
  tokenId: number,
  amount: bigint,
): void => {
  const account = projection.accounts.find(({ counterpartyId }) => counterpartyId === hubEntityId);
  if (!account) throw new Error('WALLET_MARKET_HUB_ACCOUNT_REQUIRED');
  const position = account.positions.find((candidate) => candidate.tokenId === tokenId);
  if (!position || amount > position.spendable) throw new Error('WALLET_MARKET_CAPACITY_EXCEEDED');
};

export const buildWalletMarketOrderInput = (
  draft: WalletMarketOrderDraft,
  projection: WalletMarketProjection,
  paymentMath: WalletPaymentMath,
  marketMath: WalletMarketMath,
): RuntimePaymentInput => {
  const hub = projection.hubs.find(({ entityId }) => entityId === draft.hubEntityId);
  if (!hub || hub.entityId !== projection.selectedHubId) throw new Error('WALLET_MARKET_HUB_UNKNOWN');
  if (hub.feeBps === null) throw new Error('WALLET_MARKET_FEE_POLICY_UNAVAILABLE');
  if (draft.giveTokenId === draft.wantTokenId) throw new Error('WALLET_MARKET_TOKEN_PAIR_INVALID');
  const pair = marketMath.canonicalPair(draft.giveTokenId, draft.wantTokenId);
  if (!projection.pairs.some(({ pairId }) => pairId === pair.pairId)) {
    throw new Error('WALLET_MARKET_PAIR_UNSUPPORTED');
  }
  if (!projection.tokens.some(({ tokenId }) => tokenId === draft.giveTokenId) ||
      !projection.tokens.some(({ tokenId }) => tokenId === draft.wantTokenId)) {
    throw new Error('WALLET_MARKET_TOKEN_UNKNOWN');
  }
  const rawGive = paymentMath.parseTokenAmount(draft.giveTokenId, draft.giveAmount.trim());
  const rawWant = paymentMath.parseTokenAmount(draft.wantTokenId, draft.wantAmount.trim());
  if (rawGive <= 0n || rawWant <= 0n) throw new Error('WALLET_MARKET_AMOUNT_NOT_POSITIVE');
  const dimensions = marketMath.getStaticSwapTokenDimensions(draft.giveTokenId, draft.wantTokenId);
  const prepared = marketMath.prepareSwapOrderForDimensions(
    draft.giveTokenId,
    draft.wantTokenId,
    rawGive,
    rawWant,
    dimensions,
  );
  if (!prepared) throw new Error('WALLET_MARKET_ORDER_BELOW_CANONICAL_LOT');
  requireHubCapacity(projection, hub.entityId, draft.giveTokenId, prepared.effectiveGive);
  const authorization = marketMath.deriveSwapNetAuthorization(prepared.effectiveWant, hub.feeBps);
  const offerId = marketMath.buildDeterministicSwapOfferId({
    logicalTimestamp: projection.logicalTimestamp,
    logicalHeight: projection.height,
    sourceEntityId: projection.activeEntityId,
    counterpartyEntityId: hub.entityId,
    sellToken: draft.giveTokenId,
    buyToken: draft.wantTokenId,
    sellAmount: prepared.effectiveGive,
    buyAmount: prepared.effectiveWant,
    priceTicks: prepared.priceTicks,
    routeValue: `same:${hub.entityId}`,
  });
  const tx: RuntimePaymentEntityTx = {
    type: 'placeSwapOffer',
    data: {
      counterpartyEntityId: hub.entityId,
      offerId,
      giveTokenId: draft.giveTokenId,
      ...dimensions,
      giveAmount: prepared.effectiveGive,
      wantTokenId: draft.wantTokenId,
      wantAmount: prepared.effectiveWant,
      ...authorization,
      priceTicks: prepared.priceTicks,
      timeInForce: draft.timeInForce,
    },
  };
  return buildWalletEntityTxInput(paymentProjection(projection), tx);
};

export const buildWalletMarketCancelInput = (
  projection: WalletMarketProjection,
  offerId: string,
): RuntimePaymentInput => {
  const offer = projection.openOrders.find((candidate) => candidate.offerId === offerId);
  if (!offer) throw new Error('WALLET_MARKET_OPEN_ORDER_UNKNOWN');
  return buildWalletEntityTxInput(paymentProjection(projection), {
    type: 'proposeCancelSwap',
    data: { counterpartyEntityId: offer.hubEntityId, offerId: offer.offerId },
  });
};
