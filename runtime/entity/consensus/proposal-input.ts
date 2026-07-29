import { signAccountFrame } from '../../account/crypto';
import { assertEntityConfigBoardAuthority } from '../../hanko/signing';
import { shortHash, shortId } from '../../infra/logger';
import type { ProposedEntityFrame } from '../types';
import {
  deferEntityConsensusInput,
  noopEntityConsensusInput,
  rejectEntityConsensusInput,
  type ApplyEntityInputContext,
  type ApplyEntityInputResult,
} from './input-types';
import { replayProposedEntityFrame } from './proposal-replay';
import {
  entityLog,
  getFrameJPrefixValidationError,
  getReplicaJRangeValidationError,
  isJPrefixLocalFreshnessRace,
  normalizePrecommitBundles,
  verifyHashPrecommitSignatures,
} from './shared';
import { assertFrameParentMatchesState } from './frame-lineage';
import { validateProposedFrameLeader } from './proposal-policy';

const validateProposalEnvelope = (
  context: ApplyEntityInputContext,
  frame: ProposedEntityFrame,
): ApplyEntityInputResult | null => {
  const { env, workingReplica } = context;
  if (frame.height < workingReplica.state.height) {
    return noopEntityConsensusInput(context, 'PROPOSAL_STALE');
  }
  if (frame.height === workingReplica.state.height) {
    return workingReplica.state.prevFrameHash === frame.hash
      ? noopEntityConsensusInput(context, 'PROPOSAL_ALREADY_COMMITTED')
      : rejectEntityConsensusInput(context, 'PROPOSAL_HEIGHT_HASH_CONFLICT');
  }
  const existingFrame = workingReplica.proposal ?? workingReplica.lockedFrame;
  if (existingFrame) {
    if (existingFrame.hash === frame.hash) return null;
    if (existingFrame.height < frame.height) {
      return deferEntityConsensusInput(context, 'PROPOSAL_PRIOR_FRAME_PENDING');
    }
    entityLog.error('proposal.conflict_rejected', {
      existing: shortHash(existingFrame.hash),
      incoming: shortHash(frame.hash),
    });
    return rejectEntityConsensusInput(context);
  }
  const expectedPreviousHeight = frame.height - 1;
  if (workingReplica.state.height !== expectedPreviousHeight) {
    entityLog.warn('proposal.catch_up_wait', {
      signer: shortId(workingReplica.signerId),
      height: workingReplica.state.height,
      expectedPrevHeight: expectedPreviousHeight,
    });
    return deferEntityConsensusInput(context, 'PROPOSAL_CATCH_UP_STATE_WAIT');
  }
  assertFrameParentMatchesState(
    workingReplica.state,
    frame,
    'PROPOSAL_PARENT_MISMATCH',
  );
  if (!validateProposedFrameLeader(env, workingReplica.state, frame)) {
    entityLog.error('proposal.leader_rejected', {
      proposer: shortId(frame.leader?.proposerSignerId ?? ''),
      view: frame.leader?.view ?? null,
    });
    return rejectEntityConsensusInput(context);
  }
  return null;
};

const validateProposalViewAndJRange = (
  context: ApplyEntityInputContext,
  frame: ProposedEntityFrame,
): ApplyEntityInputResult | null => {
  const { env, workingReplica } = context;
  const effectiveView = Math.max(
    frame.leader.view,
    frame.leader.certificate?.toView ?? -1,
    frame.leader.relayCertificate?.toView ?? -1,
  );
  const localValidatorId = workingReplica.signerId.trim().toLowerCase();
  const localVotedView = Math.max(
    -1,
    ...[...(workingReplica.leaderVotes?.values() ?? [])]
      .filter(
        vote =>
          vote.voterId.trim().toLowerCase() === localValidatorId &&
          vote.targetHeight === frame.height &&
          vote.signature.length > 0,
      )
      .map(vote => vote.toView),
  );
  const certifiedView =
    workingReplica.pendingLeaderCertificate?.targetHeight === frame.height
      ? workingReplica.pendingLeaderCertificate.toView
      : -1;
  if (Math.max(localVotedView, certifiedView) > effectiveView) {
    // Transport reordering must not make a higher-view timeout signer later
    // authorize a superseded proposal.
    entityLog.info('proposal.superseded_by_local_view', {
      frame: shortHash(frame.hash),
      proposalView: effectiveView,
      localVotedView,
      certifiedView,
    });
    return rejectEntityConsensusInput(
      context,
      'PROPOSAL_SUPERSEDED_BY_LOCAL_VIEW_CHANGE',
    );
  }
  const rangeError = getReplicaJRangeValidationError(
    env,
    workingReplica,
    frame.txs,
  );
  if (rangeError) {
    entityLog.error('proposal.j_range_rejected', { error: rangeError });
    return rejectEntityConsensusInput(context, 'PROPOSAL_J_RANGE_MISMATCH');
  }
  const prefixError = getFrameJPrefixValidationError(env, workingReplica, frame);
  if (!prefixError) return null;
  if (prefixError.startsWith('J_PREFIX_LOCAL_HISTORY_BEHIND:')) {
    return deferEntityConsensusInput(context, 'PROPOSAL_J_PREFIX_HISTORY_WAIT');
  }
  if (isJPrefixLocalFreshnessRace(prefixError)) {
    entityLog.info('proposal.j_prefix_stale', { error: prefixError });
  } else {
    entityLog.error('proposal.j_prefix_rejected', { error: prefixError });
  }
  return rejectEntityConsensusInput(context, 'PROPOSAL_J_RANGE_MISMATCH');
};

const signAndLockProposal = async (
  context: ApplyEntityInputContext,
  frame: ProposedEntityFrame,
): Promise<ApplyEntityInputResult | null> => {
  const { env, entityInput, entityOutbox, workingReplica } = context;
  const replay = await replayProposedEntityFrame(context, frame);
  if (!replay.accepted) return replay.result;
  const { execution } = replay;
  await assertEntityConfigBoardAuthority(
    env,
    workingReplica.state.entityId,
    workingReplica.state.config,
    execution.state,
  );
  const localSignatures = await Promise.all(
    execution.hashesToSign.map(hash =>
      signAccountFrame(env, workingReplica.signerId, hash.hash),
    ),
  );
  let proposedBundles: Map<string, string[]>;
  try {
    proposedBundles = normalizePrecommitBundles(
      workingReplica.state.config,
      frame.collectedSigs ?? new Map(),
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
        execution.hashesToSign,
        frame.hash,
        frame.height,
        signatures,
        'PROPOSAL_PRECOMMIT_REJECTED',
      )
    ) {
      return rejectEntityConsensusInput(context);
    }
    collectedSigs.set(signerId, [...signatures]);
  }
  const localSignerId = workingReplica.signerId.toLowerCase();
  const existingLocal = collectedSigs.get(localSignerId);
  if (
    existingLocal &&
    (existingLocal.length !== localSignatures.length ||
      existingLocal.some(
        (signature, index) => signature !== localSignatures[index],
      ))
  ) {
    return rejectEntityConsensusInput(
      context,
      'PROPOSAL_LOCAL_PRECOMMIT_CONFLICT',
    );
  }
  collectedSigs.set(localSignerId, localSignatures);
  workingReplica.lockedFrame = {
    ...frame,
    hashesToSign: execution.hashesToSign,
    collectedSigs,
  };
  workingReplica.candidate = execution;
  workingReplica.lastConsensusProgressAt = env.timestamp;
  for (const validatorId of workingReplica.state.config.validators) {
    if (validatorId.toLowerCase() === localSignerId) continue;
    entityOutbox.push({
      entityId: entityInput.entityId,
      signerId: validatorId,
      hashPrecommitFrame: { height: frame.height, frameHash: frame.hash },
      hashPrecommits: new Map([
        [workingReplica.signerId, localSignatures],
      ]),
    });
  }
  entityLog.debug('proposal.precommit_sent', {
    recipients: Math.max(
      0,
      workingReplica.state.config.validators.length - 1,
    ),
    frame: context.frameHash,
    signatures: localSignatures.length,
  });
  return null;
};

export const handleProposedFramePrecommit = async (
  context: ApplyEntityInputContext,
): Promise<ApplyEntityInputResult | null> => {
  const frame = context.entityInput.proposedFrame;
  if (!frame) return null;
  const envelopeResult = validateProposalEnvelope(context, frame);
  if (envelopeResult) return envelopeResult;
  const consensusResult = validateProposalViewAndJRange(context, frame);
  if (consensusResult) return consensusResult;
  return signAndLockProposal(context, frame);
};
