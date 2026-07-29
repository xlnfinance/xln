import { logError, shortHash } from '../../infra/logger';
import type { EntityState, ProposedEntityFrame, EntityCandidate } from '../types';
import { applyEntityFrame } from './frame-application';
import { createEntityFrameHashFromStateRoot, entityFrameEventsEqual } from './frame';
import { buildEntityHashesToSign } from './hanko-witness';
import {
  deferEntityConsensusInput,
  rejectEntityConsensusInput,
  type ApplyEntityInputContext,
  type ApplyEntityInputResult,
} from './input-types';
import { buildCertifiedEntityOutputHashes } from './output-certification';
import {
  buildEntityFrameAuthority,
  computeCanonicalEntityConsensusStateHash,
  computeEntityFrameAuthorityRoot,
} from './state-root';
import {
  expectedCommittedLeaderState,
  getValidatorExecutionForFrame,
} from './leader-certificates';
import { entityLog } from './entity-log';
import {
  getFrameJPrefixValidationError,
  getReplicaJRangeValidationError,
  isJPrefixLocalFreshnessRace,
} from './j-prefix-round';
import { getPrevFrameHash } from './frame-lineage';

export type CommitExecutionResolution =
  | { kind: 'execution'; execution: EntityCandidate }
  | { kind: 'result'; result: ApplyEntityInputResult };

type ReplayedCommitments =
  | {
      kind: 'valid';
      authorityRoot: string;
      replayedHash: string;
      stateRoot: string;
    }
  | { kind: 'result'; result: ApplyEntityInputResult };

const validateCatchUpJRange = (
  context: ApplyEntityInputContext,
  frame: ProposedEntityFrame,
): ApplyEntityInputResult | null => {
  const { env, workingReplica } = context;
  const rangeError = getReplicaJRangeValidationError(
    env,
    workingReplica,
    frame.txs,
  );
  if (rangeError) {
    entityLog.error('commit.catch_up_j_range_rejected', { error: rangeError });
    return rejectEntityConsensusInput(context, 'COMMIT_J_RANGE_MISMATCH');
  }
  const prefixError = getFrameJPrefixValidationError(env, workingReplica, frame);
  if (!prefixError) return null;
  if (prefixError.startsWith('J_PREFIX_LOCAL_HISTORY_BEHIND:')) {
    return deferEntityConsensusInput(context, 'COMMIT_J_PREFIX_HISTORY_WAIT');
  }
  if (!isJPrefixLocalFreshnessRace(prefixError)) {
    entityLog.error('commit.j_prefix_rejected', { error: prefixError });
    return rejectEntityConsensusInput(context, 'COMMIT_J_RANGE_MISMATCH');
  }
  // Catch-up must apply H before reaching H+1, which finalizes the newer local
  // observation. Intrinsic range, root and signature checks remain mandatory.
  entityLog.info('commit.catch_up_local_j_prefix_ahead', {
    error: prefixError,
    frameHeight: frame.height,
    localFinalizedJHeight: workingReplica.state.lastFinalizedJHeight,
    localScannedThroughHeight:
      workingReplica.jHistory?.scannedThroughHeight ?? null,
  });
  return null;
};

const validateReplayedCommitments = (
  context: ApplyEntityInputContext,
  frame: ProposedEntityFrame,
  state: EntityState,
): ReplayedCommitments => {
  const { workingReplica } = context;
  const stateRoot = computeCanonicalEntityConsensusStateHash(state);
  if (stateRoot !== frame.stateRoot) {
    return {
      kind: 'result',
      result: rejectEntityConsensusInput(context, 'COMMIT_STATE_ROOT_MISMATCH'),
    };
  }
  const authorityRoot = computeEntityFrameAuthorityRoot(
    buildEntityFrameAuthority(state),
  );
  if (authorityRoot !== frame.authorityRoot) {
    return {
      kind: 'result',
      result: rejectEntityConsensusInput(context, 'COMMIT_AUTHORITY_ROOT_MISMATCH'),
    };
  }
  const replayedHash = createEntityFrameHashFromStateRoot(
    getPrevFrameHash(workingReplica.state),
    frame.height,
    frame.timestamp,
    frame.txs,
    frame.events,
    state.entityId,
    stateRoot,
    authorityRoot,
    frame.jPrefixCertificate,
  );
  if (replayedHash !== frame.hash) {
    logError(
      'FRAME_CONSENSUS',
      '❌ COMMIT REJECTED: replayed catch-up state does not match signed frame hash!',
      { expected: replayedHash, received: frame.hash },
    );
    return { kind: 'result', result: rejectEntityConsensusInput(context) };
  }
  return { kind: 'valid', authorityRoot, replayedHash, stateRoot };
};

const replayCommitFrame = async (
  context: ApplyEntityInputContext,
  frame: ProposedEntityFrame,
): Promise<CommitExecutionResolution> => {
  const { env, workingReplica } = context;
  const jValidationResult = validateCatchUpJRange(context, frame);
  if (jValidationResult) return { kind: 'result', result: jValidationResult };
  const {
    newState,
    collectedHashes = [],
    outputs,
    jOutputs,
    candidateEffects,
    events,
    storageChanges,
    consumptionNodeChanges,
    accountJClaimNodeChanges,
  } = await applyEntityFrame(
    env,
    workingReplica.state,
    frame.txs,
    frame.timestamp,
  );
  if (!entityFrameEventsEqual(events, frame.events)) {
    return {
      kind: 'result',
      result: rejectEntityConsensusInput(context, 'COMMIT_FRAME_EVENTS_MISMATCH'),
    };
  }
  const state = {
    ...newState,
    entityId: workingReplica.state.entityId,
    height: frame.height,
    timestamp: frame.timestamp,
    leaderState: expectedCommittedLeaderState(workingReplica.state, frame),
  };
  const commitments = validateReplayedCommitments(context, frame, state);
  if (commitments.kind === 'result') return commitments;
  const { replayedHash } = commitments;
  const outputHashes = buildCertifiedEntityOutputHashes(
    state,
    env,
    frame.height,
    replayedHash,
    outputs,
  );
  const hashesToSign = buildEntityHashesToSign(
    workingReplica.state.entityId,
    frame.height,
    replayedHash,
    [...collectedHashes, ...outputHashes],
  );
  entityLog.warn('commit.catch_up_state_replayed', {
    height: frame.height,
    frame: shortHash(frame.hash),
  });
  return {
    kind: 'execution',
    execution: {
      frameHash: frame.hash,
      height: frame.height,
      state,
      outputs,
      jOutputs,
      hashesToSign,
      candidateEffects,
      storageChanges,
      ...(consumptionNodeChanges ? { consumptionNodeChanges } : {}),
      ...(accountJClaimNodeChanges ? { accountJClaimNodeChanges } : {}),
    },
  };
};

export const resolveCommitExecution = async (
  context: ApplyEntityInputContext,
  frame: ProposedEntityFrame,
): Promise<CommitExecutionResolution> => {
  const { workingReplica } = context;
  const existing = getValidatorExecutionForFrame(workingReplica, frame);
  if (existing) return { kind: 'execution', execution: existing };
  const expectedPreviousHeight = frame.height - 1;
  if (workingReplica.state.height !== expectedPreviousHeight) {
    entityLog.warn('commit.catch_up_state_wait', {
      height: workingReplica.state.height,
      expectedPrevHeight: expectedPreviousHeight,
      commitHeight: frame.height,
      frame: shortHash(frame.hash),
    });
    // Do not ACK a certificate before the exact predecessor state exists.
    return {
      kind: 'result',
      result: deferEntityConsensusInput(
        context,
        'COMMIT_CATCH_UP_STATE_WAIT',
      ),
    };
  }
  return replayCommitFrame(context, frame);
};
