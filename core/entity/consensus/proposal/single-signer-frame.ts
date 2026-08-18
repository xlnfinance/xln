import { signAccountFrame } from '../../../account/crypto';
import { signEntityHashes } from '../../../hanko/signing';
import { cumulativeMarksToPhases } from '../../../support/performance/profile';
import { assertFrameJPrefix } from '../../../jurisdiction/machine/history/j-prefix-consensus';
import { removeCommittedTxsFromMempool } from '../../../protocol/state/tx-multiset';
import type { EntityFrame } from '../../types';
import { getPerfMs } from '../../../support/time';
import { commitEntityFrameCandidateState } from '../../state-clone';
import { emitCommittedPendingFrameWarnings } from '../../scheduler';
import { createEntityFrameHashFromStateRoot } from '../frame';
import { markEntityFrameBodyVerified } from '../frame/body-verified';
import {
  applyEntityFrame,
  applyRuntimeOwnedEntityFrame,
} from '../frame/application';
import {
  attachHankoWitnessToOutputs,
  buildEntityHashesToSign,
  isWitnessHashType,
  pruneHankoWitnessToReachableState,
  sealHankoWitnessInState,
  type HankoWitnessEntry,
} from '../input/hanko-witness';
import { touchedAccountIdsForHankoSeal } from '../account/touched-accounts';
import {
  commitEntityConsensusInput,
  type ApplyEntityInputContext,
  type ApplyEntityInputResult,
} from '../input/types';
import { getEntityLeaderState } from '../leader';
import { buildCertifiedEntityOutputHashes } from '../output/certification';
import {
  shouldKeepPreparedEntityFrame,
  type EntityProposalSelection,
} from './selection';
import {
  entityFrameProfileEnabled,
  entityFrameSlowMs,
} from '../frame/profile';
import { entityLog } from '../entity-log';
import { shortId } from '../../../support/logger';
import { MalformedEntityFrameInputError } from '../../tx/processing/invariant-errors';
import type { EntityTx } from '../../../types/entity-tx';
import {
  emitCommittedEntitySizeLog,
  prepareCommittedEntitySizeLog,
} from '../state-quota';
import {
  assertProposerJRangesMatchLocalHistory,
  pruneReplicaFinalizedJHistory,
  runLocalPostCommitHooks,
} from '../j-prefix/prefix-round';
import { wrapCertifiedEntityOutputs } from '../output/consumption';
import {
  appendCertifiedEntityFrameLink,
  buildCertifiedEntityFrameLink,
  getPrevFrameHash,
} from '../frame/lineage';
import {
  buildEntityFrameAuthority,
  computeCanonicalEntityConsensusStateHash,
  computeEntityFrameAuthorityRoot,
} from '../state-root';
import { materializeEntityInfraContext } from './infra-context';
import { validateProposedEntityFrame } from '../frame/validation';
import { assertHtlcPreparedInfraContext } from '../../htlc/materialize-context';
import { requireEntityEncryptionPrivateKey } from '../../auth/crypto';
import {
  getBoardHandoverFrameConfig,
  getBoardHandoverLeaderState,
  getEntityFrameConsensusConfig,
  withBoardAuthority,
} from '../authority/board-handover';

export type SingleSignerFrameOptions = Pick<
  EntityProposalSelection,
  | 'accountWorkOnly'
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
  entityContext: import('../../../types/entity/infra-context').EntityInfraContext,
) => {
  const { env, workingReplica } = context;
  const leader = getBoardHandoverLeaderState(
    env,
    workingReplica.state,
    options.proposalTxs,
  ) ?? getEntityLeaderState(workingReplica.state);
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
    entityContext,
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

const applySingleSignerProposal = async (
  context: ApplyEntityInputContext,
  options: SingleSignerFrameOptions,
) => {
  const { env, workingReplica } = context;
  const { proposalJPrefixCertificate, proposalTxs } = options;
  const authorityConfig = getEntityFrameConsensusConfig(env, workingReplica.state, proposalTxs);
  const authorityReplica = authorityConfig === workingReplica.state.config
    ? workingReplica
    : { ...workingReplica, state: withBoardAuthority(workingReplica.state, authorityConfig) };
  const leader = getEntityLeaderState(authorityReplica.state);
  assertProposerJRangesMatchLocalHistory(env, workingReplica, proposalTxs);
  assertFrameJPrefix(env, authorityReplica, {
    height: workingReplica.state.height + 1,
    parentFrameHash: getPrevFrameHash(workingReplica.state),
    leader: { proposerSignerId: workingReplica.signerId.toLowerCase(), view: leader.view },
    txs: proposalTxs,
    ...(proposalJPrefixCertificate ? { jPrefixCertificate: proposalJPrefixCertificate } : {}),
  });
  const entityContext = await materializeEntityInfraContext(env, workingReplica, proposalTxs, {
    usePersistedReplayContext: context.usePersistedReplayContext,
  });
  await assertHtlcPreparedInfraContext({
    state: workingReplica.state,
    proposalTxs,
    context: entityContext,
    entityEncryptionPrivateKey: requireEntityEncryptionPrivateKey(env, workingReplica.entityId),
  });
  const applyFrame = context.promoteCandidateState ? applyRuntimeOwnedEntityFrame : applyEntityFrame;
  const applied = await applyFrame(env, workingReplica.state, entityContext, proposalTxs, env.state.timestamp);
  options.checkpoint('frameApply');
  return { applied, entityContext };
};

const buildSingleSignerFrame = async (
  context: ApplyEntityInputContext,
  options: SingleSignerFrameOptions,
) => {
  const { env, workingReplica } = context;
  const { proposalJPrefixCertificate, proposalTxs } = options;
  const { applied, entityContext } = await applySingleSignerProposal(context, options);
  if (!shouldKeepPreparedEntityFrame(options, applied.accountsToProposeFramesCount)) {
    return null;
  }
  const commitments = buildSingleSignerCommitments(context, options, applied, entityContext);
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
    entityContext,
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
  validateProposedEntityFrame(frame, 'SingleSignerEntityFrame');
  markEntityFrameBodyVerified(frame);
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
  execution: NonNullable<Awaited<ReturnType<typeof buildSingleSignerFrame>>>,
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
  const sealed = sealHankoWitnessInState(
    state,
    witnesses,
    frame.height,
    touchedAccountIdsForHankoSeal(
      state,
      execution.proposableAccounts,
      execution.storageChanges,
    ),
  );
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
  execution: NonNullable<Awaited<ReturnType<typeof buildSingleSignerFrame>>>,
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
  const handoverConfig = getBoardHandoverFrameConfig(
    env,
    priorState,
    options.proposalTxs,
  );
  emitCommittedPendingFrameWarnings(priorState, committedState);
  if (context.promoteCandidateState) {
    commitEntityFrameCandidateState(committedState, execution.frame.stateRoot);
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
  if (handoverConfig) {
    // Retired validators remain full-state observers. Deliver the certified
    // transition to every old board member so their replica advances to the
    // same post-handover state, but never gives them authority over H+1.
    for (const validatorId of priorState.config.validators) {
      if (validatorId.toLowerCase() === workingReplica.signerId.toLowerCase()) continue;
      entityOutbox.push({
        entityId: workingReplica.entityId,
        signerId: validatorId,
        proposedFrame: execution.frame,
      });
    }
  }
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

/**
 * A single signer proposes straight from its mempool. One rejected mempool tx
 * (a peer's invalid certified output, a stale command) must not poison every
 * other user's transaction batched into the same frame: evict exactly that
 * frame tx from the proposal and the mempool, then rebuild. Invariant failures
 * keep propagating; only `reject`-disposition frame rejections are evicted.
 */
const buildSingleSignerFrameEvictingRejected = async (
  context: ApplyEntityInputContext,
  options: SingleSignerFrameOptions,
): Promise<Awaited<ReturnType<typeof buildSingleSignerFrame>>> => {
  let attempt = options;
  for (let round = 0; round <= options.proposalTxs.length; round += 1) {
    try {
      return await buildSingleSignerFrame(context, attempt);
    } catch (error) {
      if (!(error instanceof MalformedEntityFrameInputError) || error.frameTx === undefined) throw error;
      const rejectedTx = error.frameTx;
      const inProposal = attempt.proposalTxs.includes(rejectedTx as EntityTx);
      const inMempool = context.workingReplica.mempool.includes(rejectedTx as EntityTx);
      if (!inProposal || !inMempool || attempt.proposalTxs.length === 1) throw error;
      entityLog.warn('single_signer.tx_evicted', {
        entity: shortId(context.workingReplica.entityId),
        txType: error.txType,
        rejection: error.rejection,
        remaining: attempt.proposalTxs.length - 1,
      });
      context.workingReplica.mempool = context.workingReplica.mempool.filter(tx => tx !== rejectedTx);
      attempt = { ...attempt, proposalTxs: attempt.proposalTxs.filter(tx => tx !== rejectedTx) };
    }
  }
  throw new Error('SINGLE_SIGNER_EVICTION_LOOP_EXHAUSTED');
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
  const execution = await buildSingleSignerFrameEvictingRejected(context, options);
  if (!execution) return null;
  context.entityContext = execution.frame.entityContext;
  attachSingleSignerHankos(context, execution);
  await installSingleSignerFrame(context, options, execution);
  options.checkpoint('commit');
  logSingleSignerProfile(context, options);
  return commitEntityConsensusInput(context);
};
