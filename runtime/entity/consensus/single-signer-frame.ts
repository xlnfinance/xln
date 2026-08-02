import { signAccountFrame } from '../../account/crypto';
import { signEntityHashes } from '../../hanko/signing';
import { cumulativeMarksToPhases } from '../../infra/perf-profile';
import { assertFrameJPrefix } from '../../jurisdiction/machine/j-prefix-consensus';
import { removeCommittedTxsFromMempool } from '../../protocol/tx-multiset';
import type { EntityFrame } from '../types';
import { getPerfMs } from '../../infra/time';
import { commitEntityFrameCandidateState } from '../state-clone';
import { emitCommittedPendingFrameWarnings } from '../scheduler';
import { createEntityFrameHashFromStateRoot } from './frame';
import {
  applyEntityFrame,
  applyRuntimeOwnedEntityFrame,
} from './frame-application';
import {
  attachHankoWitnessToOutputs,
  buildEntityHashesToSign,
  isWitnessHashType,
  pruneHankoWitnessToReachableState,
  sealHankoWitnessInState,
  type HankoWitnessEntry,
} from './hanko-witness';
import {
  commitEntityConsensusInput,
  type ApplyEntityInputContext,
  type ApplyEntityInputResult,
} from './input-types';
import { getEntityLeaderState } from './leader';
import { buildCertifiedEntityOutputHashes } from './output-certification';
import type { EntityProposalSelection } from './proposal-selection';
import {
  entityFrameProfileEnabled,
  entityFrameSlowMs,
} from './frame-profile';
import { entityLog } from './entity-log';
import {
  emitCommittedEntitySizeLog,
  prepareCommittedEntitySizeLog,
} from './state-size-observation';
import {
  assertProposerJRangesMatchLocalHistory,
  pruneReplicaFinalizedJHistory,
  runLocalPostCommitHooks,
} from './j-prefix-round';
import { wrapCertifiedEntityOutputs } from './consumption-output';
import {
  appendCertifiedEntityFrameLink,
  buildCertifiedEntityFrameLink,
  getPrevFrameHash,
} from './frame-lineage';
import {
  buildEntityFrameAuthority,
  computeCanonicalEntityConsensusStateHash,
  computeEntityFrameAuthorityRoot,
} from './state-root';

export type SingleSignerFrameOptions = Pick<
  EntityProposalSelection,
  | 'hasProposableAccountMempool'
  | 'proposalJPrefixCertificate'
  | 'proposalSelection'
  | 'proposalTxs'
  | 'shouldRollFrozenBaseJPrefixRound'
> & {
  localCanPropose: boolean;
  profileStartedAt: number;
  profileCheckpoints: Record<string, number>;
  checkpoint(label: string): void;
};

const buildSingleSignerCommitments = (
  context: ApplyEntityInputContext,
  options: SingleSignerFrameOptions,
  applied: Awaited<ReturnType<typeof applyEntityFrame>>,
) => {
  const { env, workingReplica } = context;
  const leader = getEntityLeaderState(workingReplica.state);
  const height = workingReplica.state.height + 1;
  const timestamp = env.state.timestamp;
  const parentFrameHash = getPrevFrameHash(workingReplica.state);
  const state = {
    ...applied.newState,
    entityId: workingReplica.state.entityId,
    height,
    timestamp,
    leaderState: leader,
  };
  const stateRoot = computeCanonicalEntityConsensusStateHash(state);
  const authority = buildEntityFrameAuthority(state);
  const authorityRoot = computeEntityFrameAuthorityRoot(authority);
  const frameHash = createEntityFrameHashFromStateRoot(
    parentFrameHash,
    height,
    timestamp,
    options.proposalTxs,
    applied.events,
    state.entityId,
    stateRoot,
    authorityRoot,
    options.proposalJPrefixCertificate ?? undefined,
  );
  const outputHashes = buildCertifiedEntityOutputHashes(
    state,
    env,
    height,
    frameHash,
    applied.outputs,
  );
  const hashesToSign = buildEntityHashesToSign(
    workingReplica.state.entityId,
    height,
    frameHash,
    [...(applied.collectedHashes ?? []), ...outputHashes],
  );
  return {
    authority,
    authorityRoot,
    frameHash,
    hashesToSign,
    height,
    leader,
    parentFrameHash,
    state,
    stateRoot,
    timestamp,
  };
};

const buildSingleSignerFrame = async (
  context: ApplyEntityInputContext,
  options: SingleSignerFrameOptions,
) => {
  const { env, workingReplica } = context;
  const { proposalJPrefixCertificate, proposalTxs } = options;
  const leader = getEntityLeaderState(workingReplica.state);
  assertProposerJRangesMatchLocalHistory(env, workingReplica, proposalTxs);
  assertFrameJPrefix(env, workingReplica, {
    height: workingReplica.state.height + 1,
    parentFrameHash: getPrevFrameHash(workingReplica.state),
    leader: {
      proposerSignerId: workingReplica.signerId.toLowerCase(),
      view: leader.view,
    },
    txs: proposalTxs,
    ...(proposalJPrefixCertificate
      ? { jPrefixCertificate: proposalJPrefixCertificate }
      : {}),
  });
  const applyFrame = context.promoteCandidateState
    ? applyRuntimeOwnedEntityFrame
    : applyEntityFrame;
  const applied = await applyFrame(
    env,
    workingReplica.state,
    proposalTxs,
    env.state.timestamp,
  );
  options.checkpoint('frameApply');
  const commitments = buildSingleSignerCommitments(context, options, applied);
  options.checkpoint('commitments');
  const hankos = await signEntityHashes(
    env,
    workingReplica.state.entityId,
    workingReplica.signerId,
    commitments.hashesToSign.map(hashInfo => hashInfo.hash),
    commitments.state,
  );
  const signatures = await Promise.all(
    commitments.hashesToSign.map(hashInfo =>
      signAccountFrame(env, workingReplica.signerId, hashInfo.hash)),
  );
  options.checkpoint('signatures');
  const frame: EntityFrame = {
    height: commitments.height,
    parentFrameHash: commitments.parentFrameHash,
    stateRoot: commitments.stateRoot,
    authorityRoot: commitments.authorityRoot,
    timestamp: commitments.timestamp,
    txs: [...proposalTxs],
    events: structuredClone(applied.events),
    hash: commitments.frameHash,
    leader: {
      proposerSignerId: workingReplica.signerId.toLowerCase(),
      view: commitments.leader.view,
    },
    ...(proposalJPrefixCertificate
      ? { jPrefixCertificate: structuredClone(proposalJPrefixCertificate) }
      : {}),
    hashesToSign: commitments.hashesToSign,
    collectedSigs: new Map([
      [workingReplica.signerId.toLowerCase(), signatures],
    ]),
    hankos,
  };
  return {
    ...applied,
    authority: commitments.authority,
    frame,
    hankos,
    hashesToSign: commitments.hashesToSign,
    state: commitments.state,
  };
};

const attachSingleSignerHankos = (
  context: ApplyEntityInputContext,
  execution: Awaited<ReturnType<typeof buildSingleSignerFrame>>,
): void => {
  const { workingReplica } = context;
  const { frame, hashesToSign, hankos, state } = execution;
  workingReplica.hankoWitness ??= new Map();
  for (let index = 0; index < hashesToSign.length; index += 1) {
    const hashInfo = hashesToSign[index];
    const hanko = hankos[index];
    if (!hashInfo || !hanko || !isWitnessHashType(hashInfo.type)) continue;
    workingReplica.hankoWitness.set(hashInfo.hash, {
      hanko,
      type: hashInfo.type,
      entityHeight: frame.height,
      createdAt: frame.timestamp,
    });
  }
  const witnesses = workingReplica.hankoWitness as Map<string, HankoWitnessEntry>;
  const sealed = sealHankoWitnessInState(state, witnesses, frame.height);
  const attached = attachHankoWitnessToOutputs(
    execution.outputs,
    execution.jOutputs,
    witnesses,
    frame.height,
    state,
  );
  pruneHankoWitnessToReachableState(state, witnesses);
  if (attached > 0 || sealed > 0) {
    entityLog.debug('single_signer.hankos_attached', {
      count: attached,
      stateCount: sealed,
    });
  }
};

const installSingleSignerFrame = async (
  context: ApplyEntityInputContext,
  options: SingleSignerFrameOptions,
  execution: Awaited<ReturnType<typeof buildSingleSignerFrame>>,
): Promise<void> => {
  const {
    env,
    entityOutbox,
    jOutbox,
    workingReplica,
    candidateEffects,
    storageChanges,
  } = context;
  const committedState = {
    ...execution.state,
    prevFrameHash: execution.frame.hash,
  };
  const sizeLog = prepareCommittedEntitySizeLog(
    env,
    workingReplica.state,
    committedState,
  );
  const commitOutputs = wrapCertifiedEntityOutputs(
    execution.outputs,
    execution.frame,
    execution.state,
    env,
    execution.hashesToSign,
    execution.hankos,
    true,
  );
  context.consumptionNodeChanges = execution.consumptionNodeChanges;
  context.accountJClaimNodeChanges = execution.accountJClaimNodeChanges;
  const priorState = workingReplica.state;
  emitCommittedPendingFrameWarnings(priorState, committedState);
  if (context.promoteCandidateState) {
    commitEntityFrameCandidateState(committedState);
  }
  workingReplica.state = committedState;
  storageChanges.push(
    ...execution.storageChanges,
    { family: 'entity', entityId: committedState.entityId },
  );
  emitCommittedEntitySizeLog(sizeLog);
  appendCertifiedEntityFrameLink(
    workingReplica,
    buildCertifiedEntityFrameLink(
      workingReplica.state.entityId,
      execution.frame,
      workingReplica.state,
      {
        stateRoot: execution.frame.stateRoot,
        authority: execution.authority,
      },
    ),
    candidateEffects,
  );
  candidateEffects.push(...execution.candidateEffects);
  pruneReplicaFinalizedJHistory(workingReplica);
  await runLocalPostCommitHooks(env, workingReplica, entityOutbox);
  workingReplica.lastConsensusProgressAt = env.state.timestamp;
  entityOutbox.push(...commitOutputs);
  jOutbox.push(...execution.jOutputs);
  workingReplica.mempool = removeCommittedTxsFromMempool(
    workingReplica.mempool,
    options.proposalTxs,
  );
};

const logSingleSignerProfile = (
  context: ApplyEntityInputContext,
  options: SingleSignerFrameOptions,
): void => {
  const elapsedMs = Math.round(getPerfMs() - options.profileStartedAt);
  if (!entityFrameProfileEnabled() && elapsedMs < entityFrameSlowMs()) return;
  entityLog.info('single_signer.profile', {
    entity: String(context.workingReplica.entityId || '').slice(-8),
    elapsedMs,
    txs: options.proposalTxs.length,
    outputs: context.entityOutbox.length,
    jOutputs: context.jOutbox.length,
    phases: cumulativeMarksToPhases(options.profileCheckpoints, elapsedMs),
  });
};

export const commitSingleSignerFrameIfReady = async (
  context: ApplyEntityInputContext,
  options: SingleSignerFrameOptions,
): Promise<ApplyEntityInputResult | null> => {
  const ready =
    options.localCanPropose &&
    (options.proposalTxs.length > 0 ||
      options.shouldRollFrozenBaseJPrefixRound ||
      (options.proposalSelection.currentAuthorityReady &&
        options.hasProposableAccountMempool)) &&
    !context.workingReplica.proposal;
  if (!ready) return null;

  entityLog.debug('single_signer.execute', {
    txs: options.proposalTxs.map(tx => tx.type),
  });
  const execution = await buildSingleSignerFrame(context, options);
  attachSingleSignerHankos(context, execution);
  await installSingleSignerFrame(context, options, execution);
  options.checkpoint('commit');
  logSingleSignerProfile(context, options);
  return commitEntityConsensusInput(context);
};
