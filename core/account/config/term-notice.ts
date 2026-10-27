import type { RebalanceFeePolicySnapshot, RebalanceFeeTerms } from '../../types/finance/rebalance';

export const DEFAULT_TERM_NOTICE_SECONDS = 30 * 24 * 60 * 60;

export const validTermNoticeSeconds = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 1 && Number.isSafeInteger(value * 1000);

/** Any increased component can hurt a customer, even if another fee falls. */
export const worseRebalanceTerms = (previous: RebalanceFeeTerms, next: RebalanceFeeTerms): boolean =>
  next.baseFee > previous.baseFee || next.gasFee > previous.gasFee || next.liquidityFeeBps > previous.liquidityFeeBps;

/** The signed frame clock is the sole activation authority, including after recovery. */
export const effectiveRebalanceTerms = (policy: RebalanceFeePolicySnapshot, timestamp: number) =>
  policy.previous && timestamp < policy.effectiveAt ? policy.previous : policy;
