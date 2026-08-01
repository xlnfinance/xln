import { logError, shortHash } from '../../infra/logger';
import type { EntityState, EntityFrame, EntityCandidate } from '../types';
import { applyEntityFrame } from './frame-application';
import { createEntityFrameHashFromStateRoot, entityFrameEventsEqual } from './frame';
import {
  buildEntityHashesToSign,
  getEntityHashManifestMismatch,
} from './hanko-witness';
import {
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
} from './leader-certificates';
import { entityLog } from './entity-log';
import { getPrevFrameHash } from './frame-lineage';
import { MalformedEntityFrameInputError } from '../tx/invariant-errors';

export type ProposalReplayResult =
  | { accepted: true; execution: EntityCandidate }
  | { accepted: false; result: ApplyEntityInputResult };

const rejectProposal = (
  context: ApplyEntityInputContext,
  reason?: string,
): ProposalReplayResult => ({ accepted: false, result: rejectEntityConsensusInput(context, reason) });

const verifyProposalRoots = (
  context: ApplyEntityInputContext,
  frame: EntityFrame,
  state: EntityState,
): ProposalReplayResult | null => {
  const stateRoot = computeCanonicalEntityConsensusStateHash(state);
  if (stateRoot !== frame.stateRoot) {
    entityLog.error('proposal.state_root_rejected', {
      expected: stateRoot,
      received: frame.stateRoot,
    });
    return rejectProposal(context, 'PROPOSAL_STATE_ROOT_MISMATCH');
  }
  const authorityRoot = computeEntityFrameAuthorityRoot(
    buildEntityFrameAuthority(state),
  );
  if (authorityRoot !== frame.authorityRoot) {
    entityLog.error('proposal.authority_root_rejected', {
      expected: authorityRoot,
      received: frame.authorityRoot,
    });
    return rejectProposal(context, 'PROPOSAL_AUTHORITY_ROOT_MISMATCH');
  }
  return null;
};

const verifyProposalFrameHash = (
  context: ApplyEntityInputContext,
  frame: EntityFrame,
  state: EntityState,
): ProposalReplayResult | null => {
  const frameHash = createEntityFrameHashFromStateRoot(
    getPrevFrameHash(context.workingReplica.state),
    frame.height,
    frame.timestamp,
    frame.txs,
    frame.events,
    state.entityId,
    frame.stateRoot,
    frame.authorityRoot,
    frame.jPrefixCertificate,
  );
  if (frameHash === frame.hash) return null;
  logError('FRAME_CONSENSUS', '❌ HASH MISMATCH: invalid proposal frame hash', {
    expected: frameHash,
    received: frame.hash,
  });
  return rejectProposal(context, 'PROPOSAL_FRAME_HASH_MISMATCH');
};

const buildVerifiedProposalHashes = (
  context: ApplyEntityInputContext,
  frame: EntityFrame,
  state: EntityState,
  outputs: EntityCandidate['outputs'],
  collectedHashes: NonNullable<EntityCandidate['hashesToSign']>,
): NonNullable<EntityCandidate['hashesToSign']> | ProposalReplayResult => {
  const outputHashes = buildCertifiedEntityOutputHashes(
    state,
    context.env,
    frame.height,
    frame.hash,
    outputs,
  );
  const hashesToSign = buildEntityHashesToSign(
    context.workingReplica.state.entityId,
    frame.height,
    frame.hash,
    [...collectedHashes, ...outputHashes],
  );
  const mismatch = getEntityHashManifestMismatch(hashesToSign, frame.hashesToSign);
  if (!mismatch) return hashesToSign;
  logError(
    'FRAME_CONSENSUS',
    `❌ BYZANTINE: Secondary hash manifest mismatch: ${mismatch}`,
    {
      frame: frame.hash,
      expected: hashesToSign,
      received: frame.hashesToSign ?? null,
    },
  );
  return rejectProposal(context);
};

export const replayProposedEntityFrame = async (
  context: ApplyEntityInputContext,
  frame: EntityFrame,
): Promise<ProposalReplayResult> => {
  let applied: Awaited<ReturnType<typeof applyEntityFrame>>;
  try {
    applied = await applyEntityFrame(
      context.env,
      context.workingReplica.state,
      frame.txs,
      frame.timestamp,
    );
  } catch (error) {
    if (error instanceof MalformedEntityFrameInputError) {
      entityLog.info('proposal.execution_rejected', {
        txType: error.txType,
        rejection: error.rejection,
      });
      return rejectProposal(
        context,
        error.txType === 'entityCommand'
          ? 'PROPOSAL_ENTITY_COMMAND_REJECTED'
          : 'PROPOSAL_FRAME_INPUT_REJECTED',
      );
    }
    throw error;
  }
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
  } = applied;
  if (!entityFrameEventsEqual(events, frame.events)) {
    return rejectProposal(context, 'PROPOSAL_FRAME_EVENTS_MISMATCH');
  }
  const state = {
    ...newState,
    entityId: context.workingReplica.state.entityId,
    height: frame.height,
    timestamp: frame.timestamp,
    leaderState: expectedCommittedLeaderState(context.workingReplica.state, frame),
  };
  const rootFailure = verifyProposalRoots(context, frame, state);
  if (rootFailure) return rootFailure;
  const hashFailure = verifyProposalFrameHash(context, frame, state);
  if (hashFailure) return hashFailure;
  const hashesToSign = buildVerifiedProposalHashes(
    context,
    frame,
    state,
    outputs,
    collectedHashes,
  );
  if (!Array.isArray(hashesToSign)) return hashesToSign;

  entityLog.debug('proposal.hash_verified', { frame: shortHash(frame.hash) });
  return {
    accepted: true,
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
