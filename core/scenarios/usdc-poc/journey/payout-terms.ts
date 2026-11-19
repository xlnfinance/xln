import { effectiveRebalanceTerms } from '../../../account/config/term-notice';
import { rebalanceFeeFor } from '../../../account/tx/handlers/rebalance/request-collateral';
import type { AccountReplica } from '../../../types/account';

export const requirePayoutTerms = (account: AccountReplica, userIsLeft: boolean, gross: bigint) => {
  const snapshot = account.state.rebalanceFeePolicies?.get(1)?.[userIsLeft ? 'right' : 'left'];
  if (!snapshot) throw new Error('USDC_POC_SIGNED_TARIFF_MISSING');
  const policy = effectiveRebalanceTerms(snapshot, account.currentFrame.timestamp);
  const fee = rebalanceFeeFor(policy, gross);
  const net = gross - fee;
  if (fee <= 0n || net < 850_000n)
    throw new Error(`USDC_POC_NET_PAYOUT_BELOW_MINIMUM:gross=${gross}:fee=${fee}:net=${net}`);
  return { snapshot, policy, fee, net };
};
