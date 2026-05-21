/** Hub-level config: rebalance strategy + routing fees. Set via setHubConfig EntityTx. */
export interface HubRebalanceConfig {
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
  jBatchSubmittedAt: number;
}

// Rebalance constants (all amounts in 18-decimal base, matching TOKEN_REGISTRY).
export const REFERENCE_TOKEN_ID = 1;
export const DEFAULT_SOFT_LIMIT = 500n * 10n ** 18n;
export const DEFAULT_HARD_LIMIT = 10_000n * 10n ** 18n;
export const DEFAULT_MAX_FEE = 15n * 10n ** 18n;
export const QUOTE_EXPIRY_MS = 300_000;
