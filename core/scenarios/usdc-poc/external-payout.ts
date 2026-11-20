import { zeroPadValue } from 'ethers';
import { deriveDelta, isLeftEntity } from '../../account/utils';
import { getOpenOutgoingDebtTotals } from '../../jurisdiction/machine/batch';
import { verifyHubCommit } from './hub-proof';
import { send, userReplica, waitFor, type PocUser } from './user';
import { targetContracts, targetSnapshot, type TargetContracts } from './target-evidence';
import { targetUser } from './journey/context';
import { requestCover, type CoverGuard } from './journey/cover';
import type { executeCrossSwap } from './cross-swap';

const coverClaim = async (
  target: PocUser,
  hub: string,
  gross: bigint,
  contracts: TargetContracts,
  workDir: string,
  guard?: CoverGuard,
) => {
  const { snapshot, policy, fee, net, tariffProof } = await requestCover(target, hub, gross, workDir, guard);
  await waitFor('target-cover-authenticated-and-committed', () => {
    const current = userReplica(target).state.accounts.get(hub);
    const delta = current?.state.deltas.get(1);
    if (!current || !delta || current.pendingFrame || current.mempool.length) return false;
    const view = deriveDelta(delta, isLeftEntity(target.entityId, hub));
    return view.outCollateral === net && view.outPeerCredit === 0n && current.state.requestedRebalance.size === 0;
  });
  const observed = await targetSnapshot(target, hub, contracts);
  if (observed.collateral !== net || observed.activeDebts !== 0n || observed.hubActiveDebts !== 0n) {
    throw new Error('USDC_POC_COVER_CHAIN_ACCOUNTING_MISMATCH');
  }
  return {
    gross,
    fee,
    net,
    policy,
    signedSnapshot: snapshot,
    tariffProof,
    bilateral: await verifyHubCommit(target, hub, workDir),
    observed,
  };
};

export const withdrawTargetCollateral = async (target: PocUser, hub: string, amount: bigint) => {
  const receivingEntity = zeroPadValue(target.signerId, 32).toLowerCase();
  send(target, [
    {
      type: 'settle_propose',
      data: {
        counterpartyEntityId: hub,
        executorIsLeft: isLeftEntity(target.entityId, hub),
        memo: 'asset-c2r',
        ops: [{ type: 'c2r', tokenId: 1, amount }],
        continuation: { broadcast: true, actions: [{ type: 'r2e', receivingEntity, tokenId: 1, amount }] },
      },
    },
  ]);
  await waitFor('target-account-to-external-finalized', () => {
    const replica = userReplica(target);
    const account = replica.state.accounts.get(hub);
    const delta = account?.state.deltas.get(1);
    if (!account || !delta) return false;
    const view = deriveDelta(delta, isLeftEntity(target.entityId, hub));
    return (
      view.outCollateral === 0n &&
      view.outPeerCredit === 0n &&
      !account.state.settlementWorkspace &&
      !account.pendingFrame &&
      !account.mempool.length &&
      !account.state.pulls?.size &&
      !replica.state.jBatchState?.sentBatch &&
      !replica.state.settlementContinuations?.size &&
      replica.state.reserves.get(1) === 0n
    );
  });
};

export const executeExternalPayout = async (
  user: PocUser,
  sourceHub: string,
  swap: Awaited<ReturnType<typeof executeCrossSwap>>,
  apiBase: string,
  workDir: string,
  guard?: CoverGuard,
) => {
  const target = targetUser(user, apiBase);
  if (target.entityId !== swap.targetEntityId) throw new Error('USDC_POC_TARGET_MISSING');
  const contracts = await targetContracts(target);
  try {
    const before = await targetSnapshot(target, swap.targetHubEntityId, contracts);
    if (
      before.reserve !== 0n ||
      before.collateral !== 0n ||
      before.account.view.outPeerCredit !== swap.grossTargetAmount
    )
      throw new Error('USDC_POC_TARGET_INITIAL_POSITION_INVALID');
    const cover = await coverClaim(target, swap.targetHubEntityId, swap.grossTargetAmount, contracts, workDir, guard);
    if ((getOpenOutgoingDebtTotals(userReplica(target).state.outDebtsByToken).get(1) ?? 0n) !== 0n) {
      throw new Error('USDC_POC_RESERVE_DEBT_BLOCKS_WITHDRAWAL');
    }
    await withdrawTargetCollateral(target, swap.targetHubEntityId, cover.net);
    const bilateral = await verifyHubCommit(target, swap.targetHubEntityId, workDir);
    const sourceBilateral = await verifyHubCommit(user, sourceHub, workDir);
    const after = await targetSnapshot(target, swap.targetHubEntityId, contracts);
    const paid = after.token - before.token;
    const source = userReplica(user).state.accounts.get(sourceHub);
    if (!source || source.state.pulls?.size || source.state.settlementWorkspace)
      throw new Error('USDC_POC_SOURCE_NOT_DRAINED');
    if (
      paid !== cover.net ||
      paid < 850_000n ||
      swap.sourceAmount - paid > 150_000n ||
      after.reserve !== 0n ||
      after.collateral !== 0n ||
      after.activeDebts !== 0n ||
      after.hubReserve !== before.hubReserve - paid ||
      after.depositoryTokens !== before.depositoryTokens - paid
    )
      throw new Error('USDC_POC_EXTERNAL_PAYOUT_MISMATCH');
    return {
      status: 'complete',
      recipient: target.signerId,
      targetEntityId: target.entityId,
      targetHubEntityId: swap.targetHubEntityId,
      fee: cover.fee,
      sourceAmount: swap.sourceAmount,
      grossTargetAmount: swap.grossTargetAmount,
      paid,
      sourceToPayoutDifference: swap.sourceAmount - paid,
      cover,
      before,
      after,
      bilateral,
      sourceBilateral,
      externalPayout: true,
    };
  } finally {
    contracts.provider.destroy();
  }
};
