import type {
  Delta,
  HtlcLock,
  PullCommitment,
  SettlementDiff,
  SettlementOp,
  SettlementWorkspace,
  SwapOffer,
  AccountExternalSubcontract,
  AccountLendingCovenant,
} from '../account';
import { LENDING_COVENANT_FIELDS } from '../../protocol/dispute/lending-covenant';
import type { PaybookEntry } from '../../entity/types';
import type { AssertNever, FieldGap } from './coverage';

type CrossJurisdictionSecretRelay = NonNullable<PaybookEntry['crossJurisdictionRelay']>;
type PostSettlementDisputeProof = NonNullable<SettlementWorkspace['postSettlementDisputeProof']>;

export const HASHABLE_DELTA_FIELDS = [
  'tokenId',
  'collateral',
  'ondelta',
  'offdelta',
  'leftCreditLimit',
  'rightCreditLimit',
  'leftAllowance',
  'rightAllowance',
  'leftHold',
  'rightHold',
] as const satisfies readonly (keyof Delta)[];

export const HASHABLE_HTLC_LOCK_FIELDS = [
  'lockId',
  'hashlock',
  'timelock',
  'revealBeforeHeight',
  'amount',
  'tokenId',
  'senderIsLeft',
  'createdHeight',
  'createdTimestamp',
  'envelopeHash',
] as const satisfies readonly (keyof HtlcLock)[];

export const HASHABLE_PULL_COMMITMENT_FIELDS = [
  'pullId',
  'tokenId',
  'amount',
  'claimedRatio',
  'claimedAmount',
  'fullHash',
  'partialRoot',
  'crossJurisdiction',
  'createdHeight',
  'createdTimestamp',
] as const satisfies readonly (keyof PullCommitment)[];

export const HASHABLE_SWAP_OFFER_FIELDS = [
  'offerId',
  'giveTokenId',
  'giveTokenDecimals',
  'giveAmount',
  'wantTokenId',
  'wantTokenDecimals',
  'wantAmount',
  'maxFee',
  'minNetReceive',
  'priceTicks',
  'timeInForce',
  'makerIsLeft',
  'createdHeight',
  'quantizedGive',
  'quantizedWant',
  'crossJurisdiction',
] as const satisfies readonly (keyof SwapOffer)[];

export const HASHABLE_SETTLEMENT_DIFF_FIELDS = [
  'tokenId',
  'leftDiff',
  'rightDiff',
  'collateralDiff',
  'ondeltaDiff',
] as const satisfies readonly (keyof SettlementDiff)[];

export const HASHABLE_SETTLEMENT_OP_FIELDS = {
  r2c: ['type', 'tokenId', 'amount'],
  c2r: ['type', 'tokenId', 'amount'],
  r2r: ['type', 'tokenId', 'amount'],
  forgive: ['type', 'tokenId'],
  rawDiff: ['type', 'tokenId', 'leftDiff', 'rightDiff', 'collateralDiff', 'ondeltaDiff'],
} as const satisfies {
  [Kind in SettlementOp['type']]: readonly (keyof Extract<SettlementOp, { type: Kind }>)[];
};

export const HASHABLE_SETTLEMENT_WORKSPACE_FIELDS = [
  'workspaceHash',
  'ops',
  'compiledDiffs',
  'compiledForgiveTokenIds',
  'leftHanko',
  'rightHanko',
  'settlementHash',
  'lastModifiedByLeft',
  'status',
  'memo',
  'revision',
  'createdAt',
  'lastUpdatedAt',
  'executorIsLeft',
  'nonceAtSign',
  'postSettlementDisputeProof',
] as const satisfies readonly (keyof SettlementWorkspace)[];

const HASHABLE_POST_SETTLEMENT_DISPUTE_PROOF_FIELDS = [
  'leftHanko',
  'rightHanko',
  'disputeHash',
  'proofBodyHash',
  'nonce',
  'proposerIsLeft',
] as const satisfies readonly (keyof PostSettlementDisputeProof)[];

export const HASHABLE_PAYBOOK_ENTRY_FIELDS = [
  'hashlock',
  'description',
  'tokenId',
  'amount',
  'startedAtMs',
  'originated',
  'inboundEntity',
  'outboundEntity',
  'inboundSettled',
  'outboundSettled',
  'secret',
  'secretAckPending',
  'secretAckStartedAt',
  'secretAckDeadlineAt',
  'secretAckedAt',
  'pendingFee',
  'crossJurisdictionRelay',
  'createdTimestamp',
] as const satisfies readonly (keyof PaybookEntry)[];

export const HASHABLE_CROSS_J_SECRET_RELAY_FIELDS = [
  'routeId',
  'fillRatio',
  'sourceAmount',
  'targetAmount',
  'targetEntityId',
  'targetSignerId',
  'targetCounterpartyEntityId',
  'targetLockId',
] as const satisfies readonly (keyof CrossJurisdictionSecretRelay)[];

export const HASHABLE_ACCOUNT_SUBCONTRACT_FIELDS = [
  'transformerAddress',
  'encodedBatch',
  'allowances',
  'leftArgumentsHash',
  'rightArgumentsHash',
] as const satisfies readonly (keyof AccountExternalSubcontract)[];

export const HASHABLE_ACCOUNT_LENDING_COVENANT_FIELDS = LENDING_COVENANT_FIELDS;

const HASHABLE_ACCOUNT_SUBCONTRACT_ALLOWANCE_FIELDS = [
  'deltaIndex',
  'rightAllowance',
  'leftAllowance',
] as const satisfies readonly (keyof AccountExternalSubcontract['allowances'][number])[];

export type AccountNestedFieldCoverage = [
  AssertNever<FieldGap<Delta, typeof HASHABLE_DELTA_FIELDS>>,
  AssertNever<FieldGap<HtlcLock, typeof HASHABLE_HTLC_LOCK_FIELDS>>,
  AssertNever<FieldGap<PullCommitment, typeof HASHABLE_PULL_COMMITMENT_FIELDS>>,
  AssertNever<FieldGap<SwapOffer, typeof HASHABLE_SWAP_OFFER_FIELDS>>,
  AssertNever<FieldGap<SettlementDiff, typeof HASHABLE_SETTLEMENT_DIFF_FIELDS>>,
  AssertNever<FieldGap<SettlementWorkspace, typeof HASHABLE_SETTLEMENT_WORKSPACE_FIELDS>>,
  AssertNever<FieldGap<PostSettlementDisputeProof, typeof HASHABLE_POST_SETTLEMENT_DISPUTE_PROOF_FIELDS>>,
  AssertNever<FieldGap<PaybookEntry, typeof HASHABLE_PAYBOOK_ENTRY_FIELDS>>,
  AssertNever<FieldGap<CrossJurisdictionSecretRelay, typeof HASHABLE_CROSS_J_SECRET_RELAY_FIELDS>>,
  AssertNever<FieldGap<AccountExternalSubcontract, typeof HASHABLE_ACCOUNT_SUBCONTRACT_FIELDS>>,
  AssertNever<FieldGap<AccountLendingCovenant, typeof HASHABLE_ACCOUNT_LENDING_COVENANT_FIELDS>>,
  AssertNever<FieldGap<
    AccountExternalSubcontract['allowances'][number],
    typeof HASHABLE_ACCOUNT_SUBCONTRACT_ALLOWANCE_FIELDS
  >>,
];
