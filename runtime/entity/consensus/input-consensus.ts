/**
 * Entity consensus: validator replicas agree on entity frames, then route
 * committed account/J-layer side effects back into the runtime.
 */

import { logError, shortHash, shortId } from '../../infra/logger';
import type {
  EntityInput,
  EntityReplica,
  Env,
} from '../../types';
import { getPerfMs, HEAVY_LOGS } from '../../utils';
import { accountHasProposableMempool } from './account-mempool-eligibility';
import { isCanonicalEntityFrameDigest } from './frame';
import {
  deferEntityConsensusInput,
  noopEntityConsensusInput,
  rejectEntityConsensusInput,
  type ApplyEntityInputContext,
  type ApplyEntityInputResult,
} from './input-types';
import { prepareEntityInputIngress } from './input-ingress';
import { admitEntityTransactions } from './input-admission';

import {
  assertFrameParentMatchesState,
  calculateQuorumPower,
  ensureLocalJPrefixAttestation,
  entityLog,
  normalizePrecommitBundles,
  validateProposedFrameLeader,
} from './shared';
import { selectEntityProposal } from './proposal-selection';
import { commitSingleSignerFrameIfReady } from './single-signer-frame';
import { handleJPrefixAttestations } from './j-prefix-input';
import { handleLeaderTimeoutVote } from './leader-timeout-input';
import { resolveCommitExecution } from './commit-catch-up';
import { finalizeCommitNotification } from './commit-finalization';
import { handleProposedFramePrecommit } from './proposal-input';
import { handleHashPrecommits } from './precommit-input';
import {
  relayPreparedFrameIfReady,
  startMultiSignerProposalIfReady,
} from './multi-signer-proposal';

export type { EntityInputOutcome } from './input-types';

async function handleCommitNotification(context: ApplyEntityInputContext): Promise<ApplyEntityInputResult | null> {
  const { env, entityInput, workingReplica } = context;
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

  const executionResolution = await resolveCommitExecution(context, proposedFrame);
  if (executionResolution.kind === 'result') return executionResolution.result;
  return finalizeCommitNotification(
    context,
    proposedFrame,
    executionResolution.execution,
    frameCollectedSigs,
  );
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
  const ingress = prepareEntityInputIngress(
    env,
    entityReplica,
    entityInput,
    trustedLocalCrossJurisdiction,
  );
  if (!ingress.accepted) return ingress.result;
  const phaseContext = ingress.context;
  entityInput = phaseContext.entityInput;
  const { entityOutbox, jOutbox, workingReplica } = phaseContext;
  const { entityDisplay, quietRuntimeLogs } = ingress;
  checkpointConsensusProfile('ingress');

  const leaderVoteResult = await handleLeaderTimeoutVote(phaseContext);
  if (leaderVoteResult) return leaderVoteResult;
  const jPrefixResult = handleJPrefixAttestations(phaseContext);
  if (jPrefixResult) return jPrefixResult;
  const { localCanPropose, trustedLocalEntityTxs } =
    await admitEntityTransactions(phaseContext, trustedLocalCrossJurisdiction);
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

  const {
    hasProposableAccountMempool,
    isSingleSigner,
    proposalJPrefixCertificate,
    proposalSelection,
    proposalTxs,
    shouldRollFrozenBaseJPrefixRound,
  } = await selectEntityProposal(env, workingReplica, {
    localCanPropose,
    trustedLocalCrossJurisdiction,
    trustedLocalEntityTxs,
    checkpoint: checkpointConsensusProfile,
  });

  const singleSignerResult = isSingleSigner
    ? await commitSingleSignerFrameIfReady(phaseContext, {
        localCanPropose,
        hasProposableAccountMempool,
        proposalJPrefixCertificate,
        proposalSelection,
        proposalTxs,
        shouldRollFrozenBaseJPrefixRound,
        profileStartedAt: consensusProfileStartedAt,
        profileCheckpoints: consensusProfileCheckpoints,
        checkpoint: checkpointConsensusProfile,
      })
    : null;
  if (singleSignerResult) return singleSignerResult;

  await relayPreparedFrameIfReady(phaseContext, localCanPropose, isSingleSigner);
  await startMultiSignerProposalIfReady(phaseContext, {
    hasProposableAccountMempool,
    isSingleSigner,
    proposalJPrefixCertificate,
    proposalSelection,
    proposalTxs,
    shouldRollFrozenBaseJPrefixRound,
  }, localCanPropose);

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
