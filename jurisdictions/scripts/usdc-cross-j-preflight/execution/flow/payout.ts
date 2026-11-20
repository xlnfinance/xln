import { executeExternalPayout } from '../../../../../core/scenarios/usdc-poc/external-payout';
import { resumeCrossSwap } from '../../../../../core/scenarios/usdc-poc/cross-swap';
import { targetUser } from '../../../../../core/scenarios/usdc-poc/journey/context';
import { resumePayout } from '../../../../../core/scenarios/usdc-poc/recovery/payout';
import { userReplica, type PocUser } from '../../../../../core/scenarios/usdc-poc/user';
import type { CoverGuard } from '../../../../../core/scenarios/usdc-poc/journey/cover';
import type { ExecutionAuthority } from '../authority';
import { readNonceReceipt } from '../nonce-receipt';
import { historicalRpc, type ExecutionProviders } from '../providers';

export const finishPayout = async (
  user: PocUser,
  authority: ExecutionAuthority,
  runIndex: number,
  provider: ExecutionProviders,
  guard: CoverGuard,
): Promise<void> => {
  const chain = authority.chains[1]!;
  const target = targetUser(user, authority.apiBase);
  const account = userReplica(target).state.accounts.get(chain.hubEntity);
  if (!account) throw new Error('USDC_EXECUTION_TARGET_ACCOUNT_MISSING');
  const coverStarted =
    account.state.requestedRebalanceFeeState.size > 0 ||
    account.state.requestedRebalance.size > 0 ||
    account.state.deltas.get(1)!.collateral > 0n ||
    Boolean(account.state.settlementWorkspace) ||
    (userReplica(target).state.settlementContinuations?.size ?? 0) > 0 ||
    Boolean(userReplica(target).state.jBatchState?.sentBatch);
  if (!coverStarted) {
    const swap = await resumeCrossSwap(user, authority.chains[0]!.hubEntity, authority.apiBase, '');
    await executeExternalPayout(user, authority.chains[0]!.hubEntity, swap, authority.apiBase, '', guard);
    return;
  }
  const hub = chain.payers.find(payer => payer.role === 'target-hub')!;
  const cover = await readNonceReceipt(provider, chain, hub, hub.firstNonce + runIndex);
  const { targetContracts } = await import('../../../../../core/scenarios/usdc-poc/target-evidence');
  const contracts = await targetContracts(target, historicalRpc(authority.apiBase, chain.chainId));
  try {
    const baseline = cover
      ? await contracts.token.balanceOf(target.signerId, { blockTag: cover.receipt.blockNumber - 1 })
      : await contracts.token.balanceOf(target.signerId);
    await resumePayout(user, authority.apiBase, '', baseline);
  } finally {
    contracts.provider.destroy();
  }
};
