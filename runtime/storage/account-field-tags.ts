import type { StorageAccountDoc } from './types';

export const STORAGE_ACCOUNT_FIELD_TAG = {
  leftEntity: 1, rightEntity: 2, domain: 3, watchSeed: 4, status: 5,
  mempool: 6, currentFrame: 7, deltas: 8, locks: 9, swapOffers: 10,
  pulls: 11, subcontracts: 12, lendingIntents: 13, globalCreditLimits: 14,
  currentHeight: 15, pendingFrame: 16, pendingSignatures: 17,
  pendingAccountInput: 18, pendingAccountInputSignerId: 19, lastOutboundFrameAck: 20,
  pendingForwards: 21, hankoSignature: 22, rollbackCount: 23, lastRollbackFrameHash: 24,
  leftPendingJClaims: 25, rightPendingJClaims: 26, lastFinalizedJHeight: 27,
  proofHeader: 28, proofBody: 29, abiProofBody: 30, disputeConfig: 31,
  currentFrameHanko: 32, counterpartyFrameHanko: 33, boardResealMigration: 34,
  counterpartyBoardReseal: 35, currentDisputeProofHanko: 36, currentDisputeProofNonce: 37,
  currentDisputeProofBodyHash: 38, currentDisputeHash: 39, counterpartyDisputeProofHanko: 40,
  counterpartyDisputeProofNonce: 41, counterpartyDisputeProofBodyHash: 42,
  counterpartyDisputeHash: 43, counterpartySettlementHanko: 44, disputeProofNoncesByHash: 45,
  disputeProofBodiesByHash: 46, disputeArgumentSnapshotsByHash: 47, disputePrepare: 48,
  jNonce: 49, settlementWorkspace: 50, activeDispute: 51, swapOrderHistory: 52,
  swapClosedOrders: 53, pendingWithdrawals: 54, requestedRebalance: 55,
  requestedRebalanceFeeState: 56, rebalanceFeePolicies: 57, shadow: 58,
} as const satisfies Record<keyof StorageAccountDoc, number>;

export type StorageAccountField = keyof typeof STORAGE_ACCOUNT_FIELD_TAG;

export const STORAGE_ACCOUNT_FIELD_BY_TAG = new Map<number, StorageAccountField>(
  Object.entries(STORAGE_ACCOUNT_FIELD_TAG).map(([field, tag]) => [tag, field as StorageAccountField]),
);
