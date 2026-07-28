/**
 * XLN State Management Helpers
 * Utilities for entity replica cloning, snapshots, and state persistence
 */

import type {
  AccountFrame,
  AccountState,
  AccountTx,
  EntityFrameEvent,
  EntityReplica,
  EntityState,
  RuntimeState,
  LendingLoan,
  LendingPoolPosition,
  LendingState,
  LogCategory,
} from './types';
import { cloneDisputeArgumentSnapshot } from './protocol/dispute/argument-snapshot';
import type { ProofBodyStruct } from '../jurisdictions/typechain-types/contracts/Depository.sol/Depository';
import { cloneProofBodyStruct } from './protocol/dispute/proof-body';
import { validateEntityReplica, validateEntityState } from './validation-utils';
import { safeStringify } from './protocol/serialization';
import {
  cloneIsolatedEntityInput,
  cloneIsolatedEntityLeaderCertificate,
  cloneIsolatedEntityLeaderTimeoutVote,
  cloneIsolatedProposedEntityFrame,
} from './protocol/runtime-input-clone';
import {
  cloneIsolatedAccountFrame,
} from './protocol/account-input-clone';
import { isLeftEntity } from './entity/id';
import { getAccountFrameHistoryView, setAccountFrameHistoryView } from './runtime/env-events';
import { getLocalSignerPrivateKey } from './account/crypto';
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
import type { Profile } from './networking/gossip';
import { createStructuredLogger } from './infra/logger';
import { getEntityLeaderState, isEntityActiveLeader } from './entity/consensus/leader';
import { forkAccountCommitmentCache } from './account/map-commitment';
import { forkEntityAccountCommitmentCache } from './entity/consensus/state-root';
import { ENTITY_FRAME_EVENT_COLLECTOR } from './entity/frame-event-collector';

const stateHelperLog = createStructuredLogger('state.helpers');
const REPLAY_OUTPUT_SIGNER_HINTS = Symbol.for('xln.runtime.replay.output-signer-hints');
type EntityStateWithFrameEvents = EntityState & {
  [ENTITY_FRAME_EVENT_COLLECTOR]?: EntityFrameEvent[];
};

const mutableEntityFrameEvents = (state: EntityState): EntityFrameEvent[] => {
  const transient = state as EntityStateWithFrameEvents;
  if (!transient[ENTITY_FRAME_EVENT_COLLECTOR]) {
    /*
     * This frame-local field is deliberately enumerable while the reducer is
     * running. Entity handlers use ordinary immutable object spreads; a Symbol
     * or non-enumerable property silently vanished at those boundaries and
     * could make validators derive different signed event lists. Storage and
     * state-root projections use explicit field allowlists, so this collector
     * is never durable consensus state. The next frame clears it before apply.
     */
    transient[ENTITY_FRAME_EVENT_COLLECTOR] = [];
  }
  return transient[ENTITY_FRAME_EVENT_COLLECTOR]!;
};

export const readEntityFrameEvents = (state: EntityState): EntityFrameEvent[] =>
  structuredClone(mutableEntityFrameEvents(state));

export const clearEntityFrameEvents = (state: EntityState): void => {
  const events = (state as EntityStateWithFrameEvents)[ENTITY_FRAME_EVENT_COLLECTOR];
  if (events) events.length = 0;
};

const copyEntityFrameEvents = (source: EntityState, target: EntityState): void => {
  const events = (source as EntityStateWithFrameEvents)[ENTITY_FRAME_EVENT_COLLECTOR];
  if (!events) return;
  (target as EntityStateWithFrameEvents)[ENTITY_FRAME_EVENT_COLLECTOR] = structuredClone(events);
};

export const installReplayOutputSignerHints = (
  env: RuntimeState,
  hints: ReadonlyMap<string, string>,
): void => {
  const canonical = new Map<string, string>();
  for (const [rawEntityId, rawSignerId] of hints) {
    const entityId = String(rawEntityId || '').trim().toLowerCase();
    const signerId = String(rawSignerId || '').trim().toLowerCase();
    if (!entityId || !signerId) {
      throw new Error('REPLAY_OUTPUT_SIGNER_HINT_INVALID');
    }
    canonical.set(entityId, signerId);
  }
  Object.defineProperty(env, REPLAY_OUTPUT_SIGNER_HINTS, {
    value: canonical,
    configurable: true,
    enumerable: false,
    writable: false,
  });
};

export const clearReplayOutputSignerHints = (env: RuntimeState): void => {
  delete (env as unknown as Record<PropertyKey, unknown>)[REPLAY_OUTPUT_SIGNER_HINTS];
};

const replayOutputSignerHint = (env: RuntimeState, entityId: string): string | null => {
  const hints = (env as unknown as Record<PropertyKey, unknown>)[REPLAY_OUTPUT_SIGNER_HINTS];
  return hints instanceof Map ? String(hints.get(entityId) || '') || null : null;
};
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

// Message size limit for snapshot efficiency
export const ENTITY_MESSAGE_HISTORY_LIMIT = 100;

/**
 * CANONICAL ACCOUNT KEY: Bilateral accounts stored in sorted form (left < right)
 * Pattern from Channel.ts - ensures both entities reference SAME account object
 */
export function canonicalAccountKey(entity1: string, entity2: string): string {
  return isLeftEntity(entity1, entity2) ? `${entity1}:${entity2}` : `${entity2}:${entity1}`;
}

/**
 * Get account perspective: Am I left or right? Derive from/to for current operation.
 */
export function getAccountPerspective(account: AccountState, myEntityId: string): {
  iAmLeft: boolean;
  from: string;
  to: string;
  counterparty: string;
} {
  const iAmLeft = myEntityId === account.leftEntity;
  return {
    iAmLeft,
    from: iAmLeft ? account.leftEntity : account.rightEntity,
    to: iAmLeft ? account.rightEntity : account.leftEntity,
    counterparty: iAmLeft ? account.rightEntity : account.leftEntity,
  };
}

/**
 * Add message to EntityState with automatic size limiting
 * Prevents unbounded message array growth that causes snapshot bloat
 */
export function addMessage(state: EntityState, message: string): void {
  mutableEntityFrameEvents(state).push({ type: 'status', message });
  state.messages.push(message);
  if (state.messages.length > ENTITY_MESSAGE_HISTORY_LIMIT) {
    state.messages.shift(); // Remove oldest message
  }
}

export function addTextMessage(state: EntityState, validatorId: string, message: string): void {
  mutableEntityFrameEvents(state).push({
    type: 'text',
    validatorId: validatorId.trim().toLowerCase(),
    message,
  });
  state.messages.push(`${validatorId}: ${message}`);
  if (state.messages.length > ENTITY_MESSAGE_HISTORY_LIMIT) state.messages.shift();
}

/**
 * Add multiple messages with size limiting
 */
export function addMessages(state: EntityState, messages: string[]): void {
  for (const msg of messages) {
    addMessage(state, msg);
  }
}

type FingerprintableTx = {
  type: string;
  data?: unknown;
};

export function txFingerprint(tx: FingerprintableTx): string {
  if (tx.type !== 'consensusOutput' || !tx.data || typeof tx.data !== 'object' || Array.isArray(tx.data)) {
    return `${tx.type}:${safeStringify(tx.data)}`;
  }
  // consumptionProof is a target-proposer witness over the target pre-state.
  // It is deliberately absent from the transported mempool item and added only
  // to the proposed frame. Including it would make a committed output impossible
  // to remove from the mempool, causing an endless idempotent replay loop.
  const { consumptionProof: _targetWitness, ...certifiedOutput } = tx.data as Record<string, unknown>;
  return `${tx.type}:${safeStringify(certifiedOutput)}`;
}

export function removeCommittedTxsFromMempool<T extends FingerprintableTx>(
  mempool: T[],
  committedTxs: readonly T[],
): T[] {
  if (committedTxs.length === 0 || mempool.length === 0) return mempool;
  const pendingRemovals = new Map<string, number>();
  for (const tx of committedTxs) {
    const fp = txFingerprint(tx);
    pendingRemovals.set(fp, (pendingRemovals.get(fp) ?? 0) + 1);
  }
  return mempool.filter((tx) => {
    const fp = txFingerprint(tx);
    const remaining = pendingRemovals.get(fp) ?? 0;
    if (remaining <= 0) return true;
    if (remaining === 1) pendingRemovals.delete(fp);
    else pendingRemovals.set(fp, remaining - 1);
    return false;
  });
}

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

/**
 * Emit structured events with a scoped path for time-travel debugging.
 * This keeps per-frame logs queryable without bloating state.messages.
 */
export function emitScopedEvents(
  env: RuntimeState,
  category: LogCategory,
  scope: string,
  messages: string[],
  data: Record<string, unknown> = {},
  entityId?: string,
): void {
  if (!messages || messages.length === 0) return;

  const payload = { path: scope, ...data };
  for (const message of messages) {
    env.info(category, message, payload, entityId);
  }
}

/**
 * Resolve the proposer signerId for a given entity.
 * Prefers local proposer replica, then exact local replica signer, then local
 * config validators[0], then gossip board[0].
 * Throws if no signer can be resolved (fail early).
 */
export function resolveEntityProposerId(env: RuntimeState, entityId: string, context: string): string {
  const targetEntityId = String(entityId || '').toLowerCase();
  let localKeyReplicaFallback: string | null = null;
  let configFallback: string | null = null;
  let gossipFallback: string | null = null;

  for (const [replicaKey, replica] of env.eReplicas.entries()) {
    const keyParts = String(replicaKey).split(':');
    const keyEntityId = String(keyParts[0] || '').toLowerCase();
    const replicaEntityId = String(replica.entityId || '').toLowerCase();
    if (replicaEntityId !== targetEntityId && keyEntityId !== targetEntityId) continue;
    const replicaSignerId = String(replica.signerId || keyParts[1] || '').trim();
    const configuredValidators = replica.state.config.validators || [];
    if (isEntityActiveLeader(replica) && replicaSignerId && getLocalSignerPrivateKey(env, replicaSignerId)) return replicaSignerId;
    if (!localKeyReplicaFallback && replicaSignerId && getLocalSignerPrivateKey(env, replicaSignerId)) {
      localKeyReplicaFallback = replicaSignerId;
    }
    if (!configFallback) {
      configFallback = getEntityLeaderState(replica.state).activeValidatorId || configuredValidators[0] || null;
    }
  }

  if (env.gossip?.getProfiles) {
    const profile = (env.gossip.getProfiles() as Profile[]).find(
      (p) => String(p.entityId || '').toLowerCase() === targetEntityId,
    );
    const board = profile?.metadata.board;
    if (board && Array.isArray(board.validators) && board.validators.length > 0) {
      const first = board.validators[0];
      gossipFallback = first?.signerId || first?.signer || null;
    }
  }

  if (localKeyReplicaFallback) return localKeyReplicaFallback;
  if (configFallback && getLocalSignerPrivateKey(env, configFallback)) return configFallback;
  // Sparse-WAL replay runs before gossip/network infrastructure is attached.
  // The same atomically hashed WAL record already contains the durable outbox,
  // so its exact Account-output signer is valid local routing evidence. This
  // hint never enters Entity/Account consensus state and is cleared after each
  // replayed R-frame.
  const replayHint = replayOutputSignerHint(env, targetEntityId);
  if (replayHint) return replayHint;
  if (gossipFallback) return gossipFallback;
  if (configFallback) return configFallback;

  throw new Error(`SIGNER_RESOLUTION_FAILED: ${context} entityId=${entityId}`);
}

// === CLONING UTILITIES ===
export const cloneMap = <K, V>(map: Map<K, V>) => new Map(map);
export const cloneArray = <T>(arr: T[]) => [...arr];

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
    state: validateClone
      ? cloneEntityState(replica.state, forSnapshot)
      : cloneTrustedEntityState(replica.state, forSnapshot),
    mempool: Array.isArray(replica.mempool) ? cloneArray(replica.mempool) : [],
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
