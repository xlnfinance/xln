/**
 * Entity consensus: validator replicas agree on entity frames, then route
 * committed account/J-layer side effects back into the runtime.
 */

import { signAccountFrame, verifyAccountSignature } from '../../account/crypto';
import { cacheCommittedAccountJClaimNodeChanges } from '../../account/j-claim-store';
import { assertEntityConfigBoardAuthority, buildQuorumHanko, signEntityHashes } from '../../hanko/signing';
import { logError, shortHash, shortId } from '../../infra/logger';
import { cumulativeMarksToPhases } from '../../infra/perf-profile';
import {
  assertFrameJPrefix,
  buildCertifiedJPrefixTx,
  buildJPrefixCertificate,
  entityRequiresJPrefixCertificate,
  getJPrefixAttestationTemporalDisposition,
  hasDueLocalJPrefixAdvance,
  hasPendingLocalJEvent,
  isFrozenBaseJPrefixRollAuthorized,
  mergeJPrefixAttestations,
  verifyOutOfRoundJPrefixAttestation,
} from '../../jurisdiction/j-prefix-consensus';
import {
  cloneIsolatedEntityInput,
  cloneIsolatedEntityLeaderCertificate,
  cloneIsolatedEntityLeaderTimeoutVote,
  cloneIsolatedProposedEntityFrame,
} from '../../protocol/runtime-input-clone';
import { applyStorageChanges, publishEntityCandidateEffects } from '../../runtime/env-events';
import { nodeProcess } from '../../runtime/platform';
import { cloneEntityReplica, removeCommittedTxsFromMempool } from '../../state-helpers';
import type {
  EntityInput,
  EntityLeaderTimeoutVote,
  EntityReplica,
  EntityState,
  EntityTx,
  Env,
  HankoString,
  JInput,
  ProposedEntityFrame,
  ValidatorEntityFrameExecution,
} from '../../types';
import { DEBUG, formatEntityDisplay, getPerfMs, HEAVY_LOGS, log } from '../../utils';
import { prepareLocallyAuthoredEntityTxs } from '../command';
import { cacheCommittedConsumptionNodeChanges } from '../consumption-store';
import { appendDefaultProposerCrossJMaterializations } from '../cross-j-proposer-materialization';
import { appendDefaultProposerAcceptedHtlcReveals } from '../htlc-onion-post-commit';
import { emitCommittedPendingFrameWarnings } from '../scheduler';
import { assertLocalJRebroadcastAllowed } from '../tx/handlers/j-rebroadcast';
import { accountHasProposableMempool } from './account-mempool-eligibility';
import { createEntityFrameHashFromStateRoot, isCanonicalEntityFrameDigest } from './frame';
import {
  attachHankoWitnessToOutputs,
  buildEntityHashesToSign,
  getEntityHashManifestMismatch,
  isWitnessHashType,
  normalizeProposedFrameCollectedSigs,
  pruneHankoWitnessToReachableState,
  sealHankoWitnessInState,
  type HankoWitnessEntry,
} from './hanko-witness';
import { prioritizeScheduledWakeTransactions } from './input-merge';
import {
  assertEntityLeaderVoteMatchesState,
  buildEntityLeaderCertificate,
  copyLocalEntityLeaderTimeoutVoteAuthorization,
  getEntityLeaderState,
  getEntityQuorumSafetyWarning,
  getReplicaProposalLeader,
  hashEntityLeaderVoteBody,
  isEntityActiveLeader,
  isLocalEntityLeaderTimeoutVote,
  isReplicaProposalLeader,
  leaderVoteCollectionKey,
} from './leader';
import { buildCertifiedEntityOutputHashes } from './output-certification';
import {
  buildEntityFrameAuthority,
  computeCanonicalEntityConsensusStateHash,
  computeEntityFrameAuthorityRoot,
  encodeCanonicalEntityConsensusValue,
} from './state-root';

import { applyEntityFrame } from './frame-application';
import {
  appendCertifiedEntityFrameLink,
  assertFrameParentMatchesState,
  assertProposerJRangesMatchLocalHistory,
  buildCertifiedEntityFrameLink,
  calculateQuorumPower,
  emitCommittedEntitySizeLog,
  ensureLocalJPrefixAttestation,
  entityFrameProfileEnabled,
  entityFrameSlowMs,
  entityLog,
  expectedCommittedLeaderState,
  getEntityMempoolAdmissionError,
  getFrameJPrefixValidationError,
  getPrevFrameHash,
  getReplicaJRangeValidationError,
  getValidatorExecutionForFrame,
  hasVerifiedPreparedQuorum,
  isJPrefixLocalFreshnessRace,
  isSingleSignerEntity,
  normalizePrecommitBundles,
  prepareCommittedEntitySizeLog,
  pruneReplicaFinalizedJHistory,
  runLocalPostCommitHooks,
  selectPreparedFrameFromCertificate,
  selectProposableEntityTxs,
  validateEntityInput,
  validateEntityReplica,
  validateProposedFrameLeader,
  validateVotingPower,
  verifyHashPrecommitSignatures,
  wrapCertifiedEntityOutputs,
} from './shared';

const replayPreparedFrameForRelay = async (
  env: Env,
  replica: EntityReplica,
  frame: ProposedEntityFrame,
): Promise<ValidatorEntityFrameExecution> => {
  assertFrameParentMatchesState(replica.state, frame, 'ENTITY_PREPARED_PARENT_MISMATCH');
  const jRangeError = getReplicaJRangeValidationError(env, replica, frame.txs);
  if (jRangeError) throw new Error(`ENTITY_PREPARED_J_RANGE_MISMATCH:${jRangeError}`);
  assertFrameJPrefix(env, replica, frame);
  const {
    newState,
    collectedHashes = [],
    outputs,
    jOutputs,
    candidateEffects,
    storageChanges,
    consumptionNodeChanges,
    accountJClaimNodeChanges,
  } = await applyEntityFrame(env, replica.state, frame.txs, frame.timestamp);
  const replayedState = {
    ...newState,
    entityId: replica.state.entityId,
    height: frame.height,
    timestamp: frame.timestamp,
    leaderState: expectedCommittedLeaderState(replica.state, frame),
  };
  const replayedStateRoot = computeCanonicalEntityConsensusStateHash(replayedState);
  if (replayedStateRoot !== frame.stateRoot) {
    throw new Error(`ENTITY_PREPARED_STATE_ROOT_MISMATCH:expected=${replayedStateRoot}:received=${frame.stateRoot}`);
  }
  const replayedAuthorityRoot = computeEntityFrameAuthorityRoot(buildEntityFrameAuthority(replayedState));
  if (replayedAuthorityRoot !== frame.authorityRoot) {
    throw new Error(
      `ENTITY_PREPARED_AUTHORITY_ROOT_MISMATCH:expected=${replayedAuthorityRoot}:received=${frame.authorityRoot}`,
    );
  }
  const replayedHash = createEntityFrameHashFromStateRoot(
    getPrevFrameHash(replica.state),
    frame.height,
    frame.timestamp,
    frame.txs,
    replayedState.entityId,
    replayedStateRoot,
    replayedAuthorityRoot,
    frame.jPrefixCertificate,
  );
  if (replayedHash !== frame.hash) {
    throw new Error(`ENTITY_PREPARED_FRAME_HASH_MISMATCH:expected=${replayedHash}:received=${frame.hash}`);
  }
  const outputHashes = buildCertifiedEntityOutputHashes(replayedState, env, frame.height, replayedHash, outputs);
  const manifest = buildEntityHashesToSign(replica.entityId, frame.height, replayedHash, [
    ...collectedHashes,
    ...outputHashes,
  ]);
  const manifestMismatch = getEntityHashManifestMismatch(manifest, frame.hashesToSign);
  if (manifestMismatch) throw new Error(`ENTITY_PREPARED_MANIFEST_MISMATCH:${manifestMismatch}`);
  return {
    frameHash: frame.hash,
    height: frame.height,
    state: replayedState,
    outputs,
    jOutputs,
    hashesToSign: manifest,
    candidateEffects,
    storageChanges,
    ...(consumptionNodeChanges ? { consumptionNodeChanges } : {}),
    ...(accountJClaimNodeChanges ? { accountJClaimNodeChanges } : {}),
  };
};

export type EntityInputOutcome =
  | { kind: 'committed' }
  | { kind: 'noop'; reason: string }
  | { kind: 'deferred'; reason: string }
  | { kind: 'rejected'; code: string };

type ApplyEntityInputResult = {
  outcome: EntityInputOutcome;
  newState: EntityState;
  outputs: EntityInput[];
  jOutputs: JInput[];
  workingReplica: EntityReplica;
  canonicalAppliedInput?: EntityInput;
};

type ApplyEntityInputContext = {
  env: Env;
  entityInput: EntityInput;
  workingReplica: EntityReplica;
  entityOutbox: EntityInput[];
  jOutbox: JInput[];
  frameHash: string;
  canonicalAppliedInput?: EntityInput;
};

const commitEntityConsensusInput = (context: ApplyEntityInputContext): ApplyEntityInputResult => ({
  outcome: { kind: 'committed' },
  newState: context.workingReplica.state,
  outputs: context.entityOutbox,
  jOutputs: context.jOutbox,
  workingReplica: context.workingReplica,
  ...(context.canonicalAppliedInput ? { canonicalAppliedInput: context.canonicalAppliedInput } : {}),
});

const noopEntityConsensusInput = (context: ApplyEntityInputContext, reason: string): ApplyEntityInputResult => ({
  outcome: { kind: 'noop', reason },
  newState: context.workingReplica.state,
  outputs: [],
  jOutputs: [],
  workingReplica: context.workingReplica,
});

const deferEntityConsensusInput = (context: ApplyEntityInputContext, reason: string): ApplyEntityInputResult => ({
  outcome: { kind: 'deferred', reason },
  newState: context.workingReplica.state,
  outputs: [],
  jOutputs: [],
  workingReplica: context.workingReplica,
});

const rejectEntityConsensusInput = (
  context: ApplyEntityInputContext,
  code = 'ENTITY_CONSENSUS_REJECTED',
): ApplyEntityInputResult => ({
  outcome: { kind: 'rejected', code },
  newState: context.workingReplica.state,
  outputs: [],
  jOutputs: [],
  workingReplica: context.workingReplica,
});

const handleJPrefixAttestations = (context: ApplyEntityInputContext): ApplyEntityInputResult | null => {
  const { env, entityInput, workingReplica, entityOutbox } = context;
  const incoming = entityInput.jPrefixAttestations;
  if (!incoming) return null;
  if (!(incoming instanceof Map) || incoming.size === 0) {
    return rejectEntityConsensusInput(context, 'J_PREFIX_ATTESTATION_INVALID');
  }
  const authorityConfigs = [
    workingReplica.state.config,
    ...(workingReplica.certifiedFrameAnchor ? [workingReplica.certifiedFrameAnchor.authority.config] : []),
    ...(workingReplica.certifiedFrameLineage ?? []).map(link => link.postAuthority.config),
  ];
  let outOfRoundDisposition: 'stale' | 'current' | 'future';
  try {
    const dispositions = new Set(
      [...incoming.values()].map(attestation =>
        getJPrefixAttestationTemporalDisposition(workingReplica.state, attestation),
      ),
    );
    if (dispositions.size !== 1) throw new Error('J_PREFIX_MIXED_TARGET_HEIGHTS');
    outOfRoundDisposition = dispositions.values().next().value!;
    if (outOfRoundDisposition !== 'current') {
      for (const [rawSignerId, rawAttestation] of incoming) {
        const attestation = verifyOutOfRoundJPrefixAttestation(
          env,
          workingReplica.state,
          rawAttestation,
          authorityConfigs,
        );
        if (rawSignerId.trim().toLowerCase() !== attestation.validatorId) {
          throw new Error(`J_PREFIX_MAP_SIGNER_MISMATCH:${rawSignerId}`);
        }
      }
    }
  } catch (error) {
    entityLog.error('j_prefix.attestation_rejected', {
      error: error instanceof Error ? error.message : String(error),
    });
    return rejectEntityConsensusInput(context, 'J_PREFIX_ATTESTATION_REJECTED');
  }
  if (outOfRoundDisposition === 'future') {
    return deferEntityConsensusInput(context, 'J_PREFIX_FUTURE_HEIGHT');
  }
  if (outOfRoundDisposition === 'stale') {
    entityLog.debug('j_prefix.attestation_stale_terminal', {
      targetEntityHeight: incoming.values().next().value!.targetEntityHeight,
      currentEntityHeight: workingReplica.state.height,
    });
    // The vote may have become stale only because unrelated Account/Entity
    // traffic committed while the watcher input was queued. Its authenticated
    // local J-history is still an unfulfilled obligation. Re-derive one vote
    // for the current parent immediately; otherwise a single-signer Entity can
    // permanently strand AccountSettled at H+1 with no later ingress to wake it.
    // The stale bytes remain terminal and never enter the new round.
    if (
      hasDueLocalJPrefixAdvance(workingReplica.state, workingReplica.jHistory) &&
      ensureLocalJPrefixAttestation(env, workingReplica, entityOutbox, false)
    )
      return null;
    return commitEntityConsensusInput(context);
  }
  const priorRound = workingReplica.jPrefixRound;
  const priorHeads = encodeCanonicalEntityConsensusValue(priorRound?.attestations ?? new Map());
  let merged;
  try {
    merged = mergeJPrefixAttestations(env, workingReplica.state, workingReplica.jPrefixRound, incoming);
  } catch (error) {
    entityLog.error('j_prefix.attestation_rejected', {
      error: error instanceof Error ? error.message : String(error),
    });
    return rejectEntityConsensusInput(context, 'J_PREFIX_ATTESTATION_REJECTED');
  }
  const nextHeads = encodeCanonicalEntityConsensusValue(merged.attestations);
  const changed = priorHeads !== nextHeads;
  if (changed && (workingReplica.proposal || workingReplica.lockedFrame)) {
    // Once a validator has signed/locked a frame, a later head belongs to the
    // next Entity height. Mutating this round would let the same validator
    // authorize two different maximum-prefix frames.
    return rejectEntityConsensusInput(context, 'J_PREFIX_ROUND_FROZEN');
  }
  workingReplica.jPrefixRound = merged;
  if (changed) workingReplica.lastConsensusProgressAt = env.timestamp;

  for (const [signerId, attestation] of incoming) {
    const normalizedSignerId = signerId.trim().toLowerCase();
    if (normalizedSignerId !== workingReplica.signerId.trim().toLowerCase()) continue;
    const previous = priorRound?.attestations.get(normalizedSignerId);
    if (
      previous &&
      encodeCanonicalEntityConsensusValue(previous) === encodeCanonicalEntityConsensusValue(attestation)
    ) {
      continue;
    }
    for (const validatorId of workingReplica.state.config.validators) {
      if (validatorId.trim().toLowerCase() === normalizedSignerId) continue;
      entityOutbox.push({
        entityId: workingReplica.entityId,
        signerId: validatorId,
        jPrefixAttestations: new Map([[normalizedSignerId, structuredClone(attestation)]]),
      });
    }
  }
  return null;
};

async function handleLeaderTimeoutVote(context: ApplyEntityInputContext): Promise<ApplyEntityInputResult | null> {
  const { env, entityInput, workingReplica, entityOutbox } = context;
  const incoming = entityInput.leaderTimeoutVote;
  if (!incoming) return null;
  try {
    assertEntityLeaderVoteMatchesState(workingReplica.state, incoming);
  } catch (error) {
    entityLog.warn('leader.vote.rejected', { error: error instanceof Error ? error.message : String(error) });
    return rejectEntityConsensusInput(context);
  }

  const voterId = incoming.voterId.toLowerCase();
  const isValidator = workingReplica.state.config.validators.some(validator => validator.toLowerCase() === voterId);
  if (!isValidator) return rejectEntityConsensusInput(context);
  const voteHash = hashEntityLeaderVoteBody(incoming);
  let vote: EntityLeaderTimeoutVote = incoming;
  if (isLocalEntityLeaderTimeoutVote(incoming)) {
    if (voterId !== workingReplica.signerId.toLowerCase() || incoming.signature) {
      return rejectEntityConsensusInput(context);
    }
    vote = { ...incoming, signature: await signAccountFrame(env, workingReplica.signerId, voteHash) };
    // The scheduler creates an explicitly local unsigned intent. Consensus turns
    // it into the signed protocol value, and that exact value must enter the WAL
    // and reliable-receipt path. Persisting the unsigned intent would lose its
    // non-enumerable local authorization on restart and make replay reject it.
    context.canonicalAppliedInput = {
      ...entityInput,
      leaderTimeoutVote: cloneIsolatedEntityLeaderTimeoutVote(vote),
    };
    workingReplica.lastConsensusProgressAt = env.timestamp;
    for (const validatorId of workingReplica.state.config.validators) {
      if (validatorId.toLowerCase() === workingReplica.signerId.toLowerCase()) continue;
      entityOutbox.push({
        entityId: entityInput.entityId,
        signerId: validatorId,
        leaderTimeoutVote: vote,
      });
    }
  } else if (!verifyAccountSignature(env, voterId, voteHash, incoming.signature)) {
    return rejectEntityConsensusInput(context);
  }

  const collectionKey = leaderVoteCollectionKey(vote);
  const previousCollectionKey = workingReplica.leaderVotes?.values().next().value as
    EntityLeaderTimeoutVote | undefined;
  if (previousCollectionKey && leaderVoteCollectionKey(previousCollectionKey) !== collectionKey) {
    workingReplica.leaderVotes = new Map();
  }
  if (!workingReplica.leaderVotes) workingReplica.leaderVotes = new Map();
  const previousVote = workingReplica.leaderVotes.get(voterId);
  if (previousVote) {
    if (encodeCanonicalEntityConsensusValue(previousVote) !== encodeCanonicalEntityConsensusValue(vote)) {
      entityLog.error('leader.vote_equivocation', { voter: shortId(voterId) });
      return rejectEntityConsensusInput(context, 'ENTITY_LEADER_VOTE_EQUIVOCATION');
    }
    return null;
  }
  workingReplica.leaderVotes.set(voterId, vote);

  const signers = Array.from(workingReplica.leaderVotes.keys());
  const power = calculateQuorumPower(workingReplica.state.config, signers);
  if (power >= workingReplica.state.config.threshold) {
    const certificate = buildEntityLeaderCertificate(vote, workingReplica.leaderVotes);
    let preparedFrame: ProposedEntityFrame | null;
    try {
      const localLockHasPreparedQuorum = workingReplica.lockedFrame
        ? hasVerifiedPreparedQuorum(env, workingReplica.state, workingReplica.lockedFrame, 'ENTITY_PREPARED_LOCAL_LOCK')
        : false;
      preparedFrame = selectPreparedFrameFromCertificate(env, workingReplica.state, certificate);
      if (!preparedFrame && localLockHasPreparedQuorum && workingReplica.lockedFrame) {
        throw new Error(`ENTITY_PREPARED_LOCAL_LOCK_OMITTED:${workingReplica.lockedFrame.hash}`);
      }
      if (
        preparedFrame &&
        workingReplica.lockedFrame &&
        localLockHasPreparedQuorum &&
        workingReplica.lockedFrame.hash !== preparedFrame.hash &&
        workingReplica.lockedFrame.leader.view >= preparedFrame.leader.view
      ) {
        throw new Error(
          `ENTITY_PREPARED_LOCK_CONFLICT:local=${workingReplica.lockedFrame.hash}:selected=${preparedFrame.hash}`,
        );
      }
      if (!preparedFrame && workingReplica.lockedFrame && !localLockHasPreparedQuorum) {
        // The higher-view quorum certificate is the durable signing fence.
        // Retaining a sub-threshold local vote as `lockedFrame` would confuse a
        // vote with a QC and make the newly certified leader unable to propose.
        delete workingReplica.lockedFrame;
        delete workingReplica.validatorExecution;
      }
    } catch (error) {
      entityLog.error('leader.prepared_certificate_rejected', {
        error: error instanceof Error ? error.message : String(error),
      });
      return rejectEntityConsensusInput(context, 'LEADER_PREPARED_CERTIFICATE_REJECTED');
    }
    if (preparedFrame) {
      certificate.preparedFrameHash = preparedFrame.hash;
      workingReplica.lockedFrame = {
        ...preparedFrame,
        leader: {
          ...preparedFrame.leader,
          relayCertificate: cloneIsolatedEntityLeaderCertificate(certificate),
        },
      };
      if (
        workingReplica.validatorExecution &&
        (workingReplica.validatorExecution.height !== preparedFrame.height ||
          workingReplica.validatorExecution.frameHash.toLowerCase() !== preparedFrame.hash.toLowerCase())
      ) {
        delete workingReplica.validatorExecution;
      }
    }
    workingReplica.pendingLeaderCertificate = certificate;
    workingReplica.lastConsensusProgressAt = env.timestamp;
    entityLog.warn('leader.view_change_certified', {
      entity: shortId(workingReplica.entityId),
      from: shortId(vote.previousLeaderId),
      to: shortId(vote.nextLeaderId),
      view: vote.toView,
      power: power.toString(),
    });
  }
  return null;
}

async function handleCommitNotification(context: ApplyEntityInputContext): Promise<ApplyEntityInputResult | null> {
  const { env, entityInput, workingReplica, entityOutbox, jOutbox } = context;
  const rawFrameCollectedSigs = entityInput.proposedFrame?.collectedSigs;
  if (!rawFrameCollectedSigs?.size || !entityInput.proposedFrame) {
    return null;
  }

  const proposedFrame = entityInput.proposedFrame;
  if (
    !isCanonicalEntityFrameDigest(proposedFrame.hash) ||
    !isCanonicalEntityFrameDigest(proposedFrame.stateRoot) ||
    !isCanonicalEntityFrameDigest(proposedFrame.authorityRoot)
  ) {
    return rejectEntityConsensusInput(context, 'COMMIT_DIGEST_NON_CANONICAL');
  }
  if (proposedFrame.height > workingReplica.state.height + 1) {
    return deferEntityConsensusInput(context, 'COMMIT_CATCH_UP_STATE_WAIT');
  }
  let frameCollectedSigs: Map<string, string[]>;
  try {
    frameCollectedSigs = normalizePrecommitBundles(
      workingReplica.state.config,
      rawFrameCollectedSigs,
      'COMMIT_REJECTED',
    );
  } catch (error) {
    entityLog.error('commit.bundle_rejected', { error: error instanceof Error ? error.message : String(error) });
    return rejectEntityConsensusInput(context, 'COMMIT_BUNDLE_REJECTED');
  }
  proposedFrame.collectedSigs = frameCollectedSigs;
  if (proposedFrame.height < workingReplica.state.height) {
    return noopEntityConsensusInput(context, 'COMMIT_STALE');
  }
  if (workingReplica.state.height === proposedFrame.height) {
    return workingReplica.state.prevFrameHash === proposedFrame.hash
      ? noopEntityConsensusInput(context, 'COMMIT_ALREADY_APPLIED')
      : rejectEntityConsensusInput(context, 'COMMIT_HEIGHT_HASH_CONFLICT');
  }
  assertFrameParentMatchesState(workingReplica.state, proposedFrame, 'COMMIT_PARENT_MISMATCH');
  if (!validateProposedFrameLeader(env, workingReplica.state, proposedFrame)) {
    return rejectEntityConsensusInput(context);
  }
  const signers = Array.from(frameCollectedSigs.keys());
  const totalPower = calculateQuorumPower(workingReplica.state.config, signers);
  if (totalPower < workingReplica.state.config.threshold) {
    return null;
  }

  if (workingReplica.lockedFrame) {
    if (workingReplica.lockedFrame.hash !== proposedFrame.hash) {
      logError('FRAME_CONSENSUS', `❌ BYZANTINE: Commit frame doesn't match locked frame!`);
      logError('FRAME_CONSENSUS', `   Locked: ${workingReplica.lockedFrame.hash}`);
      logError('FRAME_CONSENSUS', `   Commit: ${proposedFrame.hash}`);
      return rejectEntityConsensusInput(context);
    }
    entityLog.debug('commit.locked_frame_verified', { frame: shortHash(workingReplica.lockedFrame.hash) });
  }

  let execution = getValidatorExecutionForFrame(workingReplica, proposedFrame);

  // Normally use the validator-computed state. If this replica missed the proposal
  // but is exactly one frame behind, replay the signed txs locally.
  if (!execution) {
    const expectedPrevHeight = proposedFrame.height - 1;
    if (workingReplica.state.height !== expectedPrevHeight) {
      entityLog.warn('commit.catch_up_state_wait', {
        height: workingReplica.state.height,
        expectedPrevHeight,
        commitHeight: proposedFrame.height,
        frame: shortHash(proposedFrame.hash),
      });
      // A valid certificate can arrive before this validator has the exact
      // predecessor state. It is not invalid, but it must never be ACKed as
      // applied: the sender retains the authoritative reliable output and
      // retries after the missing height commits.
      return deferEntityConsensusInput(context, 'COMMIT_CATCH_UP_STATE_WAIT');
    }

    const jRangeError = getReplicaJRangeValidationError(env, workingReplica, proposedFrame.txs);
    if (jRangeError) {
      entityLog.error('commit.catch_up_j_range_rejected', { error: jRangeError });
      return rejectEntityConsensusInput(context, 'COMMIT_J_RANGE_MISMATCH');
    }
    const jPrefixError = getFrameJPrefixValidationError(env, workingReplica, proposedFrame);
    if (jPrefixError) {
      if (jPrefixError.startsWith('J_PREFIX_LOCAL_HISTORY_BEHIND:')) {
        return deferEntityConsensusInput(context, 'COMMIT_J_PREFIX_HISTORY_WAIT');
      }
      if (isJPrefixLocalFreshnessRace(jPrefixError)) {
        // This validator did not sign the historical frame: it is replaying an
        // already quorum-certified height before it can reach the later frame
        // that finalizes its newer local J observation. Reapplying proposal
        // freshness here deadlocks ordered catch-up (H cannot be skipped to
        // reach H+1). Intrinsic prefix/range/corruption checks remain mandatory,
        // and the validator still recomputes state plus every secondary hash
        // before cryptographically verifying the existing signer bundles.
        entityLog.info('commit.catch_up_local_j_prefix_ahead', {
          error: jPrefixError,
          frameHeight: proposedFrame.height,
          localFinalizedJHeight: workingReplica.state.lastFinalizedJHeight,
          localScannedThroughHeight: workingReplica.jHistory?.scannedThroughHeight ?? null,
        });
      } else {
        entityLog.error('commit.j_prefix_rejected', { error: jPrefixError });
        return rejectEntityConsensusInput(context, 'COMMIT_J_RANGE_MISMATCH');
      }
    }
    const {
      newState: replayedState,
      collectedHashes: replayedCollectedHashes = [],
      outputs: replayedOutputs,
      jOutputs: replayedJOutputs,
      candidateEffects,
      storageChanges,
      consumptionNodeChanges,
      accountJClaimNodeChanges,
    } = await applyEntityFrame(env, workingReplica.state, proposedFrame.txs, proposedFrame.timestamp);
    const replayedCommitState = {
      ...replayedState,
      entityId: workingReplica.state.entityId,
      height: proposedFrame.height,
      timestamp: proposedFrame.timestamp,
      leaderState: expectedCommittedLeaderState(workingReplica.state, proposedFrame),
    };
    const replayedStateRoot = computeCanonicalEntityConsensusStateHash(replayedCommitState);
    if (replayedStateRoot !== proposedFrame.stateRoot) {
      return rejectEntityConsensusInput(context, 'COMMIT_STATE_ROOT_MISMATCH');
    }
    const replayedAuthorityRoot = computeEntityFrameAuthorityRoot(buildEntityFrameAuthority(replayedCommitState));
    if (replayedAuthorityRoot !== proposedFrame.authorityRoot) {
      return rejectEntityConsensusInput(context, 'COMMIT_AUTHORITY_ROOT_MISMATCH');
    }
    const replayedHash = createEntityFrameHashFromStateRoot(
      getPrevFrameHash(workingReplica.state),
      proposedFrame.height,
      proposedFrame.timestamp,
      proposedFrame.txs,
      replayedCommitState.entityId,
      replayedStateRoot,
      replayedAuthorityRoot,
      proposedFrame.jPrefixCertificate,
    );
    if (replayedHash !== proposedFrame.hash) {
      logError('FRAME_CONSENSUS', `❌ COMMIT REJECTED: replayed catch-up state does not match signed frame hash!`);
      logError('FRAME_CONSENSUS', `   Expected: ${replayedHash.slice(0, 30)}...`);
      logError('FRAME_CONSENSUS', `   Received: ${proposedFrame.hash.slice(0, 30)}...`);
      return rejectEntityConsensusInput(context);
    }
    const outputHashes = buildCertifiedEntityOutputHashes(
      replayedCommitState,
      env,
      proposedFrame.height,
      replayedHash,
      replayedOutputs,
    );
    const expectedHashesToSign = buildEntityHashesToSign(
      workingReplica.state.entityId,
      proposedFrame.height,
      replayedHash,
      [...replayedCollectedHashes, ...outputHashes],
    );
    execution = {
      frameHash: proposedFrame.hash,
      height: proposedFrame.height,
      state: replayedCommitState,
      outputs: replayedOutputs,
      jOutputs: replayedJOutputs,
      hashesToSign: expectedHashesToSign,
      candidateEffects,
      storageChanges,
      ...(consumptionNodeChanges ? { consumptionNodeChanges } : {}),
      ...(accountJClaimNodeChanges ? { accountJClaimNodeChanges } : {}),
    };
    entityLog.warn('commit.catch_up_state_replayed', {
      height: proposedFrame.height,
      frame: shortHash(proposedFrame.hash),
    });
  }

  const stateToApply = execution.state;
  const expectedHashesToSign = execution.hashesToSign;

  const manifestMismatch = getEntityHashManifestMismatch(expectedHashesToSign, proposedFrame.hashesToSign);
  if (manifestMismatch) {
    logError('FRAME_CONSENSUS', `❌ BYZANTINE: Commit secondary hash manifest mismatch: ${manifestMismatch}`, {
      frame: proposedFrame.hash,
      expected: expectedHashesToSign,
      received: proposedFrame.hashesToSign ?? null,
    });
    return rejectEntityConsensusInput(context);
  }

  for (const [signerId, sigs] of frameCollectedSigs) {
    if (
      !verifyHashPrecommitSignatures(
        env,
        signerId,
        expectedHashesToSign,
        proposedFrame.hash,
        proposedFrame.height,
        sigs,
        'COMMIT_REJECTED',
      )
    ) {
      logError('FRAME_CONSENSUS', `❌ BYZANTINE: Invalid hash signature bundle from ${signerId}`);
      logError('FRAME_CONSENSUS', `   Frame hash: ${proposedFrame.hash.slice(0, 30)}...`);
      return rejectEntityConsensusInput(context);
    }
  }
  entityLog.debug('commit.signatures_verified', {
    count: frameCollectedSigs.size,
    frame: shortHash(proposedFrame.hash),
  });

  const committedHankos: HankoString[] = [];
  if (expectedHashesToSign) {
    for (let index = 0; index < expectedHashesToSign.length; index += 1) {
      const hashInfo = expectedHashesToSign[index];
      if (!hashInfo) continue;
      const signatures = Array.from(frameCollectedSigs.entries()).flatMap(([signerId, signerSigs]) => {
        const signature = signerSigs[index];
        return signature ? [{ signerId, signature }] : [];
      });
      committedHankos.push(
        await buildQuorumHanko(
          env,
          workingReplica.state.entityId,
          hashInfo.hash,
          signatures,
          workingReplica.state.config,
          stateToApply,
        ),
      );
    }
  }
  if (!workingReplica.hankoWitness) workingReplica.hankoWitness = new Map();
  for (let index = 0; index < (expectedHashesToSign?.length ?? 0); index += 1) {
    const hashInfo = expectedHashesToSign?.[index];
    const hanko = committedHankos[index];
    if (!hashInfo || !hanko || !isWitnessHashType(hashInfo.type)) continue;
    workingReplica.hankoWitness.set(hashInfo.hash, {
      hanko,
      type: hashInfo.type,
      entityHeight: proposedFrame.height,
      createdAt: env.timestamp,
    });
  }

  sealHankoWitnessInState(stateToApply, workingReplica.hankoWitness, proposedFrame.height);

  attachHankoWitnessToOutputs(
    execution.outputs,
    execution.jOutputs,
    workingReplica.hankoWitness,
    proposedFrame.height,
    stateToApply,
  );
  pruneHankoWitnessToReachableState(stateToApply, workingReplica.hankoWitness);
  const commitEmitterId =
    proposedFrame.leader.relayCertificate?.preparedFrameHash === proposedFrame.hash
      ? proposedFrame.leader.relayCertificate.nextLeaderId
      : proposedFrame.leader.proposerSignerId;
  entityOutbox.push(
    ...wrapCertifiedEntityOutputs(
      execution.outputs,
      proposedFrame,
      stateToApply,
      env,
      expectedHashesToSign,
      committedHankos,
      commitEmitterId.toLowerCase() === workingReplica.signerId.toLowerCase(),
    ),
  );
  if (commitEmitterId.toLowerCase() === workingReplica.signerId.toLowerCase()) {
    jOutbox.push(...execution.jOutputs);
  }

  const preCommitState = workingReplica.state;
  const committedState = {
    ...stateToApply,
    entityId: workingReplica.state.entityId,
    height: proposedFrame.height,
    prevFrameHash: proposedFrame.hash,
  } as EntityState;
  const entitySizeLog = prepareCommittedEntitySizeLog(env, preCommitState, committedState);
  cacheCommittedConsumptionNodeChanges(env, execution.consumptionNodeChanges);
  cacheCommittedAccountJClaimNodeChanges(env, execution.accountJClaimNodeChanges);
  workingReplica.state = committedState;
  applyStorageChanges(env, committedState, [
    ...execution.storageChanges,
    { family: 'entity', entityId: committedState.entityId },
  ]);
  emitCommittedPendingFrameWarnings(preCommitState, committedState);
  emitCommittedEntitySizeLog(entitySizeLog);
  proposedFrame.hankos = committedHankos;
  appendCertifiedEntityFrameLink(
    env,
    workingReplica,
    buildCertifiedEntityFrameLink(workingReplica.state.entityId, proposedFrame, workingReplica.state),
  );
  publishEntityCandidateEffects(env, execution.candidateEffects);
  pruneReplicaFinalizedJHistory(workingReplica);

  const committedTxs = proposedFrame.txs;
  if (committedTxs.length > 0) {
    entityLog.debug('mempool.clear_committed', {
      committed: committedTxs.length,
      before: workingReplica.mempool.length,
    });
    workingReplica.mempool = removeCommittedTxsFromMempool(workingReplica.mempool, committedTxs);
    entityLog.debug('mempool.after_commit', { remaining: workingReplica.mempool.length });
  }

  delete workingReplica.proposal;
  delete workingReplica.lockedFrame;
  delete workingReplica.validatorExecution;
  if (proposedFrame.leader.relayCertificate?.preparedFrameHash === proposedFrame.hash) {
    workingReplica.pendingLeaderCertificate = structuredClone(proposedFrame.leader.relayCertificate);
  } else {
    delete workingReplica.pendingLeaderCertificate;
  }
  workingReplica.leaderVotes = new Map();
  workingReplica.lastConsensusProgressAt = env.timestamp;
  workingReplica.isProposer = isEntityActiveLeader(workingReplica);
  await runLocalPostCommitHooks(env, workingReplica, entityOutbox);
  entityLog.debug('commit.applied', {
    height: workingReplica.state.height,
    frame: shortHash(proposedFrame.hash),
  });

  return commitEntityConsensusInput(context);
}

async function handleProposedFramePrecommit(context: ApplyEntityInputContext): Promise<ApplyEntityInputResult | null> {
  const { env, entityInput, workingReplica, entityOutbox, frameHash } = context;
  if (!entityInput.proposedFrame) return null;

  const config = workingReplica.state.config;
  const proposedFrame = entityInput.proposedFrame;
  if (proposedFrame.height < workingReplica.state.height) {
    return noopEntityConsensusInput(context, 'PROPOSAL_STALE');
  }
  if (proposedFrame.height === workingReplica.state.height) {
    return workingReplica.state.prevFrameHash === proposedFrame.hash
      ? noopEntityConsensusInput(context, 'PROPOSAL_ALREADY_COMMITTED')
      : rejectEntityConsensusInput(context, 'PROPOSAL_HEIGHT_HASH_CONFLICT');
  }
  const existingFrame = workingReplica.proposal ?? workingReplica.lockedFrame;
  if (existingFrame) {
    if (existingFrame.hash !== proposedFrame.hash) {
      if (existingFrame.height < proposedFrame.height) {
        return deferEntityConsensusInput(context, 'PROPOSAL_PRIOR_FRAME_PENDING');
      }
      entityLog.error('proposal.conflict_rejected', {
        existing: shortHash(existingFrame.hash),
        incoming: shortHash(proposedFrame.hash),
      });
      return rejectEntityConsensusInput(context);
    }
    return null;
  }
  const expectedPrevHeight = proposedFrame.height - 1;
  const canVerify = workingReplica.state.height === expectedPrevHeight;
  if (!canVerify) {
    entityLog.warn('proposal.catch_up_wait', {
      signer: shortId(workingReplica.signerId),
      height: workingReplica.state.height,
      expectedPrevHeight,
    });
    // Deferred is explicit: no state mutation, no delivery receipt, and the
    // sender remains responsible for ordered retry of the missing predecessor.
    return deferEntityConsensusInput(context, 'PROPOSAL_CATCH_UP_STATE_WAIT');
  }
  assertFrameParentMatchesState(workingReplica.state, proposedFrame, 'PROPOSAL_PARENT_MISMATCH');
  if (!validateProposedFrameLeader(env, workingReplica.state, proposedFrame)) {
    entityLog.error('proposal.leader_rejected', {
      proposer: shortId(proposedFrame.leader?.proposerSignerId ?? ''),
      view: proposedFrame.leader?.view ?? null,
    });
    return rejectEntityConsensusInput(context);
  }
  const effectiveProposalView = Math.max(
    proposedFrame.leader.view,
    proposedFrame.leader.certificate?.toView ?? -1,
    proposedFrame.leader.relayCertificate?.toView ?? -1,
  );
  const localValidatorId = workingReplica.signerId.trim().toLowerCase();
  const localVotedView = Math.max(
    -1,
    ...[...(workingReplica.leaderVotes?.values() ?? [])]
      .filter(
        vote =>
          vote.voterId.trim().toLowerCase() === localValidatorId &&
          vote.targetHeight === proposedFrame.height &&
          vote.signature.length > 0,
      )
      .map(vote => vote.toView),
  );
  const certifiedView =
    workingReplica.pendingLeaderCertificate?.targetHeight === proposedFrame.height
      ? workingReplica.pendingLeaderCertificate.toView
      : -1;
  if (Math.max(localVotedView, certifiedView) > effectiveProposalView) {
    // A validator that already signed a higher-view timeout must not later
    // sign the superseded proposal merely because transport reordered lanes.
    // New-view proposals and prepared relays carry that higher view explicitly.
    entityLog.info('proposal.superseded_by_local_view', {
      frame: shortHash(proposedFrame.hash),
      proposalView: effectiveProposalView,
      localVotedView,
      certifiedView,
    });
    return rejectEntityConsensusInput(context, 'PROPOSAL_SUPERSEDED_BY_LOCAL_VIEW_CHANGE');
  }

  const jRangeError = getReplicaJRangeValidationError(env, workingReplica, proposedFrame.txs);
  if (jRangeError) {
    entityLog.error('proposal.j_range_rejected', { error: jRangeError });
    return rejectEntityConsensusInput(context, 'PROPOSAL_J_RANGE_MISMATCH');
  }
  const jPrefixError = getFrameJPrefixValidationError(env, workingReplica, proposedFrame);
  if (jPrefixError) {
    if (jPrefixError.startsWith('J_PREFIX_LOCAL_HISTORY_BEHIND:')) {
      return deferEntityConsensusInput(context, 'PROPOSAL_J_PREFIX_HISTORY_WAIT');
    }
    if (isJPrefixLocalFreshnessRace(jPrefixError)) {
      // Ordered delivery can expose a stronger local prefix after the proposer
      // formed an earlier quorum certificate. Rejecting that stale proposal is
      // normal consensus flow; signatures, malformed certificates and actual
      // corruption remain error-severity failures above/below this branch.
      entityLog.info('proposal.j_prefix_stale', { error: jPrefixError });
    } else {
      entityLog.error('proposal.j_prefix_rejected', { error: jPrefixError });
    }
    return rejectEntityConsensusInput(context, 'PROPOSAL_J_RANGE_MISMATCH');
  }

  const {
    newState: validatorComputedState,
    collectedHashes: validatorCollectedHashes = [],
    outputs: validatorOutputs,
    jOutputs: validatorJOutputs,
    candidateEffects,
    storageChanges,
    consumptionNodeChanges,
    accountJClaimNodeChanges,
  } = await applyEntityFrame(env, workingReplica.state, proposedFrame.txs, proposedFrame.timestamp);
  const validatorNewState = {
    ...validatorComputedState,
    entityId: workingReplica.state.entityId,
    height: proposedFrame.height,
    timestamp: proposedFrame.timestamp,
    leaderState: expectedCommittedLeaderState(workingReplica.state, proposedFrame),
  };
  const validatorStateRoot = computeCanonicalEntityConsensusStateHash(validatorNewState);
  if (validatorStateRoot !== proposedFrame.stateRoot) {
    entityLog.error('proposal.state_root_rejected', {
      expected: validatorStateRoot,
      received: proposedFrame.stateRoot,
    });
    return rejectEntityConsensusInput(context, 'PROPOSAL_STATE_ROOT_MISMATCH');
  }
  const validatorAuthorityRoot = computeEntityFrameAuthorityRoot(buildEntityFrameAuthority(validatorNewState));
  if (validatorAuthorityRoot !== proposedFrame.authorityRoot) {
    entityLog.error('proposal.authority_root_rejected', {
      expected: validatorAuthorityRoot,
      received: proposedFrame.authorityRoot,
    });
    return rejectEntityConsensusInput(context, 'PROPOSAL_AUTHORITY_ROOT_MISMATCH');
  }

  const prevFrameHash = getPrevFrameHash(workingReplica.state);
  const validatorComputedHash = createEntityFrameHashFromStateRoot(
    prevFrameHash,
    proposedFrame.height,
    proposedFrame.timestamp,
    proposedFrame.txs,
    validatorNewState.entityId,
    validatorStateRoot,
    validatorAuthorityRoot,
    proposedFrame.jPrefixCertificate,
  );

  if (validatorComputedHash !== proposedFrame.hash) {
    logError('FRAME_CONSENSUS', `❌ HASH MISMATCH: Proposer sent invalid frame hash!`);
    logError('FRAME_CONSENSUS', `   Expected: ${validatorComputedHash.slice(0, 30)}...`);
    logError('FRAME_CONSENSUS', `   Received: ${proposedFrame.hash.slice(0, 30)}...`);
    logError('FRAME_CONSENSUS', `   This could indicate equivocation attack or state divergence bug.`);
    return rejectEntityConsensusInput(context, 'PROPOSAL_FRAME_HASH_MISMATCH');
  }

  entityLog.debug('proposal.hash_verified', { frame: shortHash(proposedFrame.hash) });

  const outputHashes = buildCertifiedEntityOutputHashes(
    validatorNewState,
    env,
    proposedFrame.height,
    validatorComputedHash,
    validatorOutputs,
  );
  const hashesToSign = buildEntityHashesToSign(
    workingReplica.state.entityId,
    proposedFrame.height,
    validatorComputedHash,
    [...validatorCollectedHashes, ...outputHashes],
  );
  const manifestMismatch = getEntityHashManifestMismatch(hashesToSign, proposedFrame.hashesToSign);
  if (manifestMismatch) {
    logError('FRAME_CONSENSUS', `❌ BYZANTINE: Secondary hash manifest mismatch: ${manifestMismatch}`, {
      frame: proposedFrame.hash,
      expected: hashesToSign,
      received: proposedFrame.hashesToSign ?? null,
    });
    return rejectEntityConsensusInput(context);
  }

  await assertEntityConfigBoardAuthority(
    env,
    workingReplica.state.entityId,
    workingReplica.state.config,
    validatorNewState,
  );
  const allSignatures = await Promise.all(
    hashesToSign.map(hashInfo => signAccountFrame(env, workingReplica.signerId, hashInfo.hash)),
  );
  entityLog.debug('proposal.hashes_signed', { count: allSignatures.length });

  let proposedBundles: Map<string, string[]>;
  try {
    proposedBundles = normalizePrecommitBundles(
      config,
      proposedFrame.collectedSigs ?? new Map(),
      'PROPOSAL_PRECOMMIT_REJECTED',
    );
  } catch (error) {
    entityLog.error('proposal.precommit_bundle_rejected', {
      error: error instanceof Error ? error.message : String(error),
    });
    return rejectEntityConsensusInput(context, 'PROPOSAL_PRECOMMIT_REJECTED');
  }
  const collectedSigs = new Map<string, string[]>();
  for (const [signerId, signatures] of proposedBundles) {
    if (
      !verifyHashPrecommitSignatures(
        env,
        signerId,
        hashesToSign,
        proposedFrame.hash,
        proposedFrame.height,
        signatures,
        'PROPOSAL_PRECOMMIT_REJECTED',
      )
    )
      return rejectEntityConsensusInput(context);
    collectedSigs.set(signerId, [...signatures]);
  }
  const localSignerId = workingReplica.signerId.toLowerCase();
  const existingLocal = collectedSigs.get(localSignerId);
  if (
    existingLocal &&
    (existingLocal.length !== allSignatures.length ||
      existingLocal.some((signature, index) => signature !== allSignatures[index]))
  ) {
    return rejectEntityConsensusInput(context, 'PROPOSAL_LOCAL_PRECOMMIT_CONFLICT');
  }
  collectedSigs.set(localSignerId, allSignatures);
  workingReplica.lockedFrame = { ...proposedFrame, hashesToSign, collectedSigs };
  workingReplica.validatorExecution = {
    frameHash: proposedFrame.hash,
    height: proposedFrame.height,
    state: validatorNewState,
    outputs: validatorOutputs,
    jOutputs: validatorJOutputs,
    hashesToSign,
    candidateEffects,
    storageChanges,
    ...(consumptionNodeChanges ? { consumptionNodeChanges } : {}),
    ...(accountJClaimNodeChanges ? { accountJClaimNodeChanges } : {}),
  };
  workingReplica.lastConsensusProgressAt = env.timestamp;

  config.validators.forEach(validatorId => {
    if (validatorId.toLowerCase() === workingReplica.signerId.toLowerCase()) return;
    entityOutbox.push({
      entityId: entityInput.entityId,
      signerId: validatorId,
      hashPrecommitFrame: {
        height: proposedFrame.height,
        frameHash: proposedFrame.hash,
      },
      hashPrecommits: new Map([[workingReplica.signerId, allSignatures]]),
    });
  });
  entityLog.debug('proposal.precommit_sent', {
    recipients: Math.max(0, config.validators.length - 1),
    frame: frameHash,
    signatures: allSignatures.length,
  });

  return null;
}

async function handleHashPrecommits(context: ApplyEntityInputContext): Promise<ApplyEntityInputResult | null> {
  const { env, entityInput, workingReplica, entityOutbox, jOutbox } = context;
  const hasIncomingPrecommits = Boolean(entityInput.hashPrecommits?.size);
  const frame = workingReplica.proposal ?? workingReplica.lockedFrame;
  if (!frame) {
    return hasIncomingPrecommits ? rejectEntityConsensusInput(context, 'PRECOMMIT_FRAME_NOT_ACTIVE') : null;
  }

  const proposal = frame;
  const execution = getValidatorExecutionForFrame(workingReplica, proposal);
  if (!execution) {
    throw new Error(`ENTITY_VALIDATOR_EXECUTION_MISSING:${proposal.height}:${proposal.hash}`);
  }
  const localManifestMismatch = getEntityHashManifestMismatch(execution.hashesToSign, proposal.hashesToSign);
  if (localManifestMismatch) {
    return rejectEntityConsensusInput(context, 'PRECOMMIT_LOCAL_MANIFEST_MISMATCH');
  }
  const precommitFrame = entityInput.hashPrecommitFrame;
  if (
    hasIncomingPrecommits &&
    (!precommitFrame ||
      precommitFrame.height !== proposal.height ||
      precommitFrame.frameHash.toLowerCase() !== proposal.hash.toLowerCase())
  ) {
    entityLog.warn('precommit.frame_mismatch', {
      receivedHeight: precommitFrame?.height,
      receivedHash: precommitFrame?.frameHash,
      activeHeight: proposal.height,
      activeHash: proposal.hash,
    });
    return rejectEntityConsensusInput(context, 'PRECOMMIT_FRAME_MISMATCH');
  }
  try {
    proposal.collectedSigs = normalizePrecommitBundles(
      workingReplica.state.config,
      proposal.collectedSigs ?? new Map(),
      'COLLECTED_PRECOMMITS_REJECTED',
    );
  } catch (error) {
    entityLog.error('precommit.collected_bundle_rejected', {
      error: error instanceof Error ? error.message : String(error),
    });
    return rejectEntityConsensusInput(context, 'COLLECTED_PRECOMMITS_REJECTED');
  }
  let incomingBundles = new Map<string, string[]>();
  if (entityInput.hashPrecommits?.size) {
    try {
      incomingBundles = normalizePrecommitBundles(
        workingReplica.state.config,
        entityInput.hashPrecommits,
        'PRECOMMIT_REJECTED',
      );
    } catch (error) {
      entityLog.error('precommit.bundle_rejected', { error: error instanceof Error ? error.message : String(error) });
      return rejectEntityConsensusInput(context, 'PRECOMMIT_BUNDLE_REJECTED');
    }
  }
  for (const [signerId, sigs] of incomingBundles) {
    if (
      !verifyHashPrecommitSignatures(
        env,
        signerId,
        execution.hashesToSign,
        proposal.hash,
        proposal.height,
        sigs,
        'PRECOMMIT_REJECTED',
      )
    )
      return rejectEntityConsensusInput(context, 'PRECOMMIT_SIGNATURE_REJECTED');
    if (!proposal.collectedSigs) {
      proposal.collectedSigs = new Map();
    }
    const existing = proposal.collectedSigs.get(signerId);
    if (
      existing &&
      (existing.length !== sigs.length || existing.some((signature, index) => signature !== sigs[index]))
    ) {
      return rejectEntityConsensusInput(context, 'PRECOMMIT_SIGNER_EQUIVOCATION');
    }
    proposal.collectedSigs.set(signerId, [...sigs]);
  }
  entityLog.debug('precommit.collected', {
    incoming: entityInput.hashPrecommits?.size ?? 0,
    total: proposal.collectedSigs?.size || 0,
  });

  const signers = Array.from(proposal.collectedSigs?.keys() || []);
  const totalPower = calculateQuorumPower(workingReplica.state.config, signers);
  if (!validateVotingPower(totalPower)) {
    throw new Error(`ENTITY_CONSENSUS_FATAL_INVALID_VOTING_POWER:${totalPower}`);
  }

  if (DEBUG) {
    const totalShares = Object.values(workingReplica.state.config.shares).reduce((sum, val) => sum + val, BigInt(0));
    const percentage = ((Number(totalPower) / Number(workingReplica.state.config.threshold)) * 100).toFixed(1);
    log.info(
      `    🔍 Threshold check: ${totalPower} / ${totalShares} [${percentage}% threshold${Number(totalPower) >= Number(workingReplica.state.config.threshold) ? '+' : ''}]`,
    );
  }

  if (totalPower < workingReplica.state.config.threshold) {
    return null;
  }

  entityLog.debug('commit.threshold_reached', {
    signers: signers.length,
    hashes: execution.hashesToSign.length,
  });

  const commitEmitterId =
    proposal.leader.relayCertificate?.preparedFrameHash === proposal.hash
      ? proposal.leader.relayCertificate.nextLeaderId
      : proposal.leader.proposerSignerId;
  const isFrameLeader = commitEmitterId.toLowerCase() === workingReplica.signerId.toLowerCase();
  if (!isFrameLeader && execution.jOutputs.length > 0) {
    entityLog.warn('commit.external_output_waiting_for_certified_emitter', {
      frame: shortHash(proposal.hash),
      emitter: shortId(commitEmitterId),
      jOutputs: execution.jOutputs.length,
    });
    return null;
  }

  const stateToCommit = execution.state;

  const committedHankos: HankoString[] = [];
  if (proposal.collectedSigs) {
    for (let i = 0; i < execution.hashesToSign.length; i++) {
      const hashInfo = execution.hashesToSign[i];
      if (!hashInfo) continue;
      const sigsForHash: Array<{ signerId: string; signature: string }> = [];
      for (const [signerId, sigs] of proposal.collectedSigs) {
        const sig = sigs[i];
        if (sig) {
          sigsForHash.push({ signerId, signature: sig });
        }
      }
      const hanko = await buildQuorumHanko(
        env,
        workingReplica.state.entityId,
        hashInfo.hash,
        sigsForHash,
        workingReplica.state.config,
        stateToCommit,
      );
      committedHankos.push(hanko);
    }
    entityLog.debug('commit.hankos_built', {
      count: committedHankos.length,
      validators: proposal.collectedSigs.size,
    });
  }

  // Witnesses are not consensus state; they let outputs carry quorum proofs.
  if (!workingReplica.hankoWitness) {
    workingReplica.hankoWitness = new Map();
  }
  if (execution.hashesToSign.length > 0) {
    for (let i = 0; i < execution.hashesToSign.length; i++) {
      const hashInfo = execution.hashesToSign[i];
      const hanko = committedHankos[i];
      if (hashInfo && hanko && isWitnessHashType(hashInfo.type)) {
        workingReplica.hankoWitness.set(hashInfo.hash, {
          hanko,
          type: hashInfo.type,
          entityHeight: workingReplica.state.height + 1,
          createdAt: env.timestamp,
        });
      }
    }
  }

  const sealedStateCount = sealHankoWitnessInState(
    stateToCommit,
    workingReplica.hankoWitness,
    workingReplica.state.height + 1,
  );

  // Only this validator's local replay may drive side effects. Proposer payloads
  // intentionally contain no outputs, so a valid frame signature cannot smuggle
  // an unrelated Entity/J message into the commit path.
  const attachedCount = attachHankoWitnessToOutputs(
    execution.outputs,
    execution.jOutputs,
    workingReplica.hankoWitness,
    workingReplica.state.height + 1,
    stateToCommit,
  );
  pruneHankoWitnessToReachableState(stateToCommit, workingReplica.hankoWitness);
  const commitOutputs = wrapCertifiedEntityOutputs(
    execution.outputs,
    proposal,
    stateToCommit,
    env,
    execution.hashesToSign,
    committedHankos,
    isFrameLeader,
  );
  entityOutbox.push(...commitOutputs);
  if (isFrameLeader) jOutbox.push(...execution.jOutputs);
  entityLog.info('commit.outputs', {
    outputs: commitOutputs.length,
    jOutputs: isFrameLeader ? execution.jOutputs.length : 0,
    hankos: attachedCount,
    stateHankos: sealedStateCount,
  });

  const preCommitState = workingReplica.state;
  const committedState = {
    ...stateToCommit,
    entityId: workingReplica.state.entityId,
    height: proposal.height,
    prevFrameHash: proposal.hash,
  } as EntityState;
  const entitySizeLog = prepareCommittedEntitySizeLog(env, preCommitState, committedState);
  cacheCommittedConsumptionNodeChanges(env, execution.consumptionNodeChanges);
  cacheCommittedAccountJClaimNodeChanges(env, execution.accountJClaimNodeChanges);
  workingReplica.state = committedState;
  applyStorageChanges(env, committedState, [
    ...execution.storageChanges,
    { family: 'entity', entityId: committedState.entityId },
  ]);
  emitCommittedPendingFrameWarnings(preCommitState, committedState);
  emitCommittedEntitySizeLog(entitySizeLog);
  pruneReplicaFinalizedJHistory(workingReplica);

  const committedFrame = proposal;
  committedFrame.hankos = committedHankos;
  appendCertifiedEntityFrameLink(
    env,
    workingReplica,
    buildCertifiedEntityFrameLink(workingReplica.state.entityId, committedFrame, workingReplica.state),
  );
  publishEntityCandidateEffects(env, execution.candidateEffects);
  const committedTxs = committedFrame.txs;
  if (committedTxs.length > 0) {
    workingReplica.mempool = removeCommittedTxsFromMempool(workingReplica.mempool, committedTxs);
  }
  delete workingReplica.proposal;
  delete workingReplica.lockedFrame;
  delete workingReplica.validatorExecution;
  if (proposal.leader.relayCertificate?.preparedFrameHash === proposal.hash) {
    workingReplica.pendingLeaderCertificate = structuredClone(proposal.leader.relayCertificate);
  } else {
    delete workingReplica.pendingLeaderCertificate;
  }
  workingReplica.leaderVotes = new Map();
  workingReplica.lastConsensusProgressAt = env.timestamp;
  workingReplica.isProposer = isEntityActiveLeader(workingReplica);

  const committedProposalHash = committedFrame.hash.slice(0, 10);
  const precommitSigners = Array.from(committedFrame.collectedSigs?.keys() || []);
  entityLog.debug('commit.notify_validators', {
    frame: committedProposalHash,
    validators: workingReplica.state.config.validators.length - 1,
    precommitSigners: precommitSigners.map(shortId),
  });

  workingReplica.state.config.validators.forEach(validatorId => {
    if (validatorId.toLowerCase() === workingReplica.signerId.toLowerCase()) return;
    entityOutbox.push({
      entityId: entityInput.entityId,
      signerId: validatorId,
      proposedFrame: committedFrame,
    });
  });
  await runLocalPostCommitHooks(env, workingReplica, entityOutbox);

  return commitEntityConsensusInput(context);
}

/**
 * Main entity input processor - handles consensus, proposals, and state transitions
 */
export const applyEntityInput = async (
  env: Env,
  entityReplica: EntityReplica,
  entityInput: EntityInput,
  options: { trustedLocalRuntimeProtocol?: 'cross-j' } = {},
): Promise<ApplyEntityInputResult> => {
  const consensusProfileStartedAt = getPerfMs();
  const consensusProfileCheckpoints: Record<string, number> = {};
  const checkpointConsensusProfile = (label: string): void => {
    consensusProfileCheckpoints[label] = Math.round(getPerfMs() - consensusProfileStartedAt);
  };
  const trustedLocalCrossJurisdiction = options.trustedLocalRuntimeProtocol === 'cross-j';
  if (trustedLocalCrossJurisdiction && !isSingleSignerEntity(entityReplica.state)) {
    throw new Error(`CROSS_J_LOCAL_COMMAND_SINGLE_SIGNER_REQUIRED:${entityReplica.entityId}`);
  }
  let trustedLocalEntityTxs: EntityTx[] = [];
  const admissionError = getEntityMempoolAdmissionError(entityReplica, entityInput, trustedLocalCrossJurisdiction);
  if (admissionError) {
    log.error(`❌ Entity mempool admission rejected for ${entityInput.entityId}: ${admissionError}`);
    return {
      outcome: { kind: 'rejected', code: 'ENTITY_MEMPOOL_ADMISSION_REJECTED' },
      newState: entityReplica.state,
      outputs: [],
      jOutputs: [],
      workingReplica: entityReplica,
    };
  }

  // Ingress is an immutable retry payload. Consensus normalization attaches
  // canonical signature bundles and committed hankos to its working frame, so
  // it must never mutate the object retained by the Runtime mempool. Otherwise
  // a later same-frame failure would requeue bytes that were never received.
  const ingressEntityInput = entityInput;

  // Validate the exact ingress bytes before the type-aware clone canonicalizes
  // known protocol fields. Otherwise forbidden proposal side effects can be
  // dropped, and malformed iterable signature bundles can become arrays before
  // the strict EntityInput boundary gets a chance to reject them.
  const workingReplica = cloneEntityReplica(entityReplica);
  if (!validateEntityInput(ingressEntityInput)) {
    const detail =
      `entityId=${ingressEntityInput.entityId} ` +
      `txs=${ingressEntityInput.entityTxs?.map(tx => tx.type).join(',') || 'none'}`;
    log.error(`❌ Invalid ingress input for ${ingressEntityInput.entityId}: ${detail}`);
    return {
      outcome: { kind: 'rejected', code: 'ENTITY_INPUT_INVALID' },
      newState: workingReplica.state,
      outputs: [],
      jOutputs: [],
      workingReplica,
    };
  }
  entityInput = cloneIsolatedEntityInput(ingressEntityInput);
  if (ingressEntityInput.leaderTimeoutVote && entityInput.leaderTimeoutVote) {
    copyLocalEntityLeaderTimeoutVoteAuthorization(ingressEntityInput.leaderTimeoutVote, entityInput.leaderTimeoutVote);
  }

  // IMMUTABILITY: Clone replica at function start (fintech-safe, hacker-proof)
  // Prevents state mutations from escaping function scope
  normalizeProposedFrameCollectedSigs(entityInput.proposedFrame);

  const entityDisplay = formatEntityDisplay(entityInput.entityId);
  const timestamp = env.timestamp;
  const quietRuntimeLogs = env.quietRuntimeLogs === true;
  const currentProposalHash = workingReplica.proposal?.hash?.slice(0, 10) || 'none';
  const frameHash = entityInput.proposedFrame?.hash?.slice(0, 10) || 'none';

  if (!quietRuntimeLogs) {
    const hasInputActivity = Boolean(
      (entityInput.entityTxs?.length ?? 0) > 0 ||
      entityInput.proposedFrame ||
      entityInput.hashPrecommits?.size ||
      entityInput.jPrefixAttestations?.size,
    );
    const logInputReceived = hasInputActivity ? entityLog.info : entityLog.debug;
    logInputReceived('input.received', {
      entity: entityDisplay,
      signer: shortId(workingReplica.signerId),
      ts: timestamp,
      txs: entityInput.entityTxs?.map(tx => tx.type) ?? [],
      mempool: workingReplica.mempool.length,
      proposer: workingReplica.isProposer,
      proposal: currentProposalHash,
      frame: frameHash,
      precommits: entityInput.hashPrecommits?.size || 0,
      jPrefixAttestations: entityInput.jPrefixAttestations?.size || 0,
    });
  }
  if (entityInput.hashPrecommits?.size) {
    const precommitSigners = Array.from(entityInput.hashPrecommits.keys());
    if (HEAVY_LOGS) entityLog.debug('input.precommits', { signers: precommitSigners.map(shortId) });
  }

  // SECURITY: Validate all inputs
  if (!validateEntityInput(entityInput)) {
    const detail = `entityId=${entityInput.entityId} txs=${entityInput.entityTxs?.map(tx => tx.type).join(',') || 'none'}`;
    log.error(`❌ Invalid input for ${entityInput.entityId}: ${detail}`);
    return {
      outcome: { kind: 'rejected', code: 'ENTITY_INPUT_INVALID' },
      newState: workingReplica.state,
      outputs: [],
      jOutputs: [],
      workingReplica,
    };
  }
  if (!validateEntityReplica(workingReplica)) {
    log.error(`❌ Invalid replica state for ${workingReplica.entityId}:${workingReplica.signerId}`);
    return {
      outcome: { kind: 'rejected', code: 'ENTITY_REPLICA_INVALID' },
      newState: workingReplica.state,
      outputs: [],
      jOutputs: [],
      workingReplica,
    };
  }

  const entityOutbox: EntityInput[] = [];
  const jOutbox: JInput[] = []; // J-layer outputs
  const phaseContext: ApplyEntityInputContext = {
    env,
    entityInput,
    workingReplica,
    entityOutbox,
    jOutbox,
    frameHash,
  };
  checkpointConsensusProfile('ingress');

  const leaderVoteResult = await handleLeaderTimeoutVote(phaseContext);
  if (leaderVoteResult) return leaderVoteResult;
  const jPrefixResult = handleJPrefixAttestations(phaseContext);
  if (jPrefixResult) return jPrefixResult;
  const quorumSafetyWarning = getEntityQuorumSafetyWarning(workingReplica.state.config);
  if (quorumSafetyWarning && workingReplica.state.height === 0) {
    entityLog.warn('board.quorum_safety', { warning: quorumSafetyWarning });
  }
  const localCanPropose = isReplicaProposalLeader(workingReplica);
  workingReplica.isProposer = localCanPropose;
  if (localCanPropose && entityInput.entityTxs?.some(tx => tx.type === 'j_rebroadcast')) {
    assertLocalJRebroadcastAllowed(workingReplica);
  }

  // Add transactions to mempool (mutable for performance). A durable empty
  // self-wake is also allowed to trigger proposer-local work whose public
  // result must be signed into consensus, such as cross-J pull commitments.
  const suppliedEntityTxs = entityInput.entityTxs ?? [];
  const secretAwareEntityTxs =
    localCanPropose && suppliedEntityTxs.length > 0
      ? await appendDefaultProposerAcceptedHtlcReveals(env, workingReplica, suppliedEntityTxs)
      : suppliedEntityTxs;
  // The default source-hub signer owns the private cross-J ladder seed. During
  // leader failover it signs its individual materialization command locally;
  // the normal non-leader forwarding path delivers it to the active proposer.
  const admittedEntityTxs = appendDefaultProposerCrossJMaterializations(env, workingReplica, secretAwareEntityTxs);
  if (nodeProcess?.env?.['XLN_STORAGE_DEBUG_REPLICA_META'] === '1') {
    entityLog.info('replica_meta.admission_debug', {
      entityId: workingReplica.entityId,
      entityHeight: workingReplica.state.height,
      runtimeHeight: env.height,
      supplied: suppliedEntityTxs.map(tx => tx.type),
      secretAware: secretAwareEntityTxs.map(tx => tx.type),
      admitted: admittedEntityTxs.map(tx => tx.type),
      mempoolBefore: workingReplica.mempool.map(tx => tx.type),
    });
  }
  if (admittedEntityTxs.length > 0) {
    if (!localCanPropose && workingReplica.lastConsensusProgressAt === undefined) {
      workingReplica.lastConsensusProgressAt = env.timestamp;
    }
    const voteTransactions = suppliedEntityTxs.filter(tx => tx.type === 'vote');
    if (voteTransactions.length > 0) {
      entityLog.debug('vote.mempool', { signer: shortId(workingReplica.signerId), count: voteTransactions.length });
    }
    if (trustedLocalCrossJurisdiction) {
      if (!localCanPropose) {
        throw new Error(
          `CROSS_J_LOCAL_COMMAND_PROPOSER_REQUIRED:${workingReplica.entityId}:${workingReplica.signerId}`,
        );
      }
      trustedLocalEntityTxs = prepareLocallyAuthoredEntityTxs(
        env,
        workingReplica.state,
        workingReplica.signerId,
        admittedEntityTxs,
      );
    } else {
      workingReplica.mempool = prioritizeScheduledWakeTransactions(
        prepareLocallyAuthoredEntityTxs(env, workingReplica.state, workingReplica.signerId, [
          ...workingReplica.mempool,
          ...admittedEntityTxs,
        ]),
      );
    }
    entityLog.debug('mempool.added', {
      added: admittedEntityTxs.length,
      external: workingReplica.mempool.length,
      localRuntime: trustedLocalEntityTxs.length,
    });
  }

  // Forward before handling commits so fresh validator txs cannot be cleared by a
  // commit notification in the same tick.
  if (!localCanPropose && workingReplica.mempool.length > 0) {
    const proposerId = getReplicaProposalLeader(workingReplica).activeValidatorId;
    if (!proposerId) {
      throw new Error(`ENTITY_CONSENSUS_FATAL_PROPOSER_MISSING:${workingReplica.state.config.validators.join(',')}`);
    }

    const txCount = workingReplica.mempool.length;
    entityOutbox.push({
      entityId: entityInput.entityId,
      signerId: proposerId,
      entityTxs: [...workingReplica.mempool],
    });

    entityLog.debug('mempool.forwarded_to_proposer', { txs: txCount, proposer: shortId(proposerId) });
  }
  checkpointConsensusProfile('admission');

  const commitNotificationResult = await handleCommitNotification(phaseContext);
  if (commitNotificationResult) return commitNotificationResult;

  const proposedFramePrecommitResult = await handleProposedFramePrecommit(phaseContext);
  if (proposedFramePrecommitResult) return proposedFramePrecommitResult;

  const hashPrecommitResult = await handleHashPrecommits(phaseContext);
  if (hashPrecommitResult) return hashPrecommitResult;

  const hasLocalConsensusWork =
    trustedLocalEntityTxs.length > 0 ||
    workingReplica.mempool.length > 0 ||
    Array.from(workingReplica.state.accounts.values()).some(account =>
      accountHasProposableMempool(account, workingReplica.state),
    );
  if (entityInput.jPrefixAttestations || hasLocalConsensusWork) {
    // Commit/proposal notifications above may advance the parent Entity height.
    // Only sign after those terminal paths so this validator never emits a head
    // for a parent that was committed by the same input.
    ensureLocalJPrefixAttestation(env, workingReplica, entityOutbox, Boolean(entityInput.jPrefixAttestations));
  }

  if (!quietRuntimeLogs) {
    entityLog.debug('consensus.check', {
      entity: shortId(workingReplica.entityId),
      signer: shortId(workingReplica.signerId),
      proposer: workingReplica.isProposer,
      mempool: workingReplica.mempool.length,
      localRuntimeMempool: trustedLocalEntityTxs.length,
      hasProposal: Boolean(workingReplica.proposal),
      txs: [...trustedLocalEntityTxs, ...workingReplica.mempool].map(tx => tx.type),
    });
  }

  const isSingleSigner = isSingleSignerEntity(workingReplica.state);
  const hasProposableAccountMempool = Array.from(workingReplica.state.accounts.values()).some(account =>
    accountHasProposableMempool(account, workingReplica.state),
  );
  let proposalJPrefixCertificate =
    localCanPropose && workingReplica.jPrefixRound
      ? buildJPrefixCertificate(workingReplica.state, workingReplica.jPrefixRound.attestations)
      : null;
  let proposalCertifiedJPrefixTx: Extract<EntityTx, { type: 'j_event' }> | null = null;
  if (proposalJPrefixCertificate && workingReplica.jPrefixRound) {
    workingReplica.jPrefixRound.certificate = proposalJPrefixCertificate;
    if (proposalJPrefixCertificate.selected.scannedThroughHeight > workingReplica.state.lastFinalizedJHeight) {
      const certifiedRange = buildCertifiedJPrefixTx(
        env,
        workingReplica,
        proposalJPrefixCertificate,
        getReplicaProposalLeader(workingReplica).activeValidatorId,
      );
      proposalCertifiedJPrefixTx = certifiedRange;
      if (!trustedLocalCrossJurisdiction) {
        workingReplica.mempool = prioritizeScheduledWakeTransactions([
          certifiedRange,
          ...workingReplica.mempool.filter(tx => tx.type !== 'j_event'),
        ]);
      }
    }
  }
  const jPrefixProposalBlocked =
    localCanPropose &&
    !proposalJPrefixCertificate &&
    (entityRequiresJPrefixCertificate(workingReplica.state) ||
      hasPendingLocalJEvent(workingReplica.state, workingReplica.jHistory));
  // One signed head per Entity round prevents equivocation. If a validator
  // signed the certified base and only then observed a later J event, it may
  // not replace that vote in-place. Commit exactly one certificate-only frame
  // to open the next round. Requiring pending local evidence is essential:
  // allowing every base certificate to roll would create infinite empty
  // Entity frames while the jurisdiction is idle.
  const shouldRollFrozenBaseJPrefixRound = isFrozenBaseJPrefixRollAuthorized(
    workingReplica,
    proposalJPrefixCertificate,
  );
  const trustedLocalProposalTxs = proposalCertifiedJPrefixTx
    ? [proposalCertifiedJPrefixTx, ...trustedLocalEntityTxs]
    : trustedLocalEntityTxs;
  const proposalSelection =
    localCanPropose && !jPrefixProposalBlocked
      ? await selectProposableEntityTxs(
          env,
          workingReplica.state,
          trustedLocalCrossJurisdiction ? trustedLocalProposalTxs : workingReplica.mempool,
        )
      : {
          txs: [],
          currentAuthorityReady: false,
          ...(jPrefixProposalBlocked ? { reason: 'J_PREFIX_QUORUM_REQUIRED' } : {}),
        };
  checkpointConsensusProfile('selection');
  // A frozen-base roll exists only to open a fresh J-prefix voting round.
  // Mixing user/governance work into it lets a proposer keep advancing Entity
  // state while an honest validator has an observed J event, so the queued
  // work remains untouched until the next (stronger) prefix certificate.
  const proposalTxs = shouldRollFrozenBaseJPrefixRound ? [] : proposalSelection.txs;
  if (nodeProcess?.env?.['XLN_STORAGE_DEBUG_REPLICA_META'] === '1') {
    entityLog.info('replica_meta.selection_debug', {
      entityId: workingReplica.entityId,
      entityHeight: workingReplica.state.height,
      runtimeHeight: env.height,
      mempool: workingReplica.mempool.map(tx => tx.type),
      selected: proposalTxs.map(tx => tx.type),
      reason: proposalSelection.reason ?? null,
    });
  }
  if (trustedLocalCrossJurisdiction && proposalTxs.length !== trustedLocalProposalTxs.length) {
    throw new Error(
      `CROSS_J_LOCAL_COMMAND_PARTIAL_FRAME_FORBIDDEN:${workingReplica.entityId}:` +
        `selected=${proposalTxs.length}:required=${trustedLocalProposalTxs.length}`,
    );
  }
  if (proposalSelection.reason) {
    entityLog.debug('proposal.authority_gate', {
      reason: proposalSelection.reason,
      selected: proposalTxs.map(tx => tx.type),
      pending: workingReplica.mempool.map(tx => tx.type),
    });
  }

  // Single-signer entities still produce a hash-linked frame; they only skip
  // the multi-validator precommit/commit round trip.
  if (
    localCanPropose &&
    (proposalTxs.length > 0 ||
      shouldRollFrozenBaseJPrefixRound ||
      (proposalSelection.currentAuthorityReady && hasProposableAccountMempool)) &&
    !workingReplica.proposal &&
    isSingleSigner
  ) {
    entityLog.debug('single_signer.execute', { txs: proposalTxs.map(tx => tx.type) });
    const singleSignerLeader = getEntityLeaderState(workingReplica.state);
    assertProposerJRangesMatchLocalHistory(env, workingReplica, proposalTxs);
    assertFrameJPrefix(env, workingReplica, {
      height: workingReplica.state.height + 1,
      parentFrameHash: getPrevFrameHash(workingReplica.state),
      leader: { proposerSignerId: workingReplica.signerId.toLowerCase(), view: singleSignerLeader.view },
      txs: proposalTxs,
      ...(proposalJPrefixCertificate ? { jPrefixCertificate: proposalJPrefixCertificate } : {}),
    });
    const {
      newState: newEntityState,
      outputs: frameOutputs,
      jOutputs: frameJOutputs,
      candidateEffects,
      storageChanges,
      collectedHashes = [],
      consumptionNodeChanges,
      accountJClaimNodeChanges,
    } = await applyEntityFrame(env, workingReplica.state, proposalTxs, env.timestamp);
    checkpointConsensusProfile('frameApply');
    const newHeight = workingReplica.state.height + 1;
    const newTimestamp = env.timestamp;

    const prevFrameHash = getPrevFrameHash(workingReplica.state);
    const singleSignerNewState = {
      ...newEntityState,
      entityId: workingReplica.state.entityId,
      height: newHeight,
      timestamp: newTimestamp,
      leaderState: singleSignerLeader,
    };
    const singleSignerStateRoot = computeCanonicalEntityConsensusStateHash(singleSignerNewState);
    const singleSignerAuthority = buildEntityFrameAuthority(singleSignerNewState);
    const singleSignerAuthorityRoot = computeEntityFrameAuthorityRoot(singleSignerAuthority);
    const singleSignerFrameHash = createEntityFrameHashFromStateRoot(
      prevFrameHash,
      newHeight,
      newTimestamp,
      proposalTxs,
      singleSignerNewState.entityId,
      singleSignerStateRoot,
      singleSignerAuthorityRoot,
      proposalJPrefixCertificate ?? undefined,
    );
    const singleSignerOutputHashes = buildCertifiedEntityOutputHashes(
      singleSignerNewState,
      env,
      newHeight,
      singleSignerFrameHash,
      frameOutputs,
    );
    checkpointConsensusProfile('commitments');

    const hashesToSign = buildEntityHashesToSign(workingReplica.state.entityId, newHeight, singleSignerFrameHash, [
      ...collectedHashes,
      ...singleSignerOutputHashes,
    ]);

    const hankos = await signEntityHashes(
      env,
      workingReplica.state.entityId,
      workingReplica.signerId,
      hashesToSign.map(hashInfo => hashInfo.hash),
      singleSignerNewState,
    );
    const collectedSigs = new Map<string, string[]>([
      [
        workingReplica.signerId.toLowerCase(),
        await Promise.all(hashesToSign.map(hashInfo => signAccountFrame(env, workingReplica.signerId, hashInfo.hash))),
      ],
    ]);
    checkpointConsensusProfile('signatures');

    if (!workingReplica.hankoWitness) {
      workingReplica.hankoWitness = new Map();
    }
    for (let i = 0; i < hashesToSign.length; i++) {
      const hashInfo = hashesToSign[i];
      const hanko = hankos[i];
      if (!hashInfo || !hanko) continue;
      if (!isWitnessHashType(hashInfo.type)) continue;
      workingReplica.hankoWitness.set(hashInfo.hash, {
        hanko,
        type: hashInfo.type,
        entityHeight: newHeight,
        createdAt: newTimestamp,
      });
    }
    const sealedStateCount = sealHankoWitnessInState(
      singleSignerNewState,
      workingReplica.hankoWitness as Map<string, HankoWitnessEntry>,
      newHeight,
    );
    const attachedHankos = attachHankoWitnessToOutputs(
      frameOutputs,
      frameJOutputs,
      workingReplica.hankoWitness as Map<string, HankoWitnessEntry>,
      newHeight,
      singleSignerNewState,
    );
    pruneHankoWitnessToReachableState(
      singleSignerNewState,
      workingReplica.hankoWitness as Map<string, HankoWitnessEntry>,
    );
    if (attachedHankos > 0 || sealedStateCount > 0) {
      entityLog.debug('single_signer.hankos_attached', { count: attachedHankos, stateCount: sealedStateCount });
    }

    const singleSignerFrame: ProposedEntityFrame = {
      height: newHeight,
      parentFrameHash: prevFrameHash,
      stateRoot: singleSignerStateRoot,
      authorityRoot: singleSignerAuthorityRoot,
      timestamp: newTimestamp,
      txs: [...proposalTxs],
      hash: singleSignerFrameHash,
      leader: {
        proposerSignerId: workingReplica.signerId.toLowerCase(),
        view: singleSignerLeader.view,
      },
      ...(proposalJPrefixCertificate ? { jPrefixCertificate: structuredClone(proposalJPrefixCertificate) } : {}),
      hashesToSign,
      collectedSigs,
      hankos,
    };
    const commitOutputs = wrapCertifiedEntityOutputs(
      frameOutputs,
      singleSignerFrame,
      singleSignerNewState,
      env,
      hashesToSign,
      hankos,
      true,
    );

    const preCommitState = workingReplica.state;
    const committedState = {
      ...singleSignerNewState,
      prevFrameHash: singleSignerFrameHash,
    };
    const entitySizeLog = prepareCommittedEntitySizeLog(env, preCommitState, committedState);
    cacheCommittedConsumptionNodeChanges(env, consumptionNodeChanges);
    cacheCommittedAccountJClaimNodeChanges(env, accountJClaimNodeChanges);
    workingReplica.state = committedState;
    applyStorageChanges(env, committedState, [
      ...storageChanges,
      { family: 'entity', entityId: committedState.entityId },
    ]);
    emitCommittedPendingFrameWarnings(preCommitState, committedState);
    emitCommittedEntitySizeLog(entitySizeLog);
    appendCertifiedEntityFrameLink(
      env,
      workingReplica,
      buildCertifiedEntityFrameLink(workingReplica.state.entityId, singleSignerFrame, workingReplica.state, {
        stateRoot: singleSignerStateRoot,
        authority: singleSignerAuthority,
      }),
    );
    publishEntityCandidateEffects(env, candidateEffects);
    pruneReplicaFinalizedJHistory(workingReplica);
    await runLocalPostCommitHooks(env, workingReplica, entityOutbox);
    workingReplica.lastConsensusProgressAt = env.timestamp;

    entityOutbox.push(...commitOutputs);
    jOutbox.push(...frameJOutputs);

    workingReplica.mempool = removeCommittedTxsFromMempool(workingReplica.mempool, proposalTxs);
    checkpointConsensusProfile('commit');
    const consensusProfileElapsedMs = Math.round(getPerfMs() - consensusProfileStartedAt);
    if (entityFrameProfileEnabled() || consensusProfileElapsedMs >= entityFrameSlowMs()) {
      entityLog.info('single_signer.profile', {
        entity: String(workingReplica.entityId || '').slice(-8),
        elapsedMs: consensusProfileElapsedMs,
        txs: proposalTxs.length,
        outputs: entityOutbox.length,
        jOutputs: jOutbox.length,
        phases: cumulativeMarksToPhases(consensusProfileCheckpoints, consensusProfileElapsedMs),
      });
    }
    return {
      outcome: { kind: 'committed' },
      newState: workingReplica.state,
      outputs: entityOutbox,
      jOutputs: jOutbox,
      workingReplica,
      ...(phaseContext.canonicalAppliedInput ? { canonicalAppliedInput: phaseContext.canonicalAppliedInput } : {}),
    };
  }

  const relayCertificate = workingReplica.pendingLeaderCertificate;
  if (
    !isSingleSigner &&
    localCanPropose &&
    !workingReplica.proposal &&
    relayCertificate?.targetHeight === workingReplica.state.height + 1 &&
    relayCertificate?.preparedFrameHash
  ) {
    const preparedFrame = workingReplica.lockedFrame;
    if (!preparedFrame || preparedFrame.hash !== relayCertificate.preparedFrameHash) {
      throw new Error(
        `ENTITY_PREPARED_RELAY_FRAME_MISSING:expected=${relayCertificate.preparedFrameHash}:` +
          `actual=${preparedFrame?.hash ?? 'none'}`,
      );
    }
    workingReplica.validatorExecution = await replayPreparedFrameForRelay(env, workingReplica, preparedFrame);
    workingReplica.proposal = cloneIsolatedProposedEntityFrame(preparedFrame);
    workingReplica.proposal.leader.relayCertificate = cloneIsolatedEntityLeaderCertificate(relayCertificate);
    for (const validatorId of workingReplica.state.config.validators) {
      if (validatorId.toLowerCase() === workingReplica.signerId.toLowerCase()) continue;
      entityOutbox.push({
        entityId: entityInput.entityId,
        signerId: validatorId,
        proposedFrame: cloneIsolatedProposedEntityFrame(workingReplica.proposal),
      });
    }
    entityLog.warn('leader.prepared_frame_relayed', {
      frame: shortHash(preparedFrame.hash),
      relayer: shortId(workingReplica.signerId),
      view: relayCertificate.toView,
    });
  }

  const hasCertifiedLeaderTransition = Boolean(
    workingReplica.pendingLeaderCertificate &&
    workingReplica.pendingLeaderCertificate.targetHeight === workingReplica.state.height + 1 &&
    !workingReplica.pendingLeaderCertificate.preparedFrameHash,
  );
  if (
    !isSingleSigner &&
    localCanPropose &&
    (proposalTxs.length > 0 ||
      shouldRollFrozenBaseJPrefixRound ||
      (proposalSelection.currentAuthorityReady && (hasProposableAccountMempool || hasCertifiedLeaderTransition))) &&
    !workingReplica.proposal &&
    !workingReplica.lockedFrame
  ) {
    entityLog.debug('proposal.auto_start', {
      mempool: proposalTxs.length,
      txs: proposalTxs.map(tx => tx.type),
    });
    const leader = getReplicaProposalLeader(workingReplica);
    assertProposerJRangesMatchLocalHistory(env, workingReplica, proposalTxs);
    assertFrameJPrefix(env, workingReplica, {
      height: workingReplica.state.height + 1,
      parentFrameHash: getPrevFrameHash(workingReplica.state),
      leader: { proposerSignerId: workingReplica.signerId.toLowerCase(), view: leader.view },
      txs: proposalTxs,
      ...(proposalJPrefixCertificate ? { jPrefixCertificate: proposalJPrefixCertificate } : {}),
    });
    const {
      newState: newEntityState,
      outputs: proposalOutputs,
      jOutputs: proposalJOutputs,
      candidateEffects,
      storageChanges,
      collectedHashes = [],
      consumptionNodeChanges,
      accountJClaimNodeChanges,
    } = await applyEntityFrame(env, workingReplica.state, proposalTxs, env.timestamp);

    // Outputs are stored on the proposal and emitted only after quorum hankos are
    // available. Re-applying at commit would duplicate side effects.

    const newTimestamp = env.timestamp;
    const newHeight = workingReplica.state.height + 1;

    // Build proposed new state (full state with account proposals — for commit)
    const committedLeaderState = {
      activeValidatorId: workingReplica.signerId.toLowerCase(),
      view: leader.view,
      changedAtHeight: workingReplica.pendingLeaderCertificate
        ? newHeight
        : (workingReplica.state.leaderState?.changedAtHeight ?? 0),
    };
    const proposedNewState = {
      ...newEntityState,
      entityId: workingReplica.state.entityId,
      height: newHeight,
      timestamp: newTimestamp,
      leaderState: committedLeaderState,
    };

    const prevFrameHash = getPrevFrameHash(workingReplica.state);
    const stateRoot = computeCanonicalEntityConsensusStateHash(proposedNewState);
    const authorityRoot = computeEntityFrameAuthorityRoot(buildEntityFrameAuthority(proposedNewState));
    const frameHash = createEntityFrameHashFromStateRoot(
      prevFrameHash,
      newHeight,
      newTimestamp,
      proposalTxs,
      proposedNewState.entityId,
      stateRoot,
      authorityRoot,
      proposalJPrefixCertificate ?? undefined,
    );
    const outputHashes = buildCertifiedEntityOutputHashes(proposedNewState, env, newHeight, frameHash, proposalOutputs);
    const hashesToSign = buildEntityHashesToSign(workingReplica.state.entityId, newHeight, frameHash, [
      ...collectedHashes,
      ...outputHashes,
    ]);

    await assertEntityConfigBoardAuthority(
      env,
      workingReplica.state.entityId,
      workingReplica.state.config,
      proposedNewState,
    );
    const selfSigs = await Promise.all(hashesToSign.map(h => signAccountFrame(env, workingReplica.signerId, h.hash)));

    const proposal: ProposedEntityFrame = {
      height: newHeight,
      parentFrameHash: prevFrameHash,
      stateRoot,
      authorityRoot,
      txs: [...proposalTxs],
      hash: frameHash,
      timestamp: newTimestamp,
      leader: {
        proposerSignerId: workingReplica.signerId.toLowerCase(),
        view: leader.view,
        ...(workingReplica.pendingLeaderCertificate ? { certificate: workingReplica.pendingLeaderCertificate } : {}),
      },
      ...(proposalJPrefixCertificate ? { jPrefixCertificate: structuredClone(proposalJPrefixCertificate) } : {}),
      hashesToSign,
      collectedSigs: new Map([[workingReplica.signerId, selfSigs]]),
    };
    workingReplica.proposal = proposal;
    workingReplica.validatorExecution = {
      frameHash,
      height: newHeight,
      state: proposedNewState,
      outputs: proposalOutputs,
      jOutputs: proposalJOutputs,
      hashesToSign,
      candidateEffects,
      storageChanges,
      ...(consumptionNodeChanges ? { consumptionNodeChanges } : {}),
      ...(accountJClaimNodeChanges ? { accountJClaimNodeChanges } : {}),
    };

    entityLog.debug('proposal.created', {
      frame: shortHash(proposal.hash),
      txs: proposal.txs.length,
      hashes: hashesToSign.length,
    });

    workingReplica.state.config.validators.forEach(validatorId => {
      if (validatorId !== workingReplica.signerId) {
        entityOutbox.push({
          entityId: entityInput.entityId,
          signerId: validatorId,
          proposedFrame: proposal,
        });
      }
    });
  }

  if (!quietRuntimeLogs) {
    entityLog.debug('outputs.generated', {
      entity: entityDisplay,
      signer: shortId(workingReplica.signerId),
      outputs: entityOutbox.length,
      proposal: shortHash(workingReplica.proposal?.hash || 'none'),
      mempool: workingReplica.mempool.length,
      locked: shortHash(workingReplica.lockedFrame?.hash || 'none'),
    });
  }

  entityOutbox.forEach((output, index) => {
    if (!HEAVY_LOGS) return;
    entityLog.trace('output.detail', {
      index,
      entity: shortId(output.entityId),
      signer: shortId(output.signerId ?? ''),
      txs: output.entityTxs?.length || 0,
      hashPrecommits: output.hashPrecommits?.size || 0,
      frame: shortHash(output.proposedFrame?.hash || 'none'),
      commit: Boolean(output.proposedFrame?.collectedSigs?.size),
    });
  });

  if (trustedLocalCrossJurisdiction) {
    throw new Error(
      `CROSS_J_LOCAL_COMMAND_NOT_FINALIZED:${workingReplica.entityId}:` +
        `proposal=${workingReplica.proposal?.hash ?? 'none'}:txs=${trustedLocalEntityTxs.length}`,
    );
  }

  return {
    outcome: { kind: 'committed' },
    newState: workingReplica.state,
    outputs: entityOutbox,
    jOutputs: jOutbox,
    workingReplica,
    ...(phaseContext.canonicalAppliedInput ? { canonicalAppliedInput: phaseContext.canonicalAppliedInput } : {}),
  };
};
