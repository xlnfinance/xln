import { effectiveRebalanceTerms } from '../../../account/config/term-notice';
import { resolveAccountProposalTimestamp } from '../../../account/consensus/proposal/admission';
import { rebalanceFeeFor } from '../../../account/tx/handlers/rebalance/request-collateral';
import { getWallClockMs } from '../../../support/time';
import type { AccountReplica } from '../../../types/account';
import type { RebalanceFeeTerms } from '../../../types/finance/rebalance';

export const readPocPayoutTimestamp = (runtimeTimestamp: number): number =>
  Math.max(runtimeTimestamp, getWallClockMs());

const pricePayout = (policy: RebalanceFeeTerms, gross: bigint) => {
  const fee = rebalanceFeeFor(policy, gross);
  const net = gross - fee;
  if (fee <= 0n || net < 850_000n)
    throw new Error(`USDC_POC_NET_PAYOUT_BELOW_MINIMUM:gross=${gross}:fee=${fee}:net=${net}`);
  if (net > 1_000_000n) throw new Error(`USDC_POC_NET_PAYOUT_ABOVE_MAXIMUM:net=${net}`);
  return { fee, net };
};

export const requirePayoutTerms = (
  account: AccountReplica,
  userIsLeft: boolean,
  gross: bigint,
  proposedAt: number,
  validThrough = proposedAt,
) => {
  const snapshot = account.state.rebalanceFeePolicies?.get(1)?.[userIsLeft ? 'right' : 'left'];
  if (!snapshot) throw new Error('USDC_POC_SIGNED_TARIFF_MISSING');
  const timestamp = resolveAccountProposalTimestamp(proposedAt, account.currentFrame.timestamp);
  const policy = effectiveRebalanceTerms(snapshot, timestamp);
  const payout = pricePayout(policy, gross);
  // A committed future tariff can take effect between Cross-J and cover
  // even while this Account frame and its signature remain unchanged.
  const endPolicy = effectiveRebalanceTerms(snapshot, Math.max(timestamp, validThrough));
  const endNet = policy === endPolicy ? payout.net : pricePayout(endPolicy, gross).net;
  const backingRequired = endNet > payout.net ? endNet : payout.net;
  return { snapshot, policy, ...payout, backingRequired };
};
