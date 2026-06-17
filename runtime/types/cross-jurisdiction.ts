export type CrossJurisdictionSwapStatus =
  | 'intent'
  | 'target_prepared'
  | 'source_committed'
  | 'resting'
  | 'partially_filled'
  | 'clear_requested'
  | 'clearing'
  | 'target_locked'
  | 'source_locked'
  | 'source_claimed'
  | 'target_claimed'
  | 'settled'
  | 'cancelled'
  | 'expired'
  | 'failed';

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
  revealedUntilTimestamp: number;
  fullHash: string;
  partialRoot: string;
}

export type CrossJurisdictionBookLeg = 'source' | 'target';

export type CrossJurisdictionBookStatus =
  | 'pending'
  | 'admitted'
  | 'resolving'
  | 'closed';

export interface CrossJurisdictionPendingFill {
  fillId: string;
  receiptHash: string;
  ackKind: 'fill' | 'cancel';
  fillSeq: number;
  previousFillSeq?: number;
  cumulativeFillRatio: number;
  cumulativeSourceAmount: bigint;
  cumulativeTargetAmount: bigint;
  fillNumerator?: bigint;
  fillDenominator?: bigint;
  routeHash: string;
  updatedAt: number;
  firstSeenAt: number;
  ttlExpiredAt?: number;
}

export interface CrossJurisdictionBookAdmissionReceipt {
  receiptHash: string;
  leg: CrossJurisdictionBookLeg;
  orderId: string;
  routeHash: string;
  hubEntityId: string;
  counterpartyEntityId: string;
  pullId: string;
  tokenId: number;
  signedAmount: bigint;
  revealedUntilTimestamp: number;
  fullHash: string;
  partialRoot: string;
  committedAt: number;
}

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

export interface CrossJurisdictionSettlementPolicy {
  roundingMode: 'uint16_ceil';
  maxSourceDust: bigint;
  maxTargetDust: bigint;
  minSourceFillAmount?: bigint;
  minTargetFillAmount?: bigint;
}

export interface CrossJurisdictionTimePolicy {
  runtimeClock: 'unix_ms';
  settlementClock: 'unix_seconds';
  deadlineConversion: 'floor_ms_to_unix_seconds';
  runtimeExpiresAtMs: number;
  finalityPolicy: 'source_deadline_then_target_safety';
}

export interface CrossJurisdictionPullBinding {
  orderId: string;
  routeHash: string;
  leg: CrossJurisdictionBookLeg;
  targetReceipt?: CrossJurisdictionBookAdmissionReceipt;
  sourceCloseProof?: CrossJurisdictionCloseProof;
  status?: CrossJurisdictionSwapStatus;
  cumulativeFillRatio?: number;
  claimedRatio?: number;
  filledSourceAmount?: bigint;
  filledTargetAmount?: bigint;
  sourceClaimed?: bigint;
  targetClaimed?: bigint;
  clearingPolicy?: 'manual' | 'cancel_and_clear' | 'full_fill';
}

export interface CrossJurisdictionBookAdmission {
  orderId: string;
  routeHash: string;
  sourceEntityId: string;
  bookOwnerEntityId: string;
  status: CrossJurisdictionBookStatus;
  route: CrossJurisdictionSwapRoute;
  sourceReceipt?: CrossJurisdictionBookAdmissionReceipt;
  targetReceipt?: CrossJurisdictionBookAdmissionReceipt;
  admittedAt?: number;
  resolvingAt?: number;
  closedAt?: number;
  closeReason?: string;
  pendingFill?: CrossJurisdictionPendingFill;
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
  sourcePull?: CrossJurisdictionPullLeg;
  targetPull?: CrossJurisdictionPullLeg;
  targetReceipt?: CrossJurisdictionBookAdmissionReceipt;
  sourceCloseProof?: CrossJurisdictionCloseProof;
  targetCloseProof?: CrossJurisdictionCloseProof;
  priceTicks?: bigint;
  fillSeq?: number;
  cumulativeFillRatio?: number; // Coarse 0-65535 compatibility/dispute ratio.
  fillNumerator?: bigint;
  fillDenominator?: bigint;
  filledSourceAmount?: bigint;
  filledTargetAmount?: bigint;
  priceImprovementSourceAmount?: bigint;
  priceImprovementTargetAmount?: bigint;
  pendingClearRequestedAt?: number;
  domain?: CrossJurisdictionRouteDomain;
  settlementPolicy?: CrossJurisdictionSettlementPolicy;
  timePolicy?: CrossJurisdictionTimePolicy;
  clearingPolicy?: 'manual' | 'full_fill' | 'cancel_and_clear';
  priceImprovementMode?: 'source_savings' | 'target_bonus' | 'none';
  riskMode?: 'fully_collateralized' | 'partially_collateralized' | 'credit_line' | 'unsecured_internalized';
  claimedRatio?: number;
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
