import type {
  CrossJurisdictionBookStatus,
  CrossJurisdictionCloseProof,
  CrossJurisdictionPullBinding,
  CrossJurisdictionPullLeg,
  CrossJurisdictionRouteDomain,
  CrossJurisdictionSettlementPolicy,
  CrossJurisdictionSwapLeg,
  CrossJurisdictionSwapRoute,
  CrossJurisdictionSwapStatus,
  CrossJurisdictionTimePolicy,
} from '../cross-jurisdiction';
import type { AssertNever, FieldGap } from './coverage';

type CrossJurisdictionDisputeConfig = CrossJurisdictionSwapRoute['sourceDisputeConfig'];
type SourceRegistryRecord = NonNullable<CrossJurisdictionSwapRoute['sourceRegistryRecord']>;
type TargetRegistryRecord = NonNullable<CrossJurisdictionSwapRoute['targetRegistryRecord']>;
type PendingRegistryReveal = NonNullable<CrossJurisdictionSwapRoute['pendingSourceRegistryReveal']>;

export const CROSS_JURISDICTION_BOOK_STATUSES = [
  'pending',
  'admitted',
  'resolving',
  'closed',
] as const satisfies readonly CrossJurisdictionBookStatus[];

export const CROSS_JURISDICTION_SWAP_STATUSES = [
  'intent',
  'target_prepared',
  'resting',
  'partially_filled',
  'clear_requested',
  'clearing',
  'settled',
  'cancelled',
  'expired',
] as const satisfies readonly CrossJurisdictionSwapStatus[];

export const HASHABLE_CROSS_J_SWAP_LEG_FIELDS = [
  'jurisdiction',
  'entityId',
  'counterpartyEntityId',
  'tokenId',
  'amount',
] as const satisfies readonly (keyof CrossJurisdictionSwapLeg)[];

export const HASHABLE_CROSS_J_PULL_LEG_FIELDS = [
  'pullId',
  'tokenId',
  'amount',
  'signedAmount',
  'fullHash',
  'partialRoot',
] as const satisfies readonly (keyof CrossJurisdictionPullLeg)[];

export const HASHABLE_CROSS_J_CLOSE_PROOF_FIELDS = [
  'orderId',
  'routeHash',
  'sourcePullId',
  'targetPullId',
  'fillRatio',
  'cumulativeSourceAmount',
  'cumulativeTargetAmount',
  'binaryHash',
  'closeMode',
] as const satisfies readonly (keyof CrossJurisdictionCloseProof)[];

const HASHABLE_CROSS_J_DISPUTE_CONFIG_FIELDS = [
  'leftResponseSeconds',
  'rightResponseSeconds',
] as const satisfies readonly (keyof CrossJurisdictionDisputeConfig)[];

export const HASHABLE_CROSS_J_ROUTE_DOMAIN_FIELDS = [
  'protocol',
  'hashSchema',
  'sourceStackId',
  'targetStackId',
  'sourceEntityProviderAddress',
  'targetEntityProviderAddress',
  'sourceDeltaTransformerAddress',
  'targetDeltaTransformerAddress',
  'sourceAssetRef',
  'targetAssetRef',
] as const satisfies readonly (keyof CrossJurisdictionRouteDomain)[];

export const HASHABLE_CROSS_J_SETTLEMENT_POLICY_FIELDS = [
  'roundingMode',
  'maxSourceDust',
  'maxTargetDust',
  'minSourceFillAmount',
  'minTargetFillAmount',
] as const satisfies readonly (keyof CrossJurisdictionSettlementPolicy)[];

export const HASHABLE_CROSS_J_TIME_POLICY_FIELDS = [
  'runtimeClock',
  'settlementClock',
  'deadlineConversion',
  'runtimeExpiresAtMs',
  'finalityPolicy',
] as const satisfies readonly (keyof CrossJurisdictionTimePolicy)[];

export const HASHABLE_CROSS_J_PULL_BINDING_FIELDS = [
  'orderId',
  'routeHash',
  'leg',
  'sourceCloseProof',
  'status',
  'cumulativeFillRatio',
  'fillSeq',
  'fillNumerator',
  'fillDenominator',
  'claimedRatio',
  'filledSourceAmount',
  'filledTargetAmount',
  'sourceClaimed',
  'targetClaimed',
  'clearingPolicy',
] as const satisfies readonly (keyof CrossJurisdictionPullBinding)[];

const HASHABLE_CROSS_J_REGISTRY_RECORD_FIELDS = [
  'fillRatio',
  'revealedAt',
] as const satisfies readonly (keyof SourceRegistryRecord)[];

const HASHABLE_CROSS_J_PENDING_REVEAL_FIELDS = [
  'fillRatio',
  'fullSecret',
  'reveals',
] as const satisfies readonly (keyof PendingRegistryReveal)[];

export const HASHABLE_CROSS_J_SWAP_ROUTE_FIELDS = [
  'orderId',
  'routeHash',
  'bookOwnerEntityId',
  'venueId',
  'sourceSignerId',
  'sourceHubSignerId',
  'targetHubSignerId',
  'targetSignerId',
  'bookHubSignerId',
  'makerEntityId',
  'hubEntityId',
  'source',
  'target',
  'sourceDisputeConfig',
  'targetDisputeConfig',
  'sourcePull',
  'targetPull',
  'sourceCloseProof',
  'targetCloseProof',
  'priceTicks',
  'fillSeq',
  'cumulativeFillRatio',
  'fillNumerator',
  'fillDenominator',
  'filledSourceAmount',
  'filledTargetAmount',
  'priceImprovementSourceAmount',
  'pendingClearRequestedAt',
  'domain',
  'settlementPolicy',
  'timePolicy',
  'clearingPolicy',
  'priceImprovementMode',
  'riskMode',
  'claimedRatio',
  'sourceRegistryFillRatio',
  'targetRegistryFillRatio',
  'sourceRegistryRecord',
  'targetRegistryRecord',
  'pendingSourceRegistryReveal',
  'pendingTargetRegistryReveal',
  'sourceClaimed',
  'targetClaimed',
  'status',
  'createdAt',
  'updatedAt',
  'expiresAt',
  'settledAt',
  'error',
  'memo',
] as const satisfies readonly (keyof CrossJurisdictionSwapRoute)[];

export type CrossJNestedFieldCoverage = [
  AssertNever<Exclude<CrossJurisdictionBookStatus, (typeof CROSS_JURISDICTION_BOOK_STATUSES)[number]>>,
  AssertNever<Exclude<(typeof CROSS_JURISDICTION_BOOK_STATUSES)[number], CrossJurisdictionBookStatus>>,
  AssertNever<Exclude<CrossJurisdictionSwapStatus, (typeof CROSS_JURISDICTION_SWAP_STATUSES)[number]>>,
  AssertNever<Exclude<(typeof CROSS_JURISDICTION_SWAP_STATUSES)[number], CrossJurisdictionSwapStatus>>,
  AssertNever<FieldGap<CrossJurisdictionSwapLeg, typeof HASHABLE_CROSS_J_SWAP_LEG_FIELDS>>,
  AssertNever<FieldGap<CrossJurisdictionPullLeg, typeof HASHABLE_CROSS_J_PULL_LEG_FIELDS>>,
  AssertNever<FieldGap<CrossJurisdictionCloseProof, typeof HASHABLE_CROSS_J_CLOSE_PROOF_FIELDS>>,
  AssertNever<FieldGap<CrossJurisdictionDisputeConfig, typeof HASHABLE_CROSS_J_DISPUTE_CONFIG_FIELDS>>,
  AssertNever<FieldGap<CrossJurisdictionRouteDomain, typeof HASHABLE_CROSS_J_ROUTE_DOMAIN_FIELDS>>,
  AssertNever<FieldGap<CrossJurisdictionSettlementPolicy, typeof HASHABLE_CROSS_J_SETTLEMENT_POLICY_FIELDS>>,
  AssertNever<FieldGap<CrossJurisdictionTimePolicy, typeof HASHABLE_CROSS_J_TIME_POLICY_FIELDS>>,
  AssertNever<FieldGap<CrossJurisdictionPullBinding, typeof HASHABLE_CROSS_J_PULL_BINDING_FIELDS>>,
  AssertNever<FieldGap<SourceRegistryRecord, typeof HASHABLE_CROSS_J_REGISTRY_RECORD_FIELDS>>,
  AssertNever<FieldGap<TargetRegistryRecord, typeof HASHABLE_CROSS_J_REGISTRY_RECORD_FIELDS>>,
  AssertNever<FieldGap<PendingRegistryReveal, typeof HASHABLE_CROSS_J_PENDING_REVEAL_FIELDS>>,
  AssertNever<FieldGap<CrossJurisdictionSwapRoute, typeof HASHABLE_CROSS_J_SWAP_ROUTE_FIELDS>>,
];
