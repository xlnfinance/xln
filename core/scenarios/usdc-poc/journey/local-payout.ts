import { executeExternalPayout } from '../external-payout';
import { requireWithdrawalTransfers, targetContracts, targetReceipts } from '../target-evidence';
import type { PocUser } from '../user';
import type { executeCrossSwap } from '../cross-swap';
import { targetUser } from './context';

export const executeLocalPayout = async (
  user: PocUser,
  sourceHub: string,
  swap: Awaited<ReturnType<typeof executeCrossSwap>>,
  apiBase: string,
  workDir: string,
) => {
  const payout = await executeExternalPayout(user, sourceHub, swap, apiBase, workDir);
  const target = targetUser(user, apiBase);
  const contracts = await targetContracts(target);
  try {
    const evidence = await targetReceipts(contracts, payout.before.block.number + 1, payout.after.block.number, [
      target.entityId,
      payout.targetHubEntityId,
    ]);
    const tokenTransfers = requireWithdrawalTransfers(contracts, evidence, target.signerId, payout.paid);
    return { ...payout, evidence, tokenTransfers };
  } finally {
    contracts.provider.destroy();
  }
};
