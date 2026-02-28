/**
 * Set Rebalance Policy Handler
 * User configures per-token auto-rebalance thresholds
 * See docs/rebalance.md for full spec
 *
 * AUTH: maxAcceptableFee can only be set by the fee-payer (non-Hub side).
 *       If the opposite side (Hub) tries to change maxAcceptableFee,
 *       the existing value is preserved. r2cRequestSoftLimit/hardLimit can be set
 *       by either side (both benefit from collateral).
 */

import type { AccountMachine, AccountTx } from '../../types';

export function handleSetRebalancePolicy(
  accountMachine: AccountMachine,
  accountTx: Extract<AccountTx, { type: 'set_rebalance_policy' }>,
  byLeft?: boolean
): { success: boolean; events: string[]; error?: string } {
  const { tokenId, r2cRequestSoftLimit, hardLimit, maxAcceptableFee } = accountTx.data;

  if (r2cRequestSoftLimit > hardLimit) {
    return { success: false, events: [], error: 'r2cRequestSoftLimit must be <= hardLimit' };
  }
  if (maxAcceptableFee < 0n) {
    return { success: false, events: [], error: 'maxAcceptableFee must be >= 0' };
  }

  const existing = accountMachine.rebalancePolicy.get(tokenId);

  // AUTH: maxAcceptableFee is only writable by the original setter.
  // If a policy was previously set by one side, the other side cannot change maxAcceptableFee.
  // This prevents Hub from silently raising the user's fee ceiling.
  let effectiveFee = maxAcceptableFee;
  if (existing?.setByLeft !== undefined && byLeft !== undefined && existing.setByLeft !== byLeft) {
    effectiveFee = existing.maxAcceptableFee;
    console.log(`🔒 POLICY-AUTH: maxAcceptableFee preserved (set by ${existing.setByLeft ? 'LEFT' : 'RIGHT'}, caller is ${byLeft ? 'LEFT' : 'RIGHT'})`);
  }

  const policy: { r2cRequestSoftLimit: bigint; hardLimit: bigint; maxAcceptableFee: bigint; setByLeft?: boolean } = {
    r2cRequestSoftLimit,
    hardLimit,
    maxAcceptableFee: effectiveFee,
  };
  if (byLeft !== undefined) policy.setByLeft = byLeft;
  accountMachine.rebalancePolicy.set(tokenId, policy);

  const mode = r2cRequestSoftLimit === hardLimit ? 'manual' : 'absolute';
  return {
    success: true,
    events: [`🔄 Rebalance policy set for token ${tokenId}: ${mode} mode, soft=${r2cRequestSoftLimit}, hard=${hardLimit}, maxFee=${effectiveFee}`],
  };
}
