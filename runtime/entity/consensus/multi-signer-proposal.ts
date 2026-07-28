import { signAccountFrame } from '../../account/crypto';
import { assertEntityConfigBoardAuthority } from '../../hanko/signing';
import { shortHash, shortId } from '../../infra/logger';
import { assertFrameJPrefix } from '../../jurisdiction/j-prefix-consensus';
import {
  cloneIsolatedEntityLeaderCertificate,
  cloneIsolatedProposedEntityFrame,
} from '../../protocol/runtime-input-clone';
import type {
  EntityReplica,
  Env,
  ProposedEntityFrame,
  ValidatorEntityFrameExecution,
} from '../../types';
import { createEntityFrameHashFromStateRoot } from './frame';
import { applyEntityFrame } from './frame-application';
import {
  buildEntityHashesToSign,
  getEntityHashManifestMismatch,
} from './hanko-witness';
import type { ApplyEntityInputContext } from './input-types';
import { getReplicaProposalLeader } from './leader';
import { buildCertifiedEntityOutputHashes } from './output-certification';
import type { EntityProposalSelection } from './proposal-selection';
import {
  assertFrameParentMatchesState,
  assertProposerJRangesMatchLocalHistory,
  entityLog,
  expectedCommittedLeaderState,
  getPrevFrameHash,
  getReplicaJRangeValidationError,
} from './shared';
import {
  buildEntityFrameAuthority,
  computeCanonicalEntityConsensusStateHash,
  computeEntityFrameAuthorityRoot,
} from './state-root';

const replayPreparedFrameForRelay = async (
  env: Env,
  replica: EntityReplica,
  frame: ProposedEntityFrame,
): Promise<ValidatorEntityFrameExecution> => {
  assertFrameParentMatchesState(replica.state, frame, 'ENTITY_PREPARED_PARENT_MISMATCH');
  const jRangeError = getReplicaJRangeValidationError(env, replica, frame.txs);
  if (jRangeError) throw new Error(`ENTITY_PREPARED_J_RANGE_MISMATCH:${jRangeError}`);
  assertFrameJPrefix(env, replica, frame);
  const applied = await applyEntityFrame(env, replica.state, frame.txs, frame.timestamp);
  const state = {
    ...applied.newState,
    entityId: replica.state.entityId,
    height: frame.height,
    timestamp: frame.timestamp,
    leaderState: expectedCommittedLeaderState(replica.state, frame),
  };
  const stateRoot = computeCanonicalEntityConsensusStateHash(state);
  if (stateRoot !== frame.stateRoot) {
    throw new Error(
      `ENTITY_PREPARED_STATE_ROOT_MISMATCH:expected=${stateRoot}:received=${frame.stateRoot}`,
    );
  }
  const authorityRoot = computeEntityFrameAuthorityRoot(buildEntityFrameAuthority(state));
  if (authorityRoot !== frame.authorityRoot) {
    throw new Error(
      `ENTITY_PREPARED_AUTHORITY_ROOT_MISMATCH:expected=${authorityRoot}:received=${frame.authorityRoot}`,
    );
  }
  const replayedHash = createEntityFrameHashFromStateRoot(
    getPrevFrameHash(replica.state),
    frame.height,
    frame.timestamp,
    frame.txs,
    state.entityId,
    stateRoot,
    authorityRoot,
    frame.jPrefixCertificate,
  );
  if (replayedHash !== frame.hash) {
    throw new Error(
      `ENTITY_PREPARED_FRAME_HASH_MISMATCH:expected=${replayedHash}:received=${frame.hash}`,
    );
  }
  const outputHashes = buildCertifiedEntityOutputHashes(
    state,
    env,
    frame.height,
    replayedHash,
    applied.outputs,
  );
  const hashesToSign = buildEntityHashesToSign(
    replica.entityId,
    frame.height,
    replayedHash,
    [...(applied.collectedHashes ?? []), ...outputHashes],
  );
  const mismatch = getEntityHashManifestMismatch(hashesToSign, frame.hashesToSign);
  if (mismatch) throw new Error(`ENTITY_PREPARED_MANIFEST_MISMATCH:${mismatch}`);
  return {
    frameHash: frame.hash,
    height: frame.height,
    state,
    outputs: applied.outputs,
    jOutputs: applied.jOutputs,
    hashesToSign,
    candidateEffects: applied.candidateEffects,
    storageChanges: applied.storageChanges,
    ...(applied.consumptionNodeChanges
      ? { consumptionNodeChanges: applied.consumptionNodeChanges }
      : {}),
    ...(applied.accountJClaimNodeChanges
      ? { accountJClaimNodeChanges: applied.accountJClaimNodeChanges }
      : {}),
  };
};

export const relayPreparedFrameIfReady = async (
  context: ApplyEntityInputContext,
  localCanPropose: boolean,
  isSingleSigner: boolean,
): Promise<void> => {
  const { env, entityInput, entityOutbox, workingReplica } = context;
  const certificate = workingReplica.pendingLeaderCertificate;
  if (
    isSingleSigner ||
    !localCanPropose ||
    workingReplica.proposal ||
    certificate?.targetHeight !== workingReplica.state.height + 1 ||
    !certificate.preparedFrameHash
  ) return;

  const preparedFrame = workingReplica.lockedFrame;
  if (!preparedFrame || preparedFrame.hash !== certificate.preparedFrameHash) {
    throw new Error(
      `ENTITY_PREPARED_RELAY_FRAME_MISSING:expected=${certificate.preparedFrameHash}:` +
        `actual=${preparedFrame?.hash ?? 'none'}`,
    );
  }
  workingReplica.validatorExecution = await replayPreparedFrameForRelay(
    env,
    workingReplica,
    preparedFrame,
  );
  workingReplica.proposal = cloneIsolatedProposedEntityFrame(preparedFrame);
  workingReplica.proposal.leader.relayCertificate =
    cloneIsolatedEntityLeaderCertificate(certificate);
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
    view: certificate.toView,
  });
};

const shouldStartProposal = (
  replica: EntityReplica,
  selection: EntityProposalSelection,
  localCanPropose: boolean,
): boolean => {
  const certifiedLeaderTransition = Boolean(
    replica.pendingLeaderCertificate &&
    replica.pendingLeaderCertificate.targetHeight === replica.state.height + 1 &&
    !replica.pendingLeaderCertificate.preparedFrameHash,
  );
  return (
    !selection.isSingleSigner &&
    localCanPropose &&
    (selection.proposalTxs.length > 0 ||
      selection.shouldRollFrozenBaseJPrefixRound ||
      (selection.proposalSelection.currentAuthorityReady &&
        (selection.hasProposableAccountMempool || certifiedLeaderTransition))) &&
    !replica.proposal &&
    !replica.lockedFrame
  );
};

const buildMultiSignerProposal = async (
  context: ApplyEntityInputContext,
  selection: EntityProposalSelection,
): Promise<ProposedEntityFrame> => {
  const { env, workingReplica } = context;
  const { proposalJPrefixCertificate, proposalTxs } = selection;
  const leader = getReplicaProposalLeader(workingReplica);
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
  const applied = await applyEntityFrame(
    env,
    workingReplica.state,
    proposalTxs,
    env.timestamp,
  );
  const height = workingReplica.state.height + 1;
  const state = {
    ...applied.newState,
    entityId: workingReplica.state.entityId,
    height,
    timestamp: env.timestamp,
    leaderState: {
      activeValidatorId: workingReplica.signerId.toLowerCase(),
      view: leader.view,
      changedAtHeight: workingReplica.pendingLeaderCertificate
        ? height
        : (workingReplica.state.leaderState?.changedAtHeight ?? 0),
    },
  };
  const parentFrameHash = getPrevFrameHash(workingReplica.state);
  const stateRoot = computeCanonicalEntityConsensusStateHash(state);
  const authorityRoot = computeEntityFrameAuthorityRoot(buildEntityFrameAuthority(state));
  const frameHash = createEntityFrameHashFromStateRoot(
    parentFrameHash,
    height,
    env.timestamp,
    proposalTxs,
    state.entityId,
    stateRoot,
    authorityRoot,
    proposalJPrefixCertificate ?? undefined,
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
  await assertEntityConfigBoardAuthority(
    env,
    workingReplica.state.entityId,
    workingReplica.state.config,
    state,
  );
  const selfSigs = await Promise.all(
    hashesToSign.map(hash =>
      signAccountFrame(env, workingReplica.signerId, hash.hash)),
  );
  workingReplica.validatorExecution = {
    frameHash,
    height,
    state,
    outputs: applied.outputs,
    jOutputs: applied.jOutputs,
    hashesToSign,
    candidateEffects: applied.candidateEffects,
    storageChanges: applied.storageChanges,
    ...(applied.consumptionNodeChanges
      ? { consumptionNodeChanges: applied.consumptionNodeChanges }
      : {}),
    ...(applied.accountJClaimNodeChanges
      ? { accountJClaimNodeChanges: applied.accountJClaimNodeChanges }
      : {}),
  };
  return {
    height,
    parentFrameHash,
    stateRoot,
    authorityRoot,
    txs: [...proposalTxs],
    hash: frameHash,
    timestamp: env.timestamp,
    leader: {
      proposerSignerId: workingReplica.signerId.toLowerCase(),
      view: leader.view,
      ...(workingReplica.pendingLeaderCertificate
        ? { certificate: workingReplica.pendingLeaderCertificate }
        : {}),
    },
    ...(proposalJPrefixCertificate
      ? { jPrefixCertificate: structuredClone(proposalJPrefixCertificate) }
      : {}),
    hashesToSign,
    collectedSigs: new Map([[workingReplica.signerId, selfSigs]]),
  };
};

export const startMultiSignerProposalIfReady = async (
  context: ApplyEntityInputContext,
  selection: EntityProposalSelection,
  localCanPropose: boolean,
): Promise<void> => {
  if (!shouldStartProposal(context.workingReplica, selection, localCanPropose)) return;
  entityLog.debug('proposal.auto_start', {
    mempool: selection.proposalTxs.length,
    txs: selection.proposalTxs.map(tx => tx.type),
  });
  const proposal = await buildMultiSignerProposal(context, selection);
  context.workingReplica.proposal = proposal;
  entityLog.debug('proposal.created', {
    frame: shortHash(proposal.hash),
    txs: proposal.txs.length,
    hashes: proposal.hashesToSign?.length ?? 0,
  });
  for (const validatorId of context.workingReplica.state.config.validators) {
    if (validatorId === context.workingReplica.signerId) continue;
    context.entityOutbox.push({
      entityId: context.entityInput.entityId,
      signerId: validatorId,
      proposedFrame: proposal,
    });
  }
};
