/**
 * Set Rebalance Policy Handler
 * User configures per-token auto-rebalance thresholds
 * See docs/rebalance.md for full spec
 */

import type { AccountMachine, AccountTx } from '../../types';

export function handleSetRebalancePolicy(
  accountMachine: AccountMachine,
  accountTx: Extract<AccountTx, { type: 'set_rebalance_policy' }>
): { success: boolean; events: string[]; error?: string } {
  const { tokenId, softLimit, hardLimit, maxAcceptableFee } = accountTx.data;

  if (softLimit > hardLimit) {
    return { success: false, events: [], error: 'softLimit must be <= hardLimit' };
  }
  if (maxAcceptableFee < 0n) {
    return { success: false, events: [], error: 'maxAcceptableFee must be >= 0' };
  }

  accountMachine.rebalancePolicy.set(tokenId, { softLimit, hardLimit, maxAcceptableFee });

  const mode = softLimit === hardLimit ? 'manual' : 'absolute';
  return {
    success: true,
    events: [`🔄 Rebalance policy set for token ${tokenId}: ${mode} mode, soft=${softLimit}, hard=${hardLimit}, maxFee=${maxAcceptableFee}`],
  };
}
