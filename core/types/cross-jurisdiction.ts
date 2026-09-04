// Only statuses with a live production writer belong here. The pre-book lock
// states and the per-leg claimed states were vestigial: every real terminal
// transition is driven by the Hub-authored atomic Account close or by dispute
// finality, never by a per-leg claim flag.
export type CrossJurisdictionSwapStatus =
  | 'intent'
  | 'target_prepared'
  | 'resting'
  | 'partially_filled'
  | 'clear_requested'
  | 'clearing'
  | 'settled'
  | 'cancelled'
  | 'expired';

export interface CrossJurisdictionSwapLeg {
  jurisdiction: string;
  entityId: string;
  counterpartyEntityId: string;
  tokenId: number;
  amount: bigint;
}

export interface CrossJurisdictionPullLeg {
  pullId: string;
  tokenId: number;
  amount: bigint;
  signedAmount: bigint;
  fullHash: string;
  partialRoot: string;
}

interface CrossJurisdictionDisputeConfig {
  leftResponseSeconds: number;
  rightResponseSeconds: number;
}

type CrossJurisdictionBookLeg = 'source' | 'target';

export type CrossJurisdictionBookStatus =
  | 'pending'
  | 'admitted'
  | 'resolving'
  | 'closed';

export interface CrossJurisdictionCloseProof {
  orderId: string;
  routeHash: string;
  sourcePullId: string;
  targetPullId: string;
  fillRatio: number;
  cumulativeSourceAmount: bigint;
  cumulativeTargetAmount: bigint;
  binaryHash: string;
  closeMode: 'full' | 'partial_cancel_remainder' | 'pure_cancel';
}

export interface CrossJurisdictionRouteDomain {
  protocol: 'xln-cross-j';
  hashSchema: 'route-domain';
  sourceStackId: string;
  targetStackId: string;
  sourceEntityProviderAddress?: string;
  targetEntityProviderAddress?: string;
  sourceDeltaTransformerAddress?: string;
  targetDeltaTransformerAddress?: string;
  sourceAssetRef: string;
  targetAssetRef: string;
}

export interface CrossJurisdictionTimePolicy {
  runtimeClock: 'unix_ms';
  settlementClock: 'unix_seconds';
  deadlineConversion: 'floor_ms_to_unix_seconds';
  runtimeExpiresAtMs: number;
  finalityPolicy: 'independent_beneficiary_windows_pull_sum_finality';
}

/** Opening-time binding of a pull to its route; fill progress never reaches it. */
export interface CrossJurisdictionPullBinding {
  orderId: string;
  routeHash: string;
  leg: CrossJurisdictionBookLeg;
  status?: CrossJurisdictionSwapStatus;
}

export interface CrossJurisdictionBookAdmission {
  orderId: string;
  routeHash: string;
  sourceEntityId: string;
  bookOwnerEntityId: string;
  status: CrossJurisdictionBookStatus;
  route: CrossJurisdictionSwapRoute;
  admittedAt?: number;
  resolvingAt?: number;
  closedAt?: number;
  closeReason?: string;
  updatedAt: number;
}

export interface CrossJurisdictionSwapRoute {
  orderId: string;
  routeHash?: string;
  bookOwnerEntityId?: string;
  venueId?: string;
  sourceSignerId?: string;
  sourceHubSignerId?: string;
  targetHubSignerId?: string;
  targetSignerId?: string;
  bookHubSignerId?: string;
  makerEntityId: string;
  hubEntityId: string;
  source: CrossJurisdictionSwapLeg;
  target: CrossJurisdictionSwapLeg;
  /** Signed Account-clock snapshots; both are committed by routeHash. */
  sourceDisputeConfig: CrossJurisdictionDisputeConfig;
  targetDisputeConfig: CrossJurisdictionDisputeConfig;
  sourcePull?: CrossJurisdictionPullLeg;
  targetPull?: CrossJurisdictionPullLeg;
  sourceCloseProof?: CrossJurisdictionCloseProof;
  targetCloseProof?: CrossJurisdictionCloseProof;
  priceTicks?: bigint;
  fillSeq?: number;
  cumulativeFillRatio?: number; // Coarse 0-65535 ratio; this is the on-chain uint16 dispute form.
  fillNumerator?: bigint;
  fillDenominator?: bigint;
  filledSourceAmount?: bigint;
  filledTargetAmount?: bigint;
  pendingClearRequestedAt?: number;
  domain?: CrossJurisdictionRouteDomain;
  timePolicy?: CrossJurisdictionTimePolicy;
  clearingPolicy?: 'manual' | 'full_fill' | 'cancel_and_clear';
  riskMode?: 'fully_collateralized' | 'partially_collateralized' | 'credit_line' | 'unsecured_internalized';
  claimedRatio?: number;
  /** Sticky ratio from this entity's single-shot Source registry slot. */
  sourceRegistryFillRatio?: number;
  /** Latest ratio from this entity's replaceable Target registry slot. */
  targetRegistryFillRatio?: number;
  /** Raw finalized Source record; settlement validity is dispute-relative. */
  sourceRegistryRecord?: {
    fillRatio: number;
    revealedAt: number;
  };
  /** Raw finalized Target record, including deliberately stored late writes. */
  targetRegistryRecord?: {
    fillRatio: number;
    revealedAt: number;
  };
  /** First source reveal waiting for the current J-batch to clear. */
  pendingSourceRegistryReveal?: {
    fillRatio: number;
    fullSecret: string;
    reveals: [string, string, string, string];
  };
  /** Latest target port waiting for the current J-batch to clear. */
  pendingTargetRegistryReveal?: {
    fillRatio: number;
    fullSecret: string;
    reveals: [string, string, string, string];
  };
  sourceClaimed?: bigint;
  targetClaimed?: bigint;
  status: CrossJurisdictionSwapStatus;
  createdAt: number;
  updatedAt: number;
  expiresAt?: number;
  settledAt?: number;
  error?: string;
  memo?: string;
}
