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
  cumulativeFillRatio?: number;
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
