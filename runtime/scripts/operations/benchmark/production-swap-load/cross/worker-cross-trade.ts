/** Execute one committed production cross-j fill against an existing MM route. */

import type { AccountReplica } from '../../../../../types/account';
import type { CrossJurisdictionSwapRoute } from '../../../../../types/cross-jurisdiction';
import { withCanonicalCrossJurisdictionRouteHash } from '../../../../../extensions/cross-j';
import { sendObserved, type ConnectedRuntime } from '../worker-runtime';
import { waitForSettledCrossRoute } from './worker-cross-state';

type TradeIdentity = Readonly<{ entityId: string; signerId: string }>;

export type CrossProductionTradeOptions = Readonly<{
  hubRuntime: ConnectedRuntime;
  loadRuntime: ConnectedRuntime;
  marketMakerRoute: CrossJurisdictionSwapRoute;
  sourceHub: TradeIdentity;
  targetHub: TradeIdentity;
  sourceUser: TradeIdentity;
  targetUser: TradeIdentity;
  sourceAccount: AccountReplica;
  targetAccount: AccountReplica;
  orderId: string;
  createdAt: number;
}>;

export type CrossProductionTradeResult = Readonly<{
  route: CrossJurisdictionSwapRoute;
  settled: CrossJurisdictionSwapRoute;
  enqueueAckElapsedMs: number;
  commandObservedElapsedMs: number;
  economicCompletionElapsedMs: number;
}>;

const hasParticipants = (
  account: AccountReplica,
  first: string,
  second: string,
): boolean => {
  const participants = new Set([
    account.state.leftEntity.toLowerCase(),
    account.state.rightEntity.toLowerCase(),
  ]);
  return participants.has(first.toLowerCase()) && participants.has(second.toLowerCase());
};

const validateTradeContext = (options: CrossProductionTradeOptions): void => {
  if (!options.orderId.trim()) throw new Error('PRODUCTION_CROSS_TRADE_ORDER_ID_INVALID');
  if (!Number.isSafeInteger(options.createdAt) || options.createdAt <= 0) {
    throw new Error(`PRODUCTION_CROSS_TRADE_CREATED_AT_INVALID:${options.createdAt}`);
  }
  const market = options.marketMakerRoute;
  if (
    market.source.counterpartyEntityId.toLowerCase() !== options.sourceHub.entityId.toLowerCase() ||
    market.target.entityId.toLowerCase() !== options.targetHub.entityId.toLowerCase()
  ) throw new Error('PRODUCTION_CROSS_TRADE_HUB_ROUTE_MISMATCH');
  if (!hasParticipants(options.sourceAccount, options.sourceUser.entityId, options.sourceHub.entityId)) {
    throw new Error('PRODUCTION_CROSS_TRADE_SOURCE_ACCOUNT_MISMATCH');
  }
  if (!hasParticipants(options.targetAccount, options.targetUser.entityId, options.targetHub.entityId)) {
    throw new Error('PRODUCTION_CROSS_TRADE_TARGET_ACCOUNT_MISMATCH');
  }
};

const buildTakingRoute = (options: CrossProductionTradeOptions): CrossJurisdictionSwapRoute => {
  const { marketMakerRoute: market, sourceHub, targetHub, sourceUser, targetUser } = options;
  return withCanonicalCrossJurisdictionRouteHash({
    orderId: options.orderId,
    makerEntityId: targetUser.entityId,
    hubEntityId: targetHub.entityId,
    ...(market.bookOwnerEntityId ? { bookOwnerEntityId: market.bookOwnerEntityId } : {}),
    sourceSignerId: targetUser.signerId,
    sourceHubSignerId: targetHub.signerId,
    targetHubSignerId: sourceHub.signerId,
    targetSignerId: sourceUser.signerId,
    ...(market.bookHubSignerId ? { bookHubSignerId: market.bookHubSignerId } : {}),
    source: {
      jurisdiction: market.target.jurisdiction,
      entityId: targetUser.entityId,
      counterpartyEntityId: targetHub.entityId,
      tokenId: market.target.tokenId,
      amount: market.target.amount,
    },
    target: {
      jurisdiction: market.source.jurisdiction,
      entityId: sourceHub.entityId,
      counterpartyEntityId: sourceUser.entityId,
      tokenId: market.source.tokenId,
      amount: market.source.amount,
    },
    sourceDisputeConfig: { ...options.targetAccount.state.disputeConfig },
    targetDisputeConfig: { ...options.sourceAccount.state.disputeConfig },
    ...(market.priceTicks !== undefined ? { priceTicks: market.priceTicks } : {}),
    riskMode: 'fully_collateralized',
    status: 'intent',
    createdAt: options.createdAt,
    updatedAt: options.createdAt,
    expiresAt: options.createdAt + 10 * 60_000,
  });
};

export const executeCrossProductionTrade = async (
  options: CrossProductionTradeOptions,
): Promise<CrossProductionTradeResult> => {
  validateTradeContext(options);
  const route = buildTakingRoute(options);
  const startedAt = performance.now();
  const observed = await sendObserved(options.loadRuntime, options.orderId, {
    runtimeTxs: [],
    entityInputs: [
      {
        entityId: options.targetUser.entityId,
        signerId: options.targetUser.signerId,
        entityTxs: [{ type: 'prepareCrossJurisdictionSwap', data: { route } }],
      },
      {
        entityId: options.sourceUser.entityId,
        signerId: options.sourceUser.signerId,
        entityTxs: [{ type: 'prepareCrossJurisdictionSwap', data: { route } }],
      },
    ],
  });
  const settled = await waitForSettledCrossRoute(
    options.hubRuntime,
    options.sourceHub.entityId,
    options.targetHub.entityId,
    options.orderId,
    options.marketMakerRoute.target.amount,
    options.marketMakerRoute.source.amount,
  );
  return {
    route,
    settled,
    enqueueAckElapsedMs: observed.enqueueAckElapsedMs,
    commandObservedElapsedMs: observed.commandObservedElapsedMs,
    economicCompletionElapsedMs: Math.max(1, Math.ceil(performance.now() - startedAt)),
  };
};
