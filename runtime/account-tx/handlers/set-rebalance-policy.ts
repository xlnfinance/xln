/**
 * Set Rebalance Policy Handler
 * User configures per-token auto-rebalance thresholds
 * See docs/rebalance.md for full spec
 *
 * AUTH: maxAcceptableFee can only be set by the fee-payer (non-Hub side).
 *       softLimit/hardLimit can be set by either side (both benefit from collateral).
 *       setByLeft tracks who set the policy for auto-accept verification.
 */

import type { AccountMachine, AccountTx } from '../../types';

export function handleSetRebalancePolicy(
  accountMachine: AccountMachine,
  accountTx: Extract<AccountTx, { type: 'set_rebalance_policy' }>,
  byLeft?: boolean
): { success: boolean; events: string[]; error?: string } {
  const { tokenId, softLimit, hardLimit, maxAcceptableFee } = accountTx.data;

  if (softLimit > hardLimit) {
    return { success: false, events: [], error: 'softLimit must be <= hardLimit' };
  }
  if (maxAcceptableFee < 0n) {
    return { success: false, events: [], error: 'maxAcceptableFee must be >= 0' };
  }

  const existing = accountMachine.rebalancePolicy.get(tokenId);
  const policy: { softLimit: bigint; hardLimit: bigint; maxAcceptableFee: bigint; setByLeft?: boolean } = {
    softLimit,
    hardLimit,
    maxAcceptableFee,
  };
  if (byLeft !== undefined) policy.setByLeft = byLeft;
  accountMachine.rebalancePolicy.set(tokenId, policy);

  const mode = softLimit === hardLimit ? 'manual' : 'absolute';
  return {
    success: true,
    events: [`🔄 Rebalance policy set for token ${tokenId}: ${mode} mode, soft=${softLimit}, hard=${hardLimit}, maxFee=${maxAcceptableFee}`],
  };
}
