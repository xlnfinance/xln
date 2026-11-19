import { deriveDelta, isLeftEntity } from '../../../account/utils';
import { getCrossJurisdictionRouteRemainingAmounts } from '../../../extensions/cross-j/orderbook';
import { send, userReplica, waitFor, type PocUser } from '../user';
import { verifyHubCommit } from '../hub-proof';

export const recoverPartialClear = async (user: PocUser, hub: string, apiBase: string, workDir: string) => {
  const orderId = user.orderId;
  const opening = userReplica(user).state.crossJurisdictionSwaps?.get(orderId);
  if (!opening) throw new Error('USDC_POC_CLEAR_ROUTE_MISSING');
  const identity = user.identities.find(item => item.entityId === opening.target.counterpartyEntityId);
  const jurisdiction = user.jurisdictions.find(item => item.chainId === identity?.chainId);
  if (!identity || !jurisdiction) throw new Error('USDC_POC_CLEAR_TARGET_MISSING');
  const target = {
    ...user,
    ...identity,
    jurisdiction: { ...jurisdiction, rpc: new URL(jurisdiction.rpc, apiBase).toString() },
  };
  if (opening.status !== 'settled' && opening.status !== 'cancelled' && opening.status !== 'expired') {
    send(user, [{ type: 'requestCrossJurisdictionClear', data: { orderId, cancelRemainder: true } }]);
  }
  await waitFor('partial-clear-both-accounts-closed', () => {
    const source = userReplica(user).state.crossJurisdictionSwaps?.get(orderId);
    const received = userReplica(target).state.crossJurisdictionSwaps?.get(orderId);
    return Boolean(
      source?.sourceCloseProof?.closeMode === 'partial_cancel_remainder' &&
      received?.targetCloseProof?.closeMode === 'partial_cancel_remainder',
    );
  });
  const sourceProof = await verifyHubCommit(user, hub, workDir);
  const targetProof = await verifyHubCommit(target, opening.target.entityId, workDir);
  const route = userReplica(user).state.crossJurisdictionSwaps?.get(orderId);
  const source = userReplica(user).state.accounts.get(hub);
  const received = userReplica(target).state.accounts.get(opening.target.entityId);
  const sourceDelta = source?.state.deltas.get(1);
  const targetDelta = received?.state.deltas.get(1);
  if (!route || !source || !received || !sourceDelta || !targetDelta) throw new Error('USDC_POC_CLEAR_ACCOUNT_MISSING');
  const outgoing = deriveDelta(sourceDelta, isLeftEntity(user.entityId, hub));
  const incoming = deriveDelta(targetDelta, isLeftEntity(target.entityId, opening.target.entityId));
  const close = route.sourceCloseProof;
  if (
    !close ||
    close.cumulativeSourceAmount <= 0n ||
    close.cumulativeSourceAmount >= 1_000_000n ||
    outgoing.outCollateral + close.cumulativeSourceAmount !== 1_000_000n ||
    incoming.outPeerCredit !== close.cumulativeTargetAmount ||
    source.state.pulls?.size ||
    received.state.pulls?.size
  ) {
    throw new Error('USDC_POC_PARTIAL_CLEAR_ACCOUNTING_MISMATCH');
  }
  return {
    outcome: 'partial_cancel_remainder',
    fullSourcePocSuccess: false,
    externalPayout: false,
    orderId,
    routeHash: route.routeHash,
    status: route.status,
    amounts: getCrossJurisdictionRouteRemainingAmounts(route),
    executionSourceAmount: route.executionSourceAmount,
    executionTargetAmount: route.executionTargetAmount,
    sourceCloseProof: close,
    targetCloseProof: route.targetCloseProof,
    source: outgoing,
    target: incoming,
    expiresAt: route.expiresAt,
    sourcePull: route.sourcePull,
    targetPull: route.targetPull,
    sourceProof,
    targetProof,
    remainingObligation: {
      targetHubEntityId: opening.target.entityId,
      targetUserEntityId: target.entityId,
      tokenId: 1,
      claim: incoming.outPeerCredit,
      nextBoundary: 'canonical collateral cover then external withdrawal',
    },
  };
};
