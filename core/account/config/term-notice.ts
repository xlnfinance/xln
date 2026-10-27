/**
 * N1/N2: adverse effectiveAt = announcement + activeNoticeMs + networkAllowanceMs; admit iff effectiveAt >= receiverTime + activeNoticeMs.
 * N3: Both sides execute the signed frame identically; receiver time gates
 * admission only and never changes committed terms, deadlines or state roots.
 */
import type { RebalanceFeePolicySnapshot, RebalanceFeeTerms } from '../../types/finance/rebalance';
import { ACCOUNT_NETWORK_ALLOWANCE_MS } from '../consensus/constants';

export const DEFAULT_TERM_NOTICE_SECONDS = 30 * 24 * 60 * 60;

export const validTermNoticeSeconds = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 1 && Number.isSafeInteger(value * 1000);

/** Any increased component can hurt a customer, even if another fee falls. */
export const worseRebalanceTerms = (previous: RebalanceFeeTerms, next: RebalanceFeeTerms): boolean =>
  next.baseFee > previous.baseFee || next.gasFee > previous.gasFee || next.liquidityFeeBps > previous.liquidityFeeBps;

/** Accepted signed frame time selects terms identically on both sides and after recovery. */
export const effectiveRebalanceTerms = (policy: RebalanceFeePolicySnapshot, timestamp: number) =>
  policy.previous && timestamp < policy.effectiveAt ? policy.previous : policy;

/** Shared by the transition and speculative receiver admission; never reads a local clock. */
export const announcedRebalancePolicy = (
  current: RebalanceFeePolicySnapshot | undefined,
  terms: RebalanceFeeTerms & { noticePeriodSeconds: number },
): RebalanceFeePolicySnapshot => {
  const active = current && effectiveRebalanceTerms(current, terms.updatedAt);
  const worse = active && (worseRebalanceTerms(active, terms) || terms.noticePeriodSeconds < active.noticePeriodSeconds);
  return {
    ...terms,
    effectiveAt: terms.updatedAt + (worse ? active.noticePeriodSeconds * 1000 + ACCOUNT_NETWORK_ALLOWANCE_MS : 0),
    ...(worse ? { previous: {
      policyVersion: active.policyVersion,
      baseFee: active.baseFee,
      liquidityFeeBps: active.liquidityFeeBps,
      gasFee: active.gasFee,
      updatedAt: active.updatedAt,
      noticePeriodSeconds: active.noticePeriodSeconds,
    } } : {}),
  };
};
