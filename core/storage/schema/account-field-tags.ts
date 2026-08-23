import type { AccountReplica, AccountState } from '../../types/account';
import type { AssertNever, Covered } from '../../types/hash-coverage/coverage';

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
  currentHeight: 15, pendingFrame: 16,
  // Tag 17 belonged to retired pendingSignatures. Never reuse persisted tags.
  pendingAccountInput: 18, lastOutboundFrameAck: 20,
  // Tag 21 belonged to retired payment-forward side-channel state.
  // Tag 22 belonged to a never-used generic Account Hanko cache.
  rollbackCount: 23, lastRollbackFrameHash: 24,
  'state.leftPendingJClaims': 25, 'state.rightPendingJClaims': 26,
  'state.lastFinalizedJHeight': 27,
  proofHeader: 28,
  // Tags 29-30 belonged to derived ProofBody caches. Never reuse persisted tags.
  'state.disputeConfig': 31,
  currentFrameHanko: 32, counterpartyFrameHanko: 33, boardHankoRefreshMigration: 34,
  counterpartyBoardHankoRefresh: 35, currentDisputeProofHanko: 36, currentDisputeProofNonce: 37,
  currentDisputeProofBodyHash: 38, currentDisputeHash: 39, counterpartyDisputeProofHanko: 40,
  counterpartyDisputeProofNonce: 41, counterpartyDisputeProofBodyHash: 42,
  counterpartyDisputeHash: 43, counterpartySettlementHanko: 44,
  // Tags 45-47 belonged to retired dispute caches. Never reuse persisted tags.
  disputePrepare: 48,
  'state.jNonce': 49, 'state.settlementWorkspace': 50, activeDispute: 51,
  // Tags 52-53 belonged to retired live swap history; never reuse them.
  pendingWithdrawals: 54,
  'state.requestedRebalance': 55, 'state.requestedRebalanceFeeState': 56,
  'state.rebalanceFeePolicies': 57, shadow: 58,
  currentDisputeProofProposerIsLeft: 59,
  counterpartyDisputeProofProposerIsLeft: 60,
  publicPinned: 61,
  // Tag 62 belonged to the retired proposal-resend timestamp; never reuse it.
} as const;

export type StorageAccountField = keyof typeof STORAGE_ACCOUNT_FIELD_TAG;
type TaggedStateField = StorageAccountField extends infer Field
  ? Field extends `state.${infer StateField}` ? StateField : never
  : never;
type TaggedReplicaField = Exclude<StorageAccountField, `state.${string}`>;

type StorageAccountFieldCoverage =
  | AssertNever<Exclude<keyof AccountState, TaggedStateField>>
  | AssertNever<Exclude<keyof AccountReplica, TaggedReplicaField | 'state'>>;

export const STORAGE_ACCOUNT_FIELD_BY_TAG: Covered<
  Map<number, StorageAccountField>,
  StorageAccountFieldCoverage
> = new Map<number, StorageAccountField>(
  Object.entries(STORAGE_ACCOUNT_FIELD_TAG).map(([field, tag]) => [tag, field as StorageAccountField]),
);
