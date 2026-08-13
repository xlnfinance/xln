import { HASHABLE_ACCOUNT_TX_DATA_FIELDS, type TxNestedFieldCoverage } from './tx-nested';
import {
  HASHABLE_ACCOUNT_SUBCONTRACT_FIELDS,
  HASHABLE_CROSS_J_SECRET_RELAY_FIELDS,
  HASHABLE_DELTA_FIELDS,
  HASHABLE_HTLC_LOCK_FIELDS,
  HASHABLE_HTLC_ROUTE_FIELDS,
  HASHABLE_PULL_COMMITMENT_FIELDS,
  HASHABLE_SETTLEMENT_DIFF_FIELDS,
  HASHABLE_SETTLEMENT_OP_FIELDS,
  HASHABLE_SETTLEMENT_WORKSPACE_FIELDS,
  HASHABLE_SWAP_OFFER_FIELDS,
  type AccountNestedFieldCoverage,
} from './account-nested';
import {
  CROSS_JURISDICTION_SWAP_STATUSES,
  CROSS_JURISDICTION_BOOK_STATUSES,
  HASHABLE_CROSS_J_CLOSE_PROOF_FIELDS,
  HASHABLE_CROSS_J_PULL_BINDING_FIELDS,
  HASHABLE_CROSS_J_PULL_LEG_FIELDS,
  HASHABLE_CROSS_J_ROUTE_DOMAIN_FIELDS,
  HASHABLE_CROSS_J_SETTLEMENT_POLICY_FIELDS,
  HASHABLE_CROSS_J_SWAP_LEG_FIELDS,
  HASHABLE_CROSS_J_SWAP_ROUTE_FIELDS,
  HASHABLE_CROSS_J_TIME_POLICY_FIELDS,
  type CrossJNestedFieldCoverage,
} from './cross-j-nested';
import {
  HASHABLE_RUNTIME_ALLOWANCE_FIELDS,
  HASHABLE_RUNTIME_BATCH_FIELDS,
  HASHABLE_RUNTIME_PAYMENT_FIELDS,
  HASHABLE_RUNTIME_PROOF_BODY_FIELDS,
  HASHABLE_RUNTIME_PULL_FIELDS,
  HASHABLE_RUNTIME_SWAP_FIELDS,
  type EvidenceNestedFieldCoverage,
} from './evidence-nested';

type NestedHashShape =
  | 'interface'
  | 'type-literal'
  | 'union-by-type'
  | 'string-union';

export type NestedHashCoverageEntry = Readonly<{
  typeName: string;
  sourceFile: string;
  fields: readonly string[];
  shape: NestedHashShape;
}>;

type NestedHashCoverageHeld<T extends never> = [T] extends [never]
  ? readonly NestedHashCoverageEntry[]
  : never;

export const NESTED_HASH_COVERAGE: NestedHashCoverageHeld<
  | AccountNestedFieldCoverage[number]
  | CrossJNestedFieldCoverage[number]
  | EvidenceNestedFieldCoverage[number]
  | TxNestedFieldCoverage
> & readonly NestedHashCoverageEntry[] = [
  { typeName: 'Delta', sourceFile: 'runtime/types/account.ts', fields: HASHABLE_DELTA_FIELDS, shape: 'interface' },
  { typeName: 'HtlcLock', sourceFile: 'runtime/types/account.ts', fields: HASHABLE_HTLC_LOCK_FIELDS, shape: 'interface' },
  { typeName: 'PullCommitment', sourceFile: 'runtime/types/account.ts', fields: HASHABLE_PULL_COMMITMENT_FIELDS, shape: 'interface' },
  { typeName: 'SwapOffer', sourceFile: 'runtime/types/account.ts', fields: HASHABLE_SWAP_OFFER_FIELDS, shape: 'interface' },
  { typeName: 'SettlementDiff', sourceFile: 'runtime/types/account.ts', fields: HASHABLE_SETTLEMENT_DIFF_FIELDS, shape: 'interface' },
  { typeName: 'SettlementWorkspace', sourceFile: 'runtime/types/account.ts', fields: HASHABLE_SETTLEMENT_WORKSPACE_FIELDS, shape: 'interface' },
  { typeName: 'HtlcRoute', sourceFile: 'runtime/types/account.ts', fields: HASHABLE_HTLC_ROUTE_FIELDS, shape: 'interface' },
  { typeName: 'CrossJurisdictionSecretRelay', sourceFile: 'runtime/types/account.ts', fields: HASHABLE_CROSS_J_SECRET_RELAY_FIELDS, shape: 'interface' },
  { typeName: 'AccountSubcontract', sourceFile: 'runtime/types/account.ts', fields: HASHABLE_ACCOUNT_SUBCONTRACT_FIELDS, shape: 'interface' },
  { typeName: 'CrossSwapFillAckData', sourceFile: 'runtime/types/account.ts', fields: HASHABLE_ACCOUNT_TX_DATA_FIELDS.cross_swap_fill_ack, shape: 'type-literal' },
  { typeName: 'SettlementOp', sourceFile: 'runtime/types/account.ts', fields: Object.keys(HASHABLE_SETTLEMENT_OP_FIELDS), shape: 'union-by-type' },
  { typeName: 'AccountTx', sourceFile: 'runtime/types/account.ts', fields: Object.keys(HASHABLE_ACCOUNT_TX_DATA_FIELDS), shape: 'union-by-type' },
  { typeName: 'CrossJurisdictionSwapStatus', sourceFile: 'runtime/types/cross-jurisdiction.ts', fields: CROSS_JURISDICTION_SWAP_STATUSES, shape: 'string-union' },
  { typeName: 'CrossJurisdictionBookStatus', sourceFile: 'runtime/types/cross-jurisdiction.ts', fields: CROSS_JURISDICTION_BOOK_STATUSES, shape: 'string-union' },
  { typeName: 'CrossJurisdictionSwapLeg', sourceFile: 'runtime/types/cross-jurisdiction.ts', fields: HASHABLE_CROSS_J_SWAP_LEG_FIELDS, shape: 'interface' },
  { typeName: 'CrossJurisdictionPullLeg', sourceFile: 'runtime/types/cross-jurisdiction.ts', fields: HASHABLE_CROSS_J_PULL_LEG_FIELDS, shape: 'interface' },
  { typeName: 'CrossJurisdictionCloseProof', sourceFile: 'runtime/types/cross-jurisdiction.ts', fields: HASHABLE_CROSS_J_CLOSE_PROOF_FIELDS, shape: 'interface' },
  { typeName: 'CrossJurisdictionRouteDomain', sourceFile: 'runtime/types/cross-jurisdiction.ts', fields: HASHABLE_CROSS_J_ROUTE_DOMAIN_FIELDS, shape: 'interface' },
  { typeName: 'CrossJurisdictionSettlementPolicy', sourceFile: 'runtime/types/cross-jurisdiction.ts', fields: HASHABLE_CROSS_J_SETTLEMENT_POLICY_FIELDS, shape: 'interface' },
  { typeName: 'CrossJurisdictionTimePolicy', sourceFile: 'runtime/types/cross-jurisdiction.ts', fields: HASHABLE_CROSS_J_TIME_POLICY_FIELDS, shape: 'interface' },
  { typeName: 'CrossJurisdictionPullBinding', sourceFile: 'runtime/types/cross-jurisdiction.ts', fields: HASHABLE_CROSS_J_PULL_BINDING_FIELDS, shape: 'interface' },
  { typeName: 'CrossJurisdictionSwapRoute', sourceFile: 'runtime/types/cross-jurisdiction.ts', fields: HASHABLE_CROSS_J_SWAP_ROUTE_FIELDS, shape: 'interface' },
  { typeName: 'RuntimeProofBody', sourceFile: 'runtime/protocol/dispute/proof-body.ts', fields: HASHABLE_RUNTIME_PROOF_BODY_FIELDS, shape: 'interface' },
  { typeName: 'RuntimePayment', sourceFile: 'runtime/protocol/dispute/proof-body.ts', fields: HASHABLE_RUNTIME_PAYMENT_FIELDS, shape: 'interface' },
  { typeName: 'RuntimeSwap', sourceFile: 'runtime/protocol/dispute/proof-body.ts', fields: HASHABLE_RUNTIME_SWAP_FIELDS, shape: 'interface' },
  { typeName: 'RuntimePull', sourceFile: 'runtime/protocol/dispute/proof-body.ts', fields: HASHABLE_RUNTIME_PULL_FIELDS, shape: 'interface' },
  { typeName: 'RuntimeAllowance', sourceFile: 'runtime/protocol/dispute/proof-body.ts', fields: HASHABLE_RUNTIME_ALLOWANCE_FIELDS, shape: 'interface' },
  { typeName: 'RuntimeBatch', sourceFile: 'runtime/protocol/dispute/proof-body.ts', fields: HASHABLE_RUNTIME_BATCH_FIELDS, shape: 'interface' },
];

export {
  HASHABLE_ACCOUNT_TX_DATA_FIELDS,
  HASHABLE_SETTLEMENT_OP_FIELDS,
};
