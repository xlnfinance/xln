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

export interface CrossJurisdictionBookAdmissionReceipt {
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
  updatedAt: number;
}

export interface CrossJurisdictionSwapRoute {
  orderId: string;
  routeHash?: string;
  bookOwnerEntityId?: string;
  venueId?: string;
  makerEntityId: string;
  hubEntityId: string;
  source: CrossJurisdictionSwapLeg;
  target: CrossJurisdictionSwapLeg;
  sourcePull?: CrossJurisdictionPullLeg;
  targetPull?: CrossJurisdictionPullLeg;
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
