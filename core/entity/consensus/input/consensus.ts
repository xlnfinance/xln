import { haltRuntimeFailure } from "../../../protocol/errors/failure-taxonomy";

/**
 * Entity consensus: validator replicas agree on entity frames, then route
 * committed account/J-layer side effects back into the runtime.
 */

import { logError, shortHash } from '../../../support/logger';
import { nodeProcess } from '../../../support/process/runtime-process';
import type { EntityInput, EntityReplica } from '../../types';
import type { EntityRuntimeContext } from '../../runtime-context';
import type { EntityTx } from '../../../types/entity-tx';
import { getPerfMs } from '../../../support/time';
import { countOp } from '../../../support/performance/op-counters';
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

const markRuntimeEntityPhase = (env: EntityRuntimeContext, phase: string): void => {
  if (env.infrastructure) env.infrastructure.runtimeFramePhase = phase;
};

// Perf diagnostics only: explains (input shape, mempool depth) at each proposal
// so batching regressions are visible from one HLT run's log.
const ENTITY_PROPOSAL_TRACE = nodeProcess?.env?.['XLN_ENTITY_PROPOSAL_TRACE'] === '1';

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

type EntityConsensusProfile = Readonly<{
  startedAt: number;
  checkpoints: Record<string, number>;
  checkpoint(label: string): void;
}>;

const createEntityConsensusProfile = (): EntityConsensusProfile => {
  const startedAt = getPerfMs();
  let previousAt = startedAt;
  const checkpoints: Record<string, number> = {};
  return {
    startedAt,
    checkpoints,
    checkpoint(label) {
      const now = getPerfMs();
      checkpoints[label] = Math.round(now - startedAt);
      countOp(`entity.phase.${label}`, 0, Math.round((now - previousAt) * 1_000));
      previousAt = now;
    },
  };
};

const currentEntityInputResult = (context: ApplyEntityInputContext): ApplyEntityInputResult => ({
  outcome: { kind: 'committed' },
  newState: context.workingReplica.state,
  outputs: context.entityOutbox,
  jOutputs: context.jOutbox,
  workingReplica: context.workingReplica,
  candidateEffects: context.candidateEffects,
  storageChanges: context.storageChanges,
  ...(context.canonicalAppliedInput ? { canonicalAppliedInput: context.canonicalAppliedInput } : {}),
  ...(context.entityContext ? { entityContext: context.entityContext } : {}),
});

const traceEntityProposal = (
  context: ApplyEntityInputContext,
  selection: EntityProposalSelection,
  input: EntityInput,
  deferProposal: boolean,
  accountWorkOnly: boolean,
): void => {
  if (!ENTITY_PROPOSAL_TRACE) return;
  entityLog.info('proposal.trace', {
    entity: String(context.workingReplica.entityId || '').slice(-8),
    height: context.workingReplica.state.height,
    mempoolTxs: context.workingReplica.mempool.length,
    selectedTxs: selection.proposalTxs.length,
    inputTxs: input.entityTxs?.length ?? 0,
    inputLanes: Boolean(input.proposedFrame) || Boolean(input.leaderTimeoutVote)
      || (input.hashPrecommits?.size ?? 0) > 0,
    deferred: deferProposal,
    accountWorkOnly,
    singleSigner: selection.isSingleSigner,
  });
};

/**
 * Main entity input processor - handles consensus, proposals, and state transitions
 */
/**
 * Inputs without consensus evidence may wait for the batch flush.
 *
 * A wake-only input (no txs, no lanes) is Runtime-derived work notification,
 * never remote consensus evidence; proposing inline per poke turned a hub's
 * wake churn into one-frame-per-poke (measured: 75% of proposals carried a
 * single tx while the mempool held p50=1). Deferring pokes to the single
 * end-of-batch flush restores one Entity frame per replica per Runtime frame.
 */
export const isProposalDeferrableEntityInput = (input: EntityInput): boolean =>
  !input.proposedFrame &&
  !(input.hashPrecommits && input.hashPrecommits.size > 0) &&
  !input.hashPrecommitFrame &&
  !input.jPrefixAttestations &&
  !input.leaderTimeoutVote;

const requiredAtomicAccountTx = (
  input: EntityInput,
  index: number | undefined,
): EntityTx | undefined => {
  if (index === undefined) return undefined;
  const tx = input.entityTxs?.[index];
  if (tx?.type !== 'accountInput') {
    throw haltRuntimeFailure(
      'RUNTIME_CROSS_J_ATOMIC_ACCOUNT_INPUT_INDEX_INVALID',
      `RUNTIME_CROSS_J_ATOMIC_ACCOUNT_INPUT_INDEX_INVALID:${input.entityId}:${index}:` +
        `${tx?.type ?? 'missing'}`,
    );
  }
  return tx;
};

const shouldDeferEntityProposal = (
  input: EntityInput,
  deferProposal: boolean | undefined,
  trustedLocalCrossJurisdiction: boolean,
  accountWorkOnly: boolean,
): boolean => Boolean(
  deferProposal
  && !trustedLocalCrossJurisdiction
  && !accountWorkOnly
  && isProposalDeferrableEntityInput(input),
);

export const applyEntityInput = async (
  env: EntityRuntimeContext,
  entityReplica: EntityReplica,
  entityInput: EntityInput,
  options: {
    trustedLocalRuntimeProtocol?: 'cross-j' | 'account-work';
    promoteCandidateState?: boolean;
    /** Index of the raw AccountInput required by a Runtime atomic cohort. */
    requiredEntityTxIndex?: number;
    /**
     * Admit the input's transactions into the replica mempool without opening
     * a proposal. The Runtime batch flushes every touched replica once at the
     * end of the frame, so N plain inputs become one Entity frame (R → E → A).
     */
    deferProposal?: boolean;
  } = {},
): Promise<ApplyEntityInputResult> => {
  const profile = createEntityConsensusProfile();
  const trustedLocalCrossJurisdiction = options.trustedLocalRuntimeProtocol === 'cross-j';
  const accountWorkOnly = options.trustedLocalRuntimeProtocol === 'account-work';
  markRuntimeEntityPhase(env, 'apply.entity.ingress');
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
  const requiredEntityTx = requiredAtomicAccountTx(entityInput, options.requiredEntityTxIndex);
  const { entityOutbox, workingReplica } = phaseContext;
  profile.checkpoint('ingress');

  markRuntimeEntityPhase(env, 'apply.entity.leader-vote');
  const leaderVoteResult = await handleLeaderTimeoutVote(phaseContext);
  if (leaderVoteResult) return leaderVoteResult;
  const jPrefixResult = handleJPrefixAttestations(phaseContext);
  if (jPrefixResult) return jPrefixResult;
  markRuntimeEntityPhase(env, 'apply.entity.admission');
  const { localCanPropose, trustedLocalEntityTxs } =
    await admitEntityTransactions(
      phaseContext,
      trustedLocalCrossJurisdiction,
      accountWorkOnly,
    );
  profile.checkpoint('admission');

  markRuntimeEntityPhase(env, 'apply.entity.commit-notification');
  const commitNotificationResult = await handleCommitNotification(phaseContext);
  if (commitNotificationResult) return commitNotificationResult;

  if (shouldDeferEntityProposal(entityInput, options.deferProposal, trustedLocalCrossJurisdiction, accountWorkOnly)) {
    profile.checkpoint('deferred');
    return currentEntityInputResult(phaseContext);
  }

  markRuntimeEntityPhase(env, 'apply.entity.proposal-precommit');
  const proposedFramePrecommitResult = await handleProposedFramePrecommit(phaseContext);
  if (proposedFramePrecommitResult) return proposedFramePrecommitResult;

  markRuntimeEntityPhase(env, 'apply.entity.hash-precommit');
  const hashPrecommitResult = await handleHashPrecommits(phaseContext);
  if (hashPrecommitResult) return hashPrecommitResult;

  if (entityInput.jPrefixAttestations || hasLocalConsensusWork(workingReplica, trustedLocalEntityTxs)) {
    // Commit/proposal notifications above may advance the parent Entity height.
    // Only sign after those terminal paths so this validator never emits a head
    // for a parent that was committed by the same input.
    markRuntimeEntityPhase(env, 'apply.entity.j-prefix');
    ensureLocalJPrefixAttestation(env, workingReplica, entityOutbox, Boolean(entityInput.jPrefixAttestations));
  }

  markRuntimeEntityPhase(env, 'apply.entity.proposal-select');
  const proposalSelection = await selectEntityProposal(env, workingReplica, {
    localCanPropose,
    trustedLocalCrossJurisdiction,
    trustedLocalEntityTxs,
    accountWorkOnly,
    ...(requiredEntityTx ? { requiredEntityTx } : {}),
    checkpoint: profile.checkpoint,
  });
  traceEntityProposal(phaseContext, proposalSelection, entityInput, options.deferProposal === true, accountWorkOnly);
  markRuntimeEntityPhase(env, 'apply.entity.proposal-advance');
  const proposalResult = await advanceEntityProposal(
    phaseContext,
    proposalSelection,
    localCanPropose,
    profile,
  );
  if (proposalResult) return proposalResult;

  if (trustedLocalCrossJurisdiction) {
    throw haltRuntimeFailure("CROSS_J_LOCAL_COMMAND_NOT_FINALIZED", `CROSS_J_LOCAL_COMMAND_NOT_FINALIZED:${workingReplica.entityId}:` +
        `proposal=${workingReplica.proposal?.hash ?? 'none'}:txs=${trustedLocalEntityTxs.length}`);
  }

  return currentEntityInputResult(phaseContext);
};
