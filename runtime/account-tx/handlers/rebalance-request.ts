/**
 * Rebalance Request Handler
 * User manually requests rebalance (asks hub for a quote)
 * See docs/rebalance.md for full spec
 */

import type { AccountMachine, AccountTx } from '../../types';

export function handleRebalanceRequest(
  accountMachine: AccountMachine,
  accountTx: Extract<AccountTx, { type: 'rebalance_request' }>
): { success: boolean; events: string[]; error?: string } {
  const { tokenId, targetAmount } = accountTx.data;

  if (targetAmount <= 0n) {
    return { success: false, events: [], error: 'targetAmount must be > 0' };
  }

  // Check hardLimit if policy exists
  const policy = accountMachine.rebalancePolicy.get(tokenId);
  if (policy && targetAmount > policy.hardLimit) {
    return { success: false, events: [], error: `targetAmount ${targetAmount} exceeds hardLimit ${policy.hardLimit}` };
  }

  accountMachine.pendingRebalanceRequest = { tokenId, targetAmount };

  return {
    success: true,
    events: [`🔄 Rebalance requested: ${targetAmount} token ${tokenId} (awaiting hub quote)`],
  };
}
