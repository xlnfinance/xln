export interface RebalancePolicyUsd {
  softLimit: number;
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
  const softLimit = sanitizeUsdInt(raw['softLimit']);
  const hardLimit = sanitizeUsdInt(raw['hardLimit']);
  const maxFee = sanitizeUsdInt(raw['maxFee']);
  if (softLimit === null || hardLimit === null || maxFee === null) return undefined;
  if (softLimit <= 0 || hardLimit < softLimit) return undefined;
  return { softLimit, hardLimit, maxFee };
};
