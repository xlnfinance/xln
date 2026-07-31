export const getReplicaJRangeValidationError = (
  env: EntityRuntimeContext,
  replica: EntityReplica,
  txs: EntityTx[],
): string | null => {
  try {
    const budgetError = getEntityFrameJRangeBudgetError(txs);
    if (budgetError) return budgetError;
    const activeProposerId = getEntityLeaderState(replica.state).activeValidatorId;
    for (const tx of txs) {
      if (tx.type !== 'j_event') continue;
      const error = getJEventRangeValidationError(
        replica.state,
        replica.jHistory,
        tx.data,
        activeProposerId,
        (signerId, digest, signature) => verifyAccountSignature(env, signerId, digest, signature),
      );
      if (error) return error;
    }
  } catch (error) {
    if (isCertifiedJHistoryCorruption(error)) throw error;
    return error instanceof Error ? error.message : String(error);
  }
  return null;
};

export const assertProposerJRangesMatchLocalHistory = (
  env: EntityRuntimeContext,
  replica: EntityReplica,
  txs: EntityTx[],
): void => {
  const error = getReplicaJRangeValidationError(env, replica, txs);
  if (error) throw new Error(`ENTITY_PROPOSER_J_RANGE_INVALID:${error}`);
};

export const getFrameJPrefixValidationError = (
  env: EntityRuntimeContext,
  replica: EntityReplica,
  frame: EntityFrame,
): string | null => {
  try {
    assertFrameJPrefix(env, replica, frame);
    return null;
  } catch (error) {
    if (isCertifiedJHistoryCorruption(error)) throw error;
    return error instanceof Error ? error.message : String(error);
  }
};

export const isJPrefixLocalFreshnessRace = (error: string): boolean =>
  error === 'J_PREFIX_STRONGER_LOCAL_CERTIFICATE' || error === 'J_PREFIX_REQUIRED_LOCAL_EVENT';

export const pruneReplicaFinalizedJHistory = (replica: EntityReplica): void => {
  const pruned = pruneFinalizedValidatorJHistory(replica.jHistory, replica.state.lastFinalizedJHeight);
  if (pruned) replica.jHistory = pruned;
  else delete replica.jHistory;
};

const clearCommittedJPrefixRound = (replica: EntityReplica): void => {
  if (replica.jPrefixRound && replica.jPrefixRound.targetEntityHeight <= replica.state.height) {
    delete replica.jPrefixRound;
  }
};

export const ensureLocalJPrefixAttestation = (
  env: EntityRuntimeContext,
  replica: EntityReplica,
  entityOutbox: EntityOutput[],
  force: boolean,
): boolean => {
  if (hasCurrentRoundJPrefixAttestation(replica)) return false;
  if (replica.proposal || replica.lockedFrame) return false;
  if (
    !force &&
    !entityRequiresJPrefixCertificate(replica.state) &&
    !hasPendingLocalJEvent(replica.state, replica.jHistory)
  ) {
    return false;
  }
  const history = replica.jHistory;
  if (!history) return false;
  if (history.scannedThroughHeight < replica.state.lastFinalizedJHeight) {
    throw new Error(
      `J_PREFIX_LOCAL_HISTORY_BEHIND:${history.scannedThroughHeight}:` + `${replica.state.lastFinalizedJHeight}`,
    );
  }
  if (getLocalJPrefixAttestableHeight(replica.state, history) === null) {
    entityLog.debug('j_prefix.local_attestation_deferred', {
      entity: shortId(replica.entityId),
      baseHeight: replica.state.lastFinalizedJHeight,
      scannedThroughHeight: history.scannedThroughHeight,
      contiguousThroughHeight: getValidatorJContiguousThroughHeight(replica.state, history),
      reason: 'authenticated_headers_incomplete',
    });
    return false;
  }
  const attestation = buildLocalJPrefixAttestation(env, replica, history);
  if (!attestation) {
    throw new Error(`J_PREFIX_LOCAL_ATTESTATION_MISSING:${replica.entityId}:${history.scannedThroughHeight}`);
  }
  const sourceValidatorId = replica.signerId.trim().toLowerCase();
  replica.jPrefixRound = mergeJPrefixAttestations(
    env,
    replica.state,
    replica.jPrefixRound,
    new Map([[sourceValidatorId, attestation]]),
  );
  replica.lastConsensusProgressAt = env.state.timestamp;
  for (const validatorId of replica.state.config.validators) {
    if (validatorId.trim().toLowerCase() === sourceValidatorId) continue;
    entityOutbox.push({
      entityId: replica.entityId,
      signerId: validatorId,
      jPrefixAttestations: new Map([[sourceValidatorId, structuredClone(attestation)]]),
    });
  }
  return true;
};

/**
 * Carry due J work observed after this validator cast its previous-round vote
 * into the next Entity round immediately after commit.
 *
 * A signed prefix is immutable for its Entity height. The watcher therefore
 * keeps a later scan in durable validator-local history. A semantic event
 * must not wait for unrelated Entity traffic,
 * so deriving that due vote here is a deterministic consequence of the commit.
 * An empty suffix remains local and is certified by the next real Entity frame
 * instead of creating one itself.
 */
const advanceLocalJPrefixRoundAfterCommit = (
  env: EntityRuntimeContext,
  replica: EntityReplica,
  entityOutbox: EntityOutput[],
): void => {
  clearCommittedJPrefixRound(replica);
  if (!hasDueLocalJPrefixAdvance(replica.state, replica.jHistory)) return;
  if (!ensureLocalJPrefixAttestation(env, replica, entityOutbox, false)) return;
  const round = replica.jPrefixRound!;
  if (
    isEntityActiveLeader(replica) &&
    round.certificate &&
    round.certificate.selected.scannedThroughHeight > replica.state.lastFinalizedJHeight
  ) {
    // Empty addressed inputs are the canonical immediate consensus wake. The
    // signed head itself is already in the same durable replica projection.
    entityOutbox.push({ entityId: replica.entityId, signerId: replica.signerId, entityTxs: [] });
  }
};

export const runLocalPostCommitHooks = async (
  env: EntityRuntimeContext,
  replica: EntityReplica,
  entityOutbox: EntityOutput[],
): Promise<void> => {
  advanceLocalJPrefixRoundAfterCommit(env, replica, entityOutbox);
  await emitDefaultProposerHtlcOnionAdvances(env, replica, entityOutbox);
};
import { verifyAccountSignature } from '../../account/crypto';
import { shortId } from '../../infra/logger';
import {
  assertFrameJPrefix,
  buildLocalJPrefixAttestation,
  entityRequiresJPrefixCertificate,
  getLocalJPrefixAttestableHeight,
  hasCurrentRoundJPrefixAttestation,
  hasDueLocalJPrefixAdvance,
  hasPendingLocalJEvent,
  mergeJPrefixAttestations,
} from '../../jurisdiction/machine/j-prefix-consensus';
import {
  getJEventRangeValidationError,
  getValidatorJContiguousThroughHeight,
  isCertifiedJHistoryCorruption,
  pruneFinalizedValidatorJHistory,
} from '../../jurisdiction/machine/local-history';
import { getEntityFrameJRangeBudgetError } from '../../jurisdiction/machine/range-budget';
import type { EntityTx } from '../../types/entity-tx';
import { emitDefaultProposerHtlcOnionAdvances } from '../htlc-onion-post-commit';
import type { EntityRuntimeContext } from '../runtime-context';
import type { EntityOutput, EntityReplica, EntityFrame } from '../types';
import { getEntityLeaderState, isEntityActiveLeader } from './leader';
import { entityLog } from './entity-log';
