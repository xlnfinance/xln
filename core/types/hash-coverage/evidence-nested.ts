import type {
  RuntimeAllowance,
  RuntimeBatch,
  RuntimePayment,
  RuntimeProofBody,
  RuntimePull,
  RuntimeSwap,
  RuntimeTransformerClause,
} from '../../protocol/dispute/proof-body';
import type { AllKeys, AssertNever, FieldGap } from './coverage';

export const HASHABLE_RUNTIME_PROOF_BODY_FIELDS = [
  'watchSeed',
  'leftResponseSeconds',
  'rightResponseSeconds',
  'offdeltas',
  'tokenIds',
  'transformers',
] as const satisfies readonly (keyof RuntimeProofBody)[];

export const HASHABLE_RUNTIME_PAYMENT_FIELDS = [
  'deltaIndex',
  'amount',
  'revealedUntilTimestamp',
  'hash',
] as const satisfies readonly (keyof RuntimePayment)[];

export const HASHABLE_RUNTIME_SWAP_FIELDS = [
  'ownerIsLeft',
  'addDeltaIndex',
  'addAmount',
  'subDeltaIndex',
  'subAmount',
] as const satisfies readonly (keyof RuntimeSwap)[];

export const HASHABLE_RUNTIME_PULL_FIELDS = [
  'deltaIndex',
  'amount',
  'claimedRatio',
  'fullHash',
  'partialRoot',
  'targetRole',
] as const satisfies readonly (keyof RuntimePull)[];

export const HASHABLE_RUNTIME_ALLOWANCE_FIELDS = [
  'deltaIndex',
  'rightAllowance',
  'leftAllowance',
] as const satisfies readonly (keyof RuntimeAllowance)[];

export const HASHABLE_RUNTIME_BATCH_FIELDS = [
  'payments',
  'swaps',
  'pulls',
] as const satisfies readonly (keyof RuntimeBatch)[];

const HASHABLE_RUNTIME_TRANSFORMER_CLAUSE_FIELDS = [
  'transformerAddress',
  'batch',
  'encodedBatch',
  'allowances',
] as const satisfies readonly AllKeys<RuntimeTransformerClause>[];

export type EvidenceNestedFieldCoverage = [
  AssertNever<FieldGap<RuntimeProofBody, typeof HASHABLE_RUNTIME_PROOF_BODY_FIELDS>>,
  AssertNever<FieldGap<RuntimePayment, typeof HASHABLE_RUNTIME_PAYMENT_FIELDS>>,
  AssertNever<FieldGap<RuntimeSwap, typeof HASHABLE_RUNTIME_SWAP_FIELDS>>,
  AssertNever<FieldGap<RuntimePull, typeof HASHABLE_RUNTIME_PULL_FIELDS>>,
  AssertNever<FieldGap<RuntimeAllowance, typeof HASHABLE_RUNTIME_ALLOWANCE_FIELDS>>,
  AssertNever<FieldGap<RuntimeBatch, typeof HASHABLE_RUNTIME_BATCH_FIELDS>>,
  AssertNever<FieldGap<RuntimeTransformerClause, typeof HASHABLE_RUNTIME_TRANSFORMER_CLAUSE_FIELDS>>,
];
