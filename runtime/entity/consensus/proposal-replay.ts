import { logError, shortHash } from '../../infra/logger';
import type {
  ProposedEntityFrame,
  ValidatorEntityFrameExecution,
} from '../../types';
import { applyEntityFrame } from './frame-application';
import { createEntityFrameHashFromStateRoot } from './frame';
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
  entityLog,
  expectedCommittedLeaderState,
  getPrevFrameHash,
} from './shared';

export type ProposalReplayResult =
  | { accepted: true; execution: ValidatorEntityFrameExecution }
  | { accepted: false; result: ApplyEntityInputResult };

export const replayProposedEntityFrame = async (
  context: ApplyEntityInputContext,
  frame: ProposedEntityFrame,
): Promise<ProposalReplayResult> => {
  const { env, workingReplica } = context;
  const {
    newState,
    collectedHashes = [],
    outputs,
    jOutputs,
    candidateEffects,
    storageChanges,
    consumptionNodeChanges,
    accountJClaimNodeChanges,
  } = await applyEntityFrame(
    env,
    workingReplica.state,
    frame.txs,
    frame.timestamp,
  );
  const state = {
    ...newState,
    entityId: workingReplica.state.entityId,
    height: frame.height,
    timestamp: frame.timestamp,
    leaderState: expectedCommittedLeaderState(workingReplica.state, frame),
  };
  const stateRoot = computeCanonicalEntityConsensusStateHash(state);
  if (stateRoot !== frame.stateRoot) {
    entityLog.error('proposal.state_root_rejected', {
      expected: stateRoot,
      received: frame.stateRoot,
    });
    return {
      accepted: false,
      result: rejectEntityConsensusInput(
        context,
        'PROPOSAL_STATE_ROOT_MISMATCH',
      ),
    };
  }
  const authorityRoot = computeEntityFrameAuthorityRoot(
    buildEntityFrameAuthority(state),
  );
  if (authorityRoot !== frame.authorityRoot) {
    entityLog.error('proposal.authority_root_rejected', {
      expected: authorityRoot,
      received: frame.authorityRoot,
    });
    return {
      accepted: false,
      result: rejectEntityConsensusInput(
        context,
        'PROPOSAL_AUTHORITY_ROOT_MISMATCH',
      ),
    };
  }
  const frameHash = createEntityFrameHashFromStateRoot(
    getPrevFrameHash(workingReplica.state),
    frame.height,
    frame.timestamp,
    frame.txs,
    state.entityId,
    stateRoot,
    authorityRoot,
    frame.jPrefixCertificate,
  );
  if (frameHash !== frame.hash) {
    logError('FRAME_CONSENSUS', '❌ HASH MISMATCH: invalid proposal frame hash', {
      expected: frameHash,
      received: frame.hash,
    });
    return {
      accepted: false,
      result: rejectEntityConsensusInput(
        context,
        'PROPOSAL_FRAME_HASH_MISMATCH',
      ),
    };
  }
  const outputHashes = buildCertifiedEntityOutputHashes(
    state,
    env,
    frame.height,
    frameHash,
    outputs,
  );
  const hashesToSign = buildEntityHashesToSign(
    workingReplica.state.entityId,
    frame.height,
    frameHash,
    [...collectedHashes, ...outputHashes],
  );
  const manifestMismatch = getEntityHashManifestMismatch(
    hashesToSign,
    frame.hashesToSign,
  );
  if (manifestMismatch) {
    logError(
      'FRAME_CONSENSUS',
      `❌ BYZANTINE: Secondary hash manifest mismatch: ${manifestMismatch}`,
      {
        frame: frame.hash,
        expected: hashesToSign,
        received: frame.hashesToSign ?? null,
      },
    );
    return {
      accepted: false,
      result: rejectEntityConsensusInput(context),
    };
  }
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
