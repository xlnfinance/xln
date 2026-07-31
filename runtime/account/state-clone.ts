import type { AccountFrame, AccountReplica, AccountTx } from '../types/account';
import {
  cloneCrossJurisdictionAccountFrameRoute,
  cloneCrossJurisdictionAccountInputRoute,
  cloneCrossJurisdictionAccountTxRoute,
  cloneCrossJurisdictionPullBinding,
  cloneCrossJurisdictionSwapHistoryRoute,
  cloneCrossJurisdictionSwapOfferRoute,
} from '../extensions/cross-j';
import { cloneDisputeArgumentSnapshot } from '../protocol/dispute/argument-snapshot';
import {
  cloneProofBodyStruct,
  type ProofBodyStruct,
} from '../protocol/dispute/proof-body';
import { cloneIsolatedAccountFrame } from '../protocol/account-input-clone';
import { structuredCloneOrThrow } from '../protocol/structured-clone';
import { forkAccountCommitmentCache } from './map-commitment';

const cloneAccountTx = <T extends AccountTx>(tx: T): T => {
  const cloned = structuredClone(tx) as T;
  return cloneCrossJurisdictionAccountTxRoute(cloned) as T;
};

const cloneCrossJurisdictionState = (
  target: AccountReplica,
  source: AccountReplica,
): void => {
  target.mempool = (source.mempool ?? []).map(cloneAccountTx);
  target.currentFrame = cloneCrossJurisdictionAccountFrameRoute(
    source.currentFrame,
  );
  if (source.pendingFrame) {
    target.pendingFrame = cloneCrossJurisdictionAccountFrameRoute(
      source.pendingFrame,
    );
  }
  if (source.pendingAccountInput) {
    target.pendingAccountInput = cloneCrossJurisdictionAccountInputRoute(
      source.pendingAccountInput,
    );
  }
  target.state.swapOffers = new Map(
    Array.from((source.state.swapOffers ?? new Map()).entries()).map(([id, offer]) => [
      id,
      cloneCrossJurisdictionSwapOfferRoute(offer),
    ]),
  );
  if (source.state.pulls instanceof Map) {
    target.state.pulls = new Map(
      Array.from(source.state.pulls.entries()).map(([id, pull]) => [
        id,
        pull.crossJurisdiction
          ? {
              ...pull,
              crossJurisdiction: cloneCrossJurisdictionPullBinding(
                pull.crossJurisdiction,
              ),
            }
          : { ...pull },
      ]),
    );
  } else {
    // Absence is consensus-significant. Normalizing it to an empty Map changes
    // the Entity root and can conflict with the persisted H0 anchor.
    delete target.state.pulls;
  }
  if (source.swapOrderHistory instanceof Map) {
    target.swapOrderHistory = new Map(
      Array.from(source.swapOrderHistory.entries()).map(([id, entry]) => [
        id,
        cloneCrossJurisdictionSwapHistoryRoute(entry),
      ]),
    );
  }
  if (source.swapClosedOrders instanceof Map) {
    target.swapClosedOrders = new Map(
      Array.from(source.swapClosedOrders.entries()).map(([id, entry]) => [
        id,
        cloneCrossJurisdictionSwapHistoryRoute(entry),
      ]),
    );
  }
};

const isProofBody = (value: unknown): value is ProofBodyStruct => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    Array.isArray(candidate['offdeltas']) &&
    Array.isArray(candidate['tokenIds']) &&
    Array.isArray(candidate['transformers'])
  );
};

const cloneProofBodyEvidence = (value: unknown): unknown =>
  isProofBody(value) ? cloneProofBodyStruct(value) : value;

const cloneDisputeEvidence = (
  target: AccountReplica,
  source: AccountReplica,
): void => {
  // Signed Solidity evidence and local positional calldata plans are different
  // maps. Never preserve aliases between them while cloning a candidate.
  if (source.disputeProofBodiesByHash) {
    target.disputeProofBodiesByHash = Object.fromEntries(
      Object.entries(source.disputeProofBodiesByHash).map(([hash, proofBody]) => [
        hash,
        cloneProofBodyEvidence(proofBody),
      ]),
    );
  } else {
    delete target.disputeProofBodiesByHash;
  }
  if (source.disputeArgumentSnapshotsByHash) {
    target.disputeArgumentSnapshotsByHash = Object.fromEntries(
      Object.entries(source.disputeArgumentSnapshotsByHash).map(
        ([hash, snapshot]) => [
          hash,
          cloneDisputeArgumentSnapshot(snapshot),
        ],
      ),
    );
  } else {
    delete target.disputeArgumentSnapshotsByHash;
  }
};

/**
 * Reapply Account-owned clone policy after a whole Entity structured clone.
 *
 * Entity cloning calls this for every embedded Account because Account alone
 * owns its evidence aliases, cross-j carriers, and commitment cache.
 */
export const applyAccountClonePolicy = (
  target: AccountReplica,
  source: AccountReplica,
  forSnapshot: boolean,
): void => {
  cloneDisputeEvidence(target, source);
  cloneCrossJurisdictionState(target, source);
  if (!forSnapshot) forkAccountCommitmentCache(source.state, target.state);
};

export const cloneAccountFrame = (frame: AccountFrame): AccountFrame =>
  cloneIsolatedAccountFrame(frame);

/** Clone the complete Account replica into an isolated validation or snapshot candidate. */
export const cloneAccountReplica = (
  account: AccountReplica,
  forSnapshot = false,
): AccountReplica => {
  const code = forSnapshot
    ? 'ACCOUNT_SNAPSHOT_STRUCTURED_CLONE_FAILED'
    : 'ACCOUNT_STATE_STRUCTURED_CLONE_FAILED';
  const cloned = structuredCloneOrThrow(account, code);
  // Frame history is a Runtime materialized view, not Account State. The
  // non-enumerable view is intentionally absent from every consensus clone.
  applyAccountClonePolicy(cloned, account, forSnapshot);
  return cloned;
};
