/**
 * XLN State Management Helpers
 * Utilities for entity replica cloning, snapshots, and state persistence
 */

import type {
  AccountFrame,
  AccountState,
  AccountTx,
  EntityReplica,
  EntityState,
  LendingLoan,
  LendingPoolPosition,
  LendingState,
} from './types';
import { cloneDisputeArgumentSnapshot } from './protocol/dispute/argument-snapshot';
import type { ProofBodyStruct } from '../jurisdictions/typechain-types/contracts/Depository.sol/Depository';
import { cloneProofBodyStruct } from './protocol/dispute/proof-body';
import { validateEntityState } from './entity/state-validation';
import { validateEntityReplica } from './entity/replica-validation';
import { copyEntityFrameEvents } from './entity/frame-events';
import {
  cloneIsolatedEntityInput,
  cloneIsolatedEntityLeaderCertificate,
  cloneIsolatedEntityLeaderTimeoutVote,
  cloneIsolatedProposedEntityFrame,
} from './protocol/runtime-input-clone';
import {
  cloneIsolatedAccountFrame,
} from './protocol/account-input-clone';
import { getAccountFrameHistoryView, setAccountFrameHistoryView } from './runtime/env-events';
import { cloneJBatch, type JBatchState } from './jurisdiction/batch';
import {
  cloneCrossJurisdictionBookAdmission,
  cloneCrossJurisdictionAccountFrameRoute,
  cloneCrossJurisdictionAccountTxRoute,
  cloneCrossJurisdictionAccountInputRoute,
  cloneCrossJurisdictionRoute,
  cloneCrossJurisdictionPullBinding,
  cloneCrossJurisdictionSwapHistoryRoute,
  cloneCrossJurisdictionSwapOfferRoute,
} from './extensions/cross-j/index';
import { createStructuredLogger } from './infra/logger';
import { forkAccountCommitmentCache } from './account/map-commitment';
import { forkEntityAccountCommitmentCache } from './entity/consensus/state-root';

const stateHelperLog = createStructuredLogger('state.helpers');
const cloneAccountTxForState = <T extends AccountTx>(tx: T): T => {
  const cloned = structuredClone(tx) as T;
  return cloneCrossJurisdictionAccountTxRoute(cloned) as T;
};

const cloneCrossJurisdictionRoutesInState = (state: EntityState, source: EntityState = state): void => {
  if (source.crossJurisdictionSwaps) {
    state.crossJurisdictionSwaps = new Map(
      Array.from(source.crossJurisdictionSwaps.entries()).map(([id, route]) => [
        id,
        cloneCrossJurisdictionRoute(route),
      ]),
    );
  }
  if (source.pendingCrossJurisdictionFillAcks) {
    state.pendingCrossJurisdictionFillAcks = new Map(
      Array.from(source.pendingCrossJurisdictionFillAcks.entries()).map(([id, pending]) => [
        id,
        {
          ...pending,
          tx: cloneAccountTxForState(pending.tx) as typeof pending.tx,
        },
      ]),
    );
  }
  if (source.crossJurisdictionBookAdmissions) {
    state.crossJurisdictionBookAdmissions = new Map(
      Array.from(source.crossJurisdictionBookAdmissions.entries()).map(([id, admission]) => [
        id,
        cloneCrossJurisdictionBookAdmission(admission),
      ]),
    );
  }
};

const cloneCrossJurisdictionRoutesInAccount = (account: AccountState, source: AccountState = account): void => {
  account.mempool = (source.mempool ?? []).map(cloneAccountTxForState);
  account.currentFrame = cloneCrossJurisdictionAccountFrameRoute(source.currentFrame);
  if (source.pendingFrame) account.pendingFrame = cloneCrossJurisdictionAccountFrameRoute(source.pendingFrame);
  if (source.pendingAccountInput) {
    account.pendingAccountInput = cloneCrossJurisdictionAccountInputRoute(source.pendingAccountInput);
  }
  account.swapOffers = new Map(
    Array.from((source.swapOffers ?? new Map()).entries()).map(([id, offer]) => [
      id,
      cloneCrossJurisdictionSwapOfferRoute(offer),
    ]),
  );
  if (source.pulls instanceof Map) {
    account.pulls = new Map(
      Array.from(source.pulls.entries()).map(([id, pull]) => [
        id,
        pull.crossJurisdiction
          ? { ...pull, crossJurisdiction: cloneCrossJurisdictionPullBinding(pull.crossJurisdiction) }
          : { ...pull },
      ]),
    );
  } else {
    // `pulls` is optional consensus state. Turning absence into an empty Map
    // during a snapshot changes the canonical Entity state root and can make a
    // valid persisted H0 anchor conflict with its own freshly cloned replica.
    delete account.pulls;
  }
  if (source.swapOrderHistory instanceof Map) {
    account.swapOrderHistory = new Map(
      Array.from(source.swapOrderHistory.entries()).map(([id, entry]) => [
        id,
        cloneCrossJurisdictionSwapHistoryRoute(entry),
      ]),
    );
  }
  if (source.swapClosedOrders instanceof Map) {
    account.swapClosedOrders = new Map(
      Array.from(source.swapClosedOrders.entries()).map(([id, entry]) => [
        id,
        cloneCrossJurisdictionSwapHistoryRoute(entry),
      ]),
    );
  }
};

const cloneJBatchState = (state: JBatchState): JBatchState => {
  const cloned: JBatchState = {
    batch: cloneJBatch(state.batch),
    jurisdiction: state.jurisdiction,
    lastBroadcast: state.lastBroadcast,
    broadcastCount: state.broadcastCount,
    failedAttempts: state.failedAttempts,
    status: state.status,
  };
  if (state.sentBatch) {
    cloned.sentBatch = {
      ...state.sentBatch,
      batch: cloneJBatch(state.sentBatch.batch),
    };
  }
  if (state.entityNonce !== undefined) {
    cloned.entityNonce = state.entityNonce;
  }
  if (state.autoBroadcastDraft !== undefined) {
    cloned.autoBroadcastDraft = state.autoBroadcastDraft;
  }
  return cloned;
};

const cloneLendingPoolPosition = (position: LendingPoolPosition): LendingPoolPosition => ({
  ...position,
});

const cloneLendingLoan = (loan: LendingLoan): LendingLoan => ({
  ...loan,
});

const cloneLendingState = (lending: LendingState): LendingState => ({
  pools: new Map(
    Array.from(lending.pools.entries()).map(([positionId, position]) => [
      positionId,
      cloneLendingPoolPosition(position),
    ]),
  ),
  loans: new Map(
    Array.from(lending.loans.entries()).map(([loanId, loan]) => [
      loanId,
      cloneLendingLoan(loan),
    ]),
  ),
});

export function cloneAccountFrame(frame: AccountFrame): AccountFrame {
  return cloneIsolatedAccountFrame(frame);
}

const isProofBodyStructLike = (value: unknown): value is ProofBodyStruct => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    Array.isArray(candidate['offdeltas']) &&
    Array.isArray(candidate['tokenIds']) &&
    Array.isArray(candidate['transformers'])
  );
};

const cloneProofBodyEvidence = (proofBody: unknown): unknown => {
  if (!isProofBodyStructLike(proofBody)) return proofBody;
  return cloneProofBodyStruct(proofBody);
};

const cloneDisputeEvidenceIntoAccount = (
  target: AccountState,
  source: AccountState,
): void => {
  // These two maps deliberately contain different evidence:
  // - disputeProofBodiesByHash is signed-state evidence revealed to Solidity.
  // - disputeArgumentSnapshotsByHash is runtime-only positional calldata plan.
  //
  // Never let a generic clone preserve shared object aliases between them. A
  // corrupted clone can make a proof-body lookup return a snapshot object, which
  // then disables counter-dispute finalization or pairs wrong arguments with a
  // signed proof.
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
      Object.entries(source.disputeArgumentSnapshotsByHash).map(([hash, snapshot]) => [
        hash,
        cloneDisputeArgumentSnapshot(snapshot),
      ]),
    );
  } else {
    delete target.disputeArgumentSnapshotsByHash;
  }
};

const structuredCloneWorks = (value: unknown): boolean => {
  try {
    structuredClone(value);
    return true;
  } catch {
    return false;
  }
};

const findStructuredCloneFailurePath = (
  value: unknown,
  path = '$',
  seen = new Set<object>(),
): string => {
  if (structuredCloneWorks(value)) return path;
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return path;
  if (typeof value === 'function') return path;
  if (seen.has(value)) return path;
  seen.add(value);

  const mapEntries = value instanceof Map ? [...value.entries()] : undefined;
  const children: Array<[string, unknown]> = mapEntries
    ? mapEntries.flatMap(([key, entry], index) => [
        [`${path}.<map-key:${index}>`, key] as [string, unknown],
        [`${path}.<map-value:${index}>`, entry] as [string, unknown],
      ])
    : value instanceof Set
      ? [...value].map((entry, index) => [`${path}.<set:${index}>`, entry])
      : Object.entries(value).map(([key, entry]) => [`${path}.${key}`, entry]);
  for (const [childPath, child] of children) {
    if (!structuredCloneWorks(child)) {
      return findStructuredCloneFailurePath(child, childPath, seen);
    }
  }
  if (mapEntries) {
    const prefix = new Map<unknown, unknown>();
    for (let index = 0; index < mapEntries.length; index += 1) {
      const entry = mapEntries[index];
      if (!entry) continue;
      prefix.set(entry[0], entry[1]);
      if (!structuredCloneWorks(prefix)) {
        if (entry[1] && typeof entry[1] === 'object' && !(entry[1] instanceof Map)) {
          const partial: Record<string, unknown> = {};
          for (const [key, child] of Object.entries(entry[1])) {
            partial[key] = child;
            const candidate = new Map(prefix);
            candidate.set(entry[0], partial);
            if (!structuredCloneWorks(candidate)) {
              return `${path}.<map-entry:${index}>.${key}`;
            }
          }
        }
        return `${path}.<map-entry:${index}>`;
      }
    }
  }
  return path;
};

const structuredCloneOrThrow = <T>(value: T, code: string): T => {
  try {
    return structuredClone(value);
  } catch (cause) {
    const path = findStructuredCloneFailurePath(value);
    const detail = cause instanceof Error
      ? `${cause.name}:${cause.message}`
      : String(cause);
    throw new Error(`${code}:path=${path}:cause=${detail}`, { cause });
  }
};

/**
 * Creates a safe deep clone of entity state with guaranteed jBlock preservation
 * This prevents the jBlock corruption bugs that occur with manual state spreading
 */
const cloneEntityStateWithPolicy = (
  entityState: EntityState,
  forSnapshot: boolean,
  validateClone: boolean,
): EntityState => {
  const cloned = structuredCloneOrThrow(entityState, 'ENTITY_STATE_STRUCTURED_CLONE_FAILED');
  copyEntityFrameEvents(entityState, cloned);

  // CRITICAL: Validate entityId was preserved correctly.
  if (!cloned.entityId || cloned.entityId !== entityState.entityId) {
    stateHelperLog.error('clone.entity_state.entity_id_corrupt', {
      original: entityState.entityId,
      cloned: cloned.entityId,
    });
    throw new Error('cloneEntityState failed: entityId was not preserved');
  }

  // CRITICAL: Validate lastFinalizedJHeight was preserved correctly.
  if (typeof cloned.lastFinalizedJHeight !== 'number') {
    stateHelperLog.error('clone.entity_state.last_finalized_j_height_corrupt', {
      original: entityState.lastFinalizedJHeight,
      originalType: typeof entityState.lastFinalizedJHeight,
      cloned: cloned.lastFinalizedJHeight,
      clonedType: typeof cloned.lastFinalizedJHeight,
    });
    throw new Error('cloneEntityState failed: lastFinalizedJHeight was not preserved');
  }

  if (entityState.jBatchState) {
    cloned.jBatchState = cloneJBatchState(entityState.jBatchState);
  }
  if (entityState.lending) {
    cloned.lending = cloneLendingState(entityState.lending);
  }
  cloneCrossJurisdictionRoutesInState(cloned, entityState);
  for (const [accountId, account] of cloned.accounts.entries()) {
    const sourceAccount = entityState.accounts.get(accountId);
    if (sourceAccount) {
      cloneDisputeEvidenceIntoAccount(account, sourceAccount);
    }
    cloneCrossJurisdictionRoutesInAccount(account, sourceAccount ?? account);
    // Route cloning replaces several Account maps. Fork only after that final
    // shape exists, otherwise the cache points at the pre-route-clone Maps and
    // correctly (but expensively) falls back to a cold rebuild.
    if (sourceAccount && !forSnapshot) forkAccountCommitmentCache(sourceAccount, account);
  }
  if (!forSnapshot) forkEntityAccountCommitmentCache(entityState, cloned);

  // VALIDATE AT SOURCE: Guarantee type safety from this point forward.
  return validateClone ? validateEntityState(cloned, 'cloneEntityState.structuredClone') : cloned;
};

export function cloneEntityState(entityState: EntityState, forSnapshot: boolean = false): EntityState {
  return cloneEntityStateWithPolicy(entityState, forSnapshot, true);
}

/**
 * Clone state that already crossed a validation/consensus boundary.
 * External decode and proposal validation must keep using cloneEntityState().
 * Re-running cryptographic manifest validation for every private R-frame
 * transaction is redundant and blocks the browser event loop under load.
 */
export function cloneTrustedEntityState(entityState: EntityState, forSnapshot: boolean = false): EntityState {
  return cloneEntityStateWithPolicy(entityState, forSnapshot, false);
}

/**
 * Deep clone entity replica with all nested state properly cloned
 * Uses cloneEntityState as the entry point for state cloning
 */
const cloneEntityReplicaWithPolicy = (
  replica: EntityReplica,
  forSnapshot: boolean,
  validateClone: boolean,
): EntityReplica => {
  const cloned = {
    entityId: replica.entityId,
    signerId: replica.signerId,
    entityEncPubKey: replica.entityEncPubKey,
    entityEncPrivKey: replica.entityEncPrivKey,
    state: validateClone
      ? cloneEntityState(replica.state, forSnapshot)
      : cloneTrustedEntityState(replica.state, forSnapshot),
    mempool: Array.isArray(replica.mempool) ? [...replica.mempool] : [],
    ...(replica.proposal && { proposal: cloneIsolatedProposedEntityFrame(replica.proposal) }),
    ...(replica.lockedFrame && { lockedFrame: cloneIsolatedProposedEntityFrame(replica.lockedFrame) }),
    isProposer: replica.isProposer,
    ...(replica.position && { position: { ...replica.position } }),
    ...(replica.validatorExecution && {
      validatorExecution: {
        frameHash: replica.validatorExecution.frameHash,
        height: replica.validatorExecution.height,
        state: validateClone
          ? cloneEntityState(replica.validatorExecution.state)
          : cloneTrustedEntityState(replica.validatorExecution.state),
        outputs: replica.validatorExecution.outputs.map(cloneIsolatedEntityInput),
        jOutputs: replica.validatorExecution.jOutputs.map(output => structuredClone(output)),
        hashesToSign: replica.validatorExecution.hashesToSign.map(hash => ({ ...hash })),
        candidateEffects: structuredClone(replica.validatorExecution.candidateEffects),
        storageChanges: replica.validatorExecution.storageChanges.map(change => ({ ...change })),
        ...(replica.validatorExecution.consumptionNodeChanges
          ? { consumptionNodeChanges: structuredClone(replica.validatorExecution.consumptionNodeChanges) }
          : {}),
        ...(replica.validatorExecution.accountJClaimNodeChanges
          ? { accountJClaimNodeChanges: structuredClone(replica.validatorExecution.accountJClaimNodeChanges) }
          : {}),
      },
    }),
    ...(replica.certifiedFrameLineage && {
      certifiedFrameLineage: structuredClone(replica.certifiedFrameLineage),
    }),
    ...(replica.certifiedFrameAnchor && {
      certifiedFrameAnchor: structuredClone(replica.certifiedFrameAnchor),
    }),
    ...(replica.hankoWitness && {
      hankoWitness: new Map(Array.from(replica.hankoWitness.entries()).map(([hash, entry]) => [
        hash,
        { ...entry },
      ])),
    }),
    ...(replica.leaderVotes && {
      leaderVotes: new Map(Array.from(replica.leaderVotes.entries()).map(([key, vote]) => [
        key,
        cloneIsolatedEntityLeaderTimeoutVote(vote),
      ])),
    }),
    ...(replica.pendingLeaderCertificate && {
      pendingLeaderCertificate: cloneIsolatedEntityLeaderCertificate(replica.pendingLeaderCertificate),
    }),
    ...(replica.lastConsensusProgressAt !== undefined && { lastConsensusProgressAt: replica.lastConsensusProgressAt }),
    ...(replica.jHistory && {
      jHistory: {
        jurisdictionRef: replica.jHistory.jurisdictionRef,
        scannedThroughHeight: replica.jHistory.scannedThroughHeight,
        contiguousThroughHeight: replica.jHistory.contiguousThroughHeight,
        tipBlockHash: replica.jHistory.tipBlockHash,
        eventBlocks: new Map(Array.from(replica.jHistory.eventBlocks.entries()).map(([height, block]) => [
          height,
          structuredClone(block),
        ])),
        blockHashes: new Map(replica.jHistory.blockHashes),
      },
    }),
    ...(replica.jPrefixRound && { jPrefixRound: structuredClone(replica.jPrefixRound) }),
    ...(replica.jSubmitState && { jSubmitState: structuredClone(replica.jSubmitState) }),
    ...(replica.entityProviderActionSubmitState && {
      entityProviderActionSubmitState: structuredClone(replica.entityProviderActionSubmitState),
    }),
  } as EntityReplica;
  if (!validateClone) {
    if (cloned.entityId !== cloned.state.entityId) {
      throw new Error('TRUSTED_ENTITY_REPLICA_CLONE_ID_MISMATCH');
    }
    return cloned;
  }
  return validateEntityReplica(cloned, 'cloneEntityReplica');
};

export const cloneEntityReplica = (replica: EntityReplica, forSnapshot: boolean = false): EntityReplica =>
  cloneEntityReplicaWithPolicy(replica, forSnapshot, true);

export const cloneTrustedEntityReplica = (
  replica: EntityReplica,
  forSnapshot: boolean = false,
): EntityReplica => cloneEntityReplicaWithPolicy(replica, forSnapshot, false);

// === ACCOUNT MACHINE HELPERS ===

/**
 * Clone AccountState for validation (replaces dryRun pattern)
 */
export function cloneAccountState(account: AccountState, forSnapshot: boolean = false): AccountState {
  if (forSnapshot) {
    const cloned = structuredCloneOrThrow(
      account,
      'ACCOUNT_SNAPSHOT_STRUCTURED_CLONE_FAILED',
    ) as AccountState;
    cloneDisputeEvidenceIntoAccount(cloned, account);
    cloneCrossJurisdictionRoutesInAccount(cloned, account);
    return cloned;
  }

  const cloned = structuredCloneOrThrow(account, 'ACCOUNT_STATE_STRUCTURED_CLONE_FAILED');
  setAccountFrameHistoryView(cloned, getAccountFrameHistoryView(account));
  cloneDisputeEvidenceIntoAccount(cloned, account);
  cloneCrossJurisdictionRoutesInAccount(cloned, account);
  forkAccountCommitmentCache(account, cloned);
  return cloned;
}
