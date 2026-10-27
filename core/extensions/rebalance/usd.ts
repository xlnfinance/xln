import { rejectFailure } from '../../protocol/errors/failure-taxonomy';

export interface RebalancePolicyUsd {
  r2cRequestSoftLimit: number;
  hardLimit: number;
  maxFee: number;
}

const requireUsdInt = (value: unknown, field: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw rejectFailure('REBALANCE_POLICY_USD_INVALID', `REBALANCE_POLICY_USD_INVALID:${field}`);
  }
  return value;
};

export const parseRebalancePolicyUsd = (value: unknown): RebalancePolicyUsd | undefined => {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw rejectFailure('REBALANCE_POLICY_USD_INVALID');
  }
  const raw = value as Record<string, unknown>;
  const r2cRequestSoftLimit = requireUsdInt(raw['r2cRequestSoftLimit'], 'r2cRequestSoftLimit');
  const hardLimit = requireUsdInt(raw['hardLimit'], 'hardLimit');
  const maxFee = requireUsdInt(raw['maxFee'], 'maxFee');
  if (r2cRequestSoftLimit <= 0 || hardLimit < r2cRequestSoftLimit) {
    throw rejectFailure('REBALANCE_POLICY_USD_INVALID', 'REBALANCE_POLICY_USD_INVALID:limits');
  }
  return { r2cRequestSoftLimit, hardLimit, maxFee };
};
