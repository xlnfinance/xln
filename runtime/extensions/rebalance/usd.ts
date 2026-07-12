export interface RebalancePolicyUsd {
  r2cRequestSoftLimit: number;
  hardLimit: number;
  maxFee: number;
}

const sanitizeUsdInt = (value: unknown): number | null => {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.max(0, Math.floor(num));
};

export const parseRebalancePolicyUsd = (value: unknown): RebalancePolicyUsd | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const r2cRequestSoftLimit = sanitizeUsdInt(raw['r2cRequestSoftLimit']);
  const hardLimit = sanitizeUsdInt(raw['hardLimit']);
  const maxFee = sanitizeUsdInt(raw['maxFee']);
  if (r2cRequestSoftLimit === null || hardLimit === null || maxFee === null) return undefined;
  if (r2cRequestSoftLimit <= 0 || hardLimit < r2cRequestSoftLimit) return undefined;
  return { r2cRequestSoftLimit, hardLimit, maxFee };
};
