import { haltRuntimeFailure } from "../../../protocol/errors/failure-taxonomy";

/**
 * Entity consensus: validator replicas agree on entity frames, then route
 * committed account/J-layer side effects back into the runtime.
 */

import { logError, shortHash } from '../../../support/logger';
import type { EntityInput, EntityReplica } from '../../types';
import type { EntityRuntimeContext } from '../../runtime-context';
import { getPerfMs } from '../../../support/time';
import { hasProposableAccount } from '../account/work-index';
import { isCanonicalEntityFrameDigest } from '../frame';
import {
  deferEntityConsensusInput,
  noopEntityConsensusInput,
  rejectEntityConsensusInput,
  type ApplyEntityInputContext,
  type ApplyEntityInputResult,
} from './types';
import { prepareEntityInputIngress } from './ingress';
import { admitEntityTransactions } from './admission';

import {
  normalizePrecommitBundles,
} from '../leader/certificates';
import { entityLog } from '../entity-log';
import { ensureLocalJPrefixAttestation } from '../j-prefix/prefix-round';
import { preauthenticateEntityProposal } from '../proposal/preauthentication';
import { calculateQuorumPower } from '../replica-validation';
import { selectEntityProposal } from '../proposal/selection';
import { handleJPrefixAttestations } from '../j-prefix/prefix-input';
import { handleLeaderTimeoutVote } from '../leader/timeout-input';
import { resolveCommitExecution } from '../commit/catch-up';
import { finalizeCommitNotification } from '../commit/finalization';
import { handleProposedFramePrecommit } from '../proposal/input';
import { handleHashPrecommits } from '../proposal/precommit-input';
import {
  relayPreparedFrameIfReady,
  startEntityProposalIfReady,
} from '../proposal/start';
import { getEntityFrameConsensusConfig } from '../authority/board-handover';

export type { EntityInputOutcome } from './types';

async function handleCommitNotification(context: ApplyEntityInputContext): Promise<ApplyEntityInputResult | null> {
  const { entityInput, workingReplica } = context;
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
  if (proposedFrame.height < workingReplica.state.height) {
    return noopEntityConsensusInput(context, 'COMMIT_STALE');
  }
  if (workingReplica.state.height === proposedFrame.height) {
    return workingReplica.state.prevFrameHash === proposedFrame.hash
      ? noopEntityConsensusInput(context, 'COMMIT_ALREADY_APPLIED')
      : rejectEntityConsensusInput(context, 'COMMIT_HEIGHT_HASH_CONFLICT');
  }
  const authenticationResult = preauthenticateEntityProposal(
    context,
    proposedFrame,
  );
  if (authenticationResult) return authenticationResult;
  const authorityConfig = getEntityFrameConsensusConfig(
    context.env,
    workingReplica.state,
    proposedFrame.txs,
  );
  let frameCollectedSigs: Map<string, string[]>;
  try {
    frameCollectedSigs = normalizePrecommitBundles(
      authorityConfig,
      rawFrameCollectedSigs,
      'COMMIT_REJECTED',
    );
  } catch (error) {
    entityLog.error('commit.bundle_rejected', { error: error instanceof Error ? error.message : String(error) });
    return rejectEntityConsensusInput(context, 'COMMIT_BUNDLE_REJECTED');
  }
  proposedFrame.collectedSigs = frameCollectedSigs;
  const signers = Array.from(frameCollectedSigs.keys());
  const totalPower = calculateQuorumPower(authorityConfig, signers);
  if (totalPower < authorityConfig.threshold) {
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

  const executionResolution = await resolveCommitExecution(context, proposedFrame);
  if (executionResolution.kind === 'result') return executionResolution.result;
  return finalizeCommitNotification(
    context,
    proposedFrame,
    executionResolution.execution,
    frameCollectedSigs,
  );
}

type EntityProposalSelection = Awaited<ReturnType<typeof selectEntityProposal>>;

const hasLocalConsensusWork = (
  replica: EntityReplica,
  trustedLocalEntityTxs: EntityInput['entityTxs'],
): boolean =>
  Boolean(trustedLocalEntityTxs?.length) ||
  replica.mempool.length > 0 ||
  hasProposableAccount(replica.state);

const advanceEntityProposal = async (
  context: ApplyEntityInputContext,
  selection: EntityProposalSelection,
  localCanPropose: boolean,
  profile: {
    startedAt: number;
    checkpoints: Record<string, number>;
    checkpoint: (label: string) => void;
  },
): Promise<ApplyEntityInputResult | null> => {
  await relayPreparedFrameIfReady(context, localCanPropose, selection.isSingleSigner);
  return startEntityProposalIfReady(context, selection, localCanPropose, profile);
};

/**
 * Main entity input processor - handles consensus, proposals, and state transitions
 */
/** Only transaction-carrying inputs without consensus evidence may wait for the batch flush. */
export const isProposalDeferrableEntityInput = (input: EntityInput): boolean =>
  !input.proposedFrame &&
  !(input.hashPrecommits && input.hashPrecommits.size > 0) &&
  !input.hashPrecommitFrame &&
  !input.jPrefixAttestations &&
  !input.leaderTimeoutVote &&
  !input.localRuntimeProtocol &&
  (input.entityTxs?.length ?? 0) > 0;

export const applyEntityInput = async (
  env: EntityRuntimeContext,
  entityReplica: EntityReplica,
  entityInput: EntityInput,
  options: {
    trustedLocalRuntimeProtocol?: 'cross-j' | 'account-work';
    promoteCandidateState?: boolean;
    /**
     * Admit the input's transactions into the replica mempool without opening
     * a proposal. The Runtime batch flushes every touched replica once at the
     * end of the frame, so N plain inputs become one Entity frame (R → E → A).
     */
    deferProposal?: boolean;
  } = {},
): Promise<ApplyEntityInputResult> => {
  const consensusProfileStartedAt = getPerfMs();
  const consensusProfileCheckpoints: Record<string, number> = {};
  const checkpointConsensusProfile = (label: string): void => {
    consensusProfileCheckpoints[label] = Math.round(getPerfMs() - consensusProfileStartedAt);
  };
  const trustedLocalCrossJurisdiction = options.trustedLocalRuntimeProtocol === 'cross-j';
  const accountWorkOnly = options.trustedLocalRuntimeProtocol === 'account-work';
  const ingress = prepareEntityInputIngress(
    env,
    entityReplica,
    entityInput,
    options.trustedLocalRuntimeProtocol,
    options.promoteCandidateState !== false,
  );
  if (!ingress.accepted) return ingress.result;
  const phaseContext = ingress.context;
  entityInput = phaseContext.entityInput;
  const { entityOutbox, jOutbox, workingReplica } = phaseContext;
  checkpointConsensusProfile('ingress');

  const leaderVoteResult = await handleLeaderTimeoutVote(phaseContext);
  if (leaderVoteResult) return leaderVoteResult;
  const jPrefixResult = handleJPrefixAttestations(phaseContext);
  if (jPrefixResult) return jPrefixResult;
  const { localCanPropose, trustedLocalEntityTxs } =
    await admitEntityTransactions(
      phaseContext,
      trustedLocalCrossJurisdiction,
      accountWorkOnly,
    );
  checkpointConsensusProfile('admission');

  const commitNotificationResult = await handleCommitNotification(phaseContext);
  if (commitNotificationResult) return commitNotificationResult;

  if (
    options.deferProposal &&
    !trustedLocalCrossJurisdiction &&
    !accountWorkOnly &&
    isProposalDeferrableEntityInput(entityInput)
  ) {
    checkpointConsensusProfile('deferred');
    return {
      outcome: { kind: 'committed' },
      newState: workingReplica.state,
      outputs: entityOutbox,
      jOutputs: jOutbox,
      workingReplica,
      candidateEffects: phaseContext.candidateEffects,
      storageChanges: phaseContext.storageChanges,
      ...(phaseContext.canonicalAppliedInput ? { canonicalAppliedInput: phaseContext.canonicalAppliedInput } : {}),
      ...(phaseContext.entityContext ? { entityContext: phaseContext.entityContext } : {}),
    };
  }

  const proposedFramePrecommitResult = await handleProposedFramePrecommit(phaseContext);
  if (proposedFramePrecommitResult) return proposedFramePrecommitResult;

  const hashPrecommitResult = await handleHashPrecommits(phaseContext);
  if (hashPrecommitResult) return hashPrecommitResult;

  if (entityInput.jPrefixAttestations || hasLocalConsensusWork(workingReplica, trustedLocalEntityTxs)) {
    // Commit/proposal notifications above may advance the parent Entity height.
    // Only sign after those terminal paths so this validator never emits a head
    // for a parent that was committed by the same input.
    ensureLocalJPrefixAttestation(env, workingReplica, entityOutbox, Boolean(entityInput.jPrefixAttestations));
  }

  const proposalSelection = await selectEntityProposal(env, workingReplica, {
    localCanPropose,
    trustedLocalCrossJurisdiction,
    trustedLocalEntityTxs,
    accountWorkOnly,
    checkpoint: checkpointConsensusProfile,
  });
  const proposalResult = await advanceEntityProposal(
    phaseContext,
    proposalSelection,
    localCanPropose,
    {
      startedAt: consensusProfileStartedAt,
      checkpoints: consensusProfileCheckpoints,
      checkpoint: checkpointConsensusProfile,
    },
  );
  if (proposalResult) return proposalResult;

  if (trustedLocalCrossJurisdiction) {
    throw haltRuntimeFailure("CROSS_J_LOCAL_COMMAND_NOT_FINALIZED", `CROSS_J_LOCAL_COMMAND_NOT_FINALIZED:${workingReplica.entityId}:` +
        `proposal=${workingReplica.proposal?.hash ?? 'none'}:txs=${trustedLocalEntityTxs.length}`);
  }

  return {
    outcome: { kind: 'committed' },
    newState: workingReplica.state,
    outputs: entityOutbox,
    jOutputs: jOutbox,
    workingReplica,
    candidateEffects: phaseContext.candidateEffects,
    storageChanges: phaseContext.storageChanges,
    ...(phaseContext.canonicalAppliedInput ? { canonicalAppliedInput: phaseContext.canonicalAppliedInput } : {}),
    ...(phaseContext.entityContext ? { entityContext: phaseContext.entityContext } : {}),
  };
};
