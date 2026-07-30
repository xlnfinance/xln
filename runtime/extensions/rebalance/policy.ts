export interface RebalancePolicySnapshot {
  policyVersion: number;
  baseFee: bigint;
  liquidityFeeBps: bigint;
  gasFee: bigint;
}

export type RebalanceMatchingStrategy = 'amount' | 'time' | 'fee';

const PREFIX = 'rebalance-policy:';

export function normalizeRebalanceMatchingStrategy(
  strategy: unknown,
): RebalanceMatchingStrategy {
  return strategy === 'time' || strategy === 'fee' ? strategy : 'amount';
}

export function encodeRebalancePolicyMemo(reason: string, snapshot: RebalancePolicySnapshot): string {
  return (
    `${PREFIX}` +
    `reason=${reason};` +
    `v=${snapshot.policyVersion};` +
    `base=${snapshot.baseFee.toString()};` +
    `liq=${snapshot.liquidityFeeBps.toString()};` +
    `gas=${snapshot.gasFee.toString()}`
  );
}
