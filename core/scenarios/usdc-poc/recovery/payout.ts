import { deriveDelta, isLeftEntity } from '../../../account/utils';
import { targetContracts, targetSnapshot } from '../target-evidence';
import { userReplica, waitFor, type PocUser } from '../user';
import { verifyHubCommit } from '../hub-proof';
import { withdrawTargetCollateral } from '../external-payout';

export const resumePayout = async (user: PocUser, apiBase: string, workDir: string, baselineToken = 0n) => {
  const route = userReplica(user).state.crossJurisdictionSwaps?.get(user.orderId);
  if (!route || route.status !== 'settled') throw new Error('USDC_POC_RESTORE_PAYOUT_ROUTE_NOT_SETTLED');
  const identity = user.identities.find(item => item.entityId === route.target.counterpartyEntityId);
  const jurisdiction = user.jurisdictions.find(item => item.chainId === identity?.chainId);
  if (!identity || !jurisdiction) throw new Error('USDC_POC_RESTORE_PAYOUT_TARGET_MISSING');
  const target = {
    ...user,
    ...identity,
    jurisdiction: { ...jurisdiction, rpc: new URL(jurisdiction.rpc, apiBase).toString() },
  };
  const contracts = await targetContracts(target);
  try {
    const account = userReplica(target).state.accounts.get(route.target.entityId);
    if (!account) throw new Error('USDC_POC_RESTORE_PAYOUT_ACCOUNT_MISSING');
    const delta = account.state.deltas.get(1);
    if (!delta) throw new Error('USDC_POC_RESTORE_PAYOUT_DELTA_MISSING');
    const feeState = account.state.requestedRebalanceFeeState.get(1);
    const workspace = account.state.settlementWorkspace;
    const batch = userReplica(target).state.jBatchState;
    const accepted = [
      feeState?.requestedAmount,
      ...(workspace?.ops.flatMap(op => (op.type === 'c2r' && op.tokenId === 1 ? [op.amount] : [])) ?? []),
      ...(batch?.sentBatch?.batch.reserveToExternalToken.filter(op => op.tokenId === 1).map(op => op.amount) ?? []),
      deriveDelta(delta, isLeftEntity(target.entityId, route.target.entityId)).outCollateral,
      userReplica(target).state.reserves.get(1),
      (await contracts.token.balanceOf(target.signerId)) - baselineToken,
    ].filter((amount): amount is bigint => amount !== undefined && amount > 0n);
    const net = accepted[0];
    if (!net || accepted.some(amount => amount !== net)) throw new Error('USDC_POC_RESTORE_ACCEPTED_NET_AMBIGUOUS');
    if (net < 850_000n || net > route.target.amount || 1_000_000n - net > 150_000n)
      throw new Error('USDC_POC_RESTORE_ACCEPTED_NET_INVALID');
    await waitFor('restored-cover-or-withdrawal', async () => {
      const current = userReplica(target).state.accounts.get(route.target.entityId);
      const delta = current?.state.deltas.get(1);
      return (
        Boolean(
          delta && deriveDelta(delta, isLeftEntity(target.entityId, route.target.entityId)).outCollateral === net,
        ) || (await contracts.token.balanceOf(target.signerId)) === baselineToken + net
      );
    });
    const ready = userReplica(target).state.accounts.get(route.target.entityId);
    if (!ready) throw new Error('USDC_POC_RESTORE_PAYOUT_ACCOUNT_LOST');
    if (
      (await contracts.token.balanceOf(target.signerId)) === baselineToken &&
      !ready.state.settlementWorkspace &&
      !userReplica(target).state.settlementContinuations?.size
    ) {
      await withdrawTargetCollateral(target, route.target.entityId, net);
    }
    await waitFor(
      'restored-external-payout',
      async () => (await contracts.token.balanceOf(target.signerId)) === baselineToken + net,
    );
    const bilateral = await verifyHubCommit(target, route.target.entityId, workDir);
    const after = await targetSnapshot(target, route.target.entityId, contracts);
    if (
      after.reserve !== 0n ||
      after.collateral !== 0n ||
      after.account.view.outPeerCredit !== 0n ||
      after.activeDebts !== 0n ||
      after.token - baselineToken < 850_000n ||
      1_000_000n - (after.token - baselineToken) > 150_000n
    )
      throw new Error('USDC_POC_RECOVERY_PAYOUT_INVALID');
    return {
      recipient: target.signerId,
      targetEntityId: target.entityId,
      targetHubEntityId: route.target.entityId,
      sourceAmount: route.source.amount,
      grossTargetAmount: route.target.amount,
      acceptedNetSources: accepted.length,
      fee: route.target.amount - net,
      paid: net,
      after,
      bilateral,
      externalPayout: true,
    };
  } finally {
    contracts.provider.destroy();
  }
};
