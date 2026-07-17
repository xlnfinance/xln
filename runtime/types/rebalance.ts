/** Hub-level config: rebalance strategy + routing fees. Set via setHubConfig EntityTx. */
export interface HubRebalanceConfig {
  hubName?: string;
  matchingStrategy: 'amount' | 'time' | 'fee';
  policyVersion: number;
  routingFeePPM: number;
  baseFee: bigint;
  swapTakerFeeBps?: number;
  disputeAutoFinalizeMode?: 'auto' | 'ignore';
  minCollateralThreshold?: bigint;
  c2rWithdrawSoftLimit?: bigint;
  minFeeBps?: bigint;
  rebalanceBaseFee?: bigint;
  rebalanceLiquidityFeeBps?: bigint;
  rebalanceGasFee?: bigint;
  rebalanceTimeoutMs?: number;
}

/** Per-token rebalance policy (stored per-token in AccountMachine). */
export interface RebalancePolicy {
  r2cRequestSoftLimit: bigint;
  hardLimit: bigint;
  maxAcceptableFee: bigint;
  setByLeft?: boolean;
}

/** Exact fee terms advertised by one Account side in a committed Account frame. */
export interface RebalanceFeePolicySnapshot {
  policyVersion: number;
  baseFee: bigint;
  liquidityFeeBps: bigint;
  gasFee: bigint;
  updatedAt: number;
}

/** Bilateral policy register for one token. Authority is the Account frame side. */
export interface BilateralRebalanceFeePolicy {
  left?: RebalanceFeePolicySnapshot;
  right?: RebalanceFeePolicySnapshot;
}

/** Active rebalance quote (one per account, quoteId = env.timestamp). */
export interface RebalanceQuote {
  quoteId: number;
  tokenId: number;
  amount: bigint;
  feeTokenId: number;
  feeAmount: bigint;
  accepted: boolean;
}

/** Fee state for request_collateral (fee is prepaid in requester frame). */
export interface RebalanceRequestFeeState {
  feeTokenId: number;
  feePaidUpfront: bigint;
  requestedAmount: bigint;
  policyVersion: number;
  requestedAt: number;
  requestedByLeft: boolean;
}

export interface AccountRebalanceShadowState {
  policy: Map<number, RebalancePolicy>;
  submittedAtByToken: Map<number, number>;
  activeQuote?: RebalanceQuote;
  pendingRequest?: { tokenId: number; targetAmount: bigint };
}

export const REFERENCE_TOKEN_ID = 1;
export const DEFAULT_SOFT_LIMIT_WHOLE = 500n;
export const DEFAULT_HARD_LIMIT_WHOLE = 10_000n;
export const DEFAULT_MAX_FEE_WHOLE = 15n;
export const QUOTE_EXPIRY_MS = 300_000;

const requireTokenDecimals = (value: number): bigint => {
  if (!Number.isSafeInteger(value) || value < 0 || value > 255) {
    throw new Error(`TOKEN_DECIMALS_INVALID:${String(value)}`);
  }
  return BigInt(value);
};

export const scaleWholeTokenAmount = (amount: bigint, decimals: number): bigint =>
  amount * 10n ** requireTokenDecimals(decimals);

export const scaleRawTokenAmount = (
  amount: bigint,
  sourceDecimals: number,
  targetDecimals: number,
): bigint => {
  const source = requireTokenDecimals(sourceDecimals);
  const target = requireTokenDecimals(targetDecimals);
  if (source === target) return amount;
  if (target > source) return amount * 10n ** (target - source);
  const divisor = 10n ** (source - target);
  if (amount % divisor !== 0n) {
    throw new Error(`TOKEN_AMOUNT_PRECISION_LOSS:${amount}:${sourceDecimals}:${targetDecimals}`);
  }
  return amount / divisor;
};

export const buildDefaultRebalancePolicy = (decimals: number): RebalancePolicy => ({
  r2cRequestSoftLimit: scaleWholeTokenAmount(DEFAULT_SOFT_LIMIT_WHOLE, decimals),
  hardLimit: scaleWholeTokenAmount(DEFAULT_HARD_LIMIT_WHOLE, decimals),
  maxAcceptableFee: scaleWholeTokenAmount(DEFAULT_MAX_FEE_WHOLE, decimals),
});

export const buildDefaultRebalanceBaseFee = (decimals: number): bigint => {
  const normalized = requireTokenDecimals(decimals);
  if (normalized === 0n) throw new Error('TOKEN_AMOUNT_PRECISION_UNREPRESENTABLE:0.1:0');
  return 10n ** (normalized - 1n);
};
