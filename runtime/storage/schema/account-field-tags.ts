import type { AccountReplica, AccountState } from '../../types/account';

/**
 * Stable physical tags for the canonical nested AccountReplica document.
 *
 * Storage may split a large document into fields for incremental writes, but
 * the logical value remains exactly `{ state, ...replicaEnvelope }`. Prefixing
 * State paths keeps the physical optimization from inventing a second Account
 * representation.
 */
export const STORAGE_ACCOUNT_FIELD_TAG = {
  'state.leftEntity': 1, 'state.rightEntity': 2, 'state.domain': 3, 'state.watchSeed': 4,
  status: 5, mempool: 6, currentFrame: 7,
  'state.deltas': 8, 'state.locks': 9, 'state.swapOffers': 10,
  'state.pulls': 11, 'state.subcontracts': 12, 'state.lendingIntents': 13,
  // Tag 14 belonged to retired cross-token credit state. Never reuse persisted tags.
  currentHeight: 15, pendingFrame: 16, pendingSignatures: 17,
  pendingAccountInput: 18, lastOutboundFrameAck: 20,
  pendingForwards: 21, hankoSignature: 22, rollbackCount: 23, lastRollbackFrameHash: 24,
  'state.leftPendingJClaims': 25, 'state.rightPendingJClaims': 26,
  'state.lastFinalizedJHeight': 27,
  proofHeader: 28, proofBody: 29, abiProofBody: 30, 'state.disputeConfig': 31,
  currentFrameHanko: 32, counterpartyFrameHanko: 33, boardResealMigration: 34,
  counterpartyBoardReseal: 35, currentDisputeProofHanko: 36, currentDisputeProofNonce: 37,
  currentDisputeProofBodyHash: 38, currentDisputeHash: 39, counterpartyDisputeProofHanko: 40,
  counterpartyDisputeProofNonce: 41, counterpartyDisputeProofBodyHash: 42,
  counterpartyDisputeHash: 43, counterpartySettlementHanko: 44, disputeProofNoncesByHash: 45,
  disputeProofBodiesByHash: 46, disputeArgumentSnapshotsByHash: 47, disputePrepare: 48,
  'state.jNonce': 49, 'state.settlementWorkspace': 50, activeDispute: 51,
  swapOrderHistory: 52, swapClosedOrders: 53, pendingWithdrawals: 54,
  'state.requestedRebalance': 55, 'state.requestedRebalanceFeeState': 56,
  'state.rebalanceFeePolicies': 57, shadow: 58,
  currentDisputeProofProposerIsLeft: 59,
  counterpartyDisputeProofProposerIsLeft: 60,
} as const;

export type StorageAccountField = keyof typeof STORAGE_ACCOUNT_FIELD_TAG;
type TaggedStateField = StorageAccountField extends infer Field
  ? Field extends `state.${infer StateField}` ? StateField : never
  : never;
type TaggedReplicaField = Exclude<StorageAccountField, `state.${string}`>;
type AssertNever<T extends never> = T;

export type StorageAccountStateFieldCoverage = AssertNever<Exclude<keyof AccountState, TaggedStateField>>;
export type StorageAccountReplicaFieldCoverage = AssertNever<Exclude<keyof AccountReplica, TaggedReplicaField | 'state'>>;

export const STORAGE_ACCOUNT_FIELD_BY_TAG = new Map<number, StorageAccountField>(
  Object.entries(STORAGE_ACCOUNT_FIELD_TAG).map(([field, tag]) => [tag, field as StorageAccountField]),
);
