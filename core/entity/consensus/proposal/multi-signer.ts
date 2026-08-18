import { signAccountFrame } from '../../../account/crypto';
import { assertEntityConfigBoardAuthority } from '../../../hanko/signing';
import { shortHash, shortId } from '../../../support/logger';
import { assertFrameJPrefix } from '../../../jurisdiction/machine/history/j-prefix-consensus';
import {
  cloneIsolatedEntityLeaderCertificate,
  cloneIsolatedProposedEntityFrame,
} from '../../state/input-clone';
import type { EntityReplica, EntityState, EntityFrame, EntityCandidate } from '../../types';
import type { EntityRuntimeContext } from '../../runtime-context';
import { createEntityFrameHashFromStateRoot, entityFrameEventsEqual } from '../frame';
import { markEntityFrameBodyVerified } from '../frame/body-verified';
import { applyEntityFrame } from '../frame/application';
import { copyProposableAccounts } from '../account/touched-accounts';
import {
  buildEntityHashesToSign,
  getEntityHashManifestMismatch,
} from '../input/hanko-witness';
import type { ApplyEntityInputContext } from '../input/types';
import { getReplicaProposalLeader } from '../leader';
import { buildCertifiedEntityOutputHashes } from '../output/certification';
import {
  shouldKeepPreparedEntityFrame,
  type EntityProposalSelection,
} from './selection';
import {
  expectedCommittedLeaderState,
} from '../leader/certificates';
import { entityLog } from '../entity-log';
import {
  assertProposerJRangesMatchLocalHistory,
  getReplicaJRangeValidationError,
} from '../j-prefix/prefix-round';
import {
  assertFrameParentMatchesState,
  getPrevFrameHash,
} from '../frame/lineage';
import {
  buildEntityFrameAuthority,
  computeCanonicalEntityConsensusStateHash,
  computeEntityFrameAuthorityRoot,
} from '../state-root';
import { fitEntityProposalToWireBudget } from './wire-budget';
import { validateProposedEntityFrame } from '../frame/validation';
import { assertHtlcPreparedInfraContext } from '../../htlc/materialize-context';
import { requireEntityEncryptionPrivateKey } from '../../auth/crypto';
import { assertEntityInfraContextAuthority } from '../frame/infra-context-validation';
import {
  getBoardHandoverLeaderState,
  getEntityFrameConsensusConfig,
  withBoardAuthority,
} from '../authority/board-handover';

const replayPreparedFrameForRelay = async (
  env: EntityRuntimeContext,
  replica: EntityReplica,
  frame: EntityFrame,
): Promise<EntityCandidate> => {
  assertFrameParentMatchesState(replica.state, frame, 'ENTITY_PREPARED_PARENT_MISMATCH');
  const jRangeError = getReplicaJRangeValidationError(env, replica, frame.txs);
  if (jRangeError) throw new Error(`ENTITY_PREPARED_J_RANGE_MISMATCH:${jRangeError}`);
  assertFrameJPrefix(env, replica, frame);
  await assertEntityInfraContextAuthority(env, frame.entityContext, replica.state);
  await assertHtlcPreparedInfraContext({
    state: replica.state,
    proposalTxs: frame.txs,
    context: frame.entityContext,
    entityEncryptionPrivateKey: requireEntityEncryptionPrivateKey(env, replica.entityId),
  });
  const applied = await applyEntityFrame(env, replica.state, frame.entityContext, frame.txs, frame.timestamp);
  if (!entityFrameEventsEqual(applied.events, frame.events)) {
    throw new Error('ENTITY_PREPARED_EVENTS_MISMATCH');
  }
  const state = {
    ...applied.newState,
    entityId: replica.state.entityId,
    height: frame.height,
    timestamp: frame.timestamp,
    leaderState:
      getBoardHandoverLeaderState(env, replica.state, frame.txs) ??
      expectedCommittedLeaderState(replica.state, frame),
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
    frame.events,
    state.entityId,
    stateRoot,
    authorityRoot,
    frame.entityContext,
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
    proposableAccounts: copyProposableAccounts(applied.proposableAccounts),
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
  workingReplica.candidate = await replayPreparedFrameForRelay(
    env,
    workingReplica,
    preparedFrame,
  );
  workingReplica.proposal = cloneIsolatedProposedEntityFrame(preparedFrame);
  workingReplica.proposal.leader.relayCertificate =
    cloneIsolatedEntityLeaderCertificate(certificate);
  for (const validatorId of workingReplica.candidate.state.config.validators) {
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

const buildProposalState = (
  env: EntityRuntimeContext,
  replica: EntityReplica,
  appliedState: EntityState,
  txs: readonly import('../../../types/entity-tx').EntityTx[],
  height: number,
  timestamp: number,
  view: number,
): EntityState => {
  const handoverLeader = getBoardHandoverLeaderState(env, replica.state, txs);
  return {
    ...appliedState,
    entityId: replica.state.entityId,
    height,
    timestamp,
    leaderState: handoverLeader ?? {
      activeValidatorId: replica.signerId.toLowerCase(),
      view,
      changedAtHeight: replica.pendingLeaderCertificate
        ? height
        : (replica.state.leaderState?.changedAtHeight ?? 0),
    },
  };
};

const signProposalManifest = async (
  env: EntityRuntimeContext,
  replica: EntityReplica,
  state: EntityState,
  hashesToSign: ReturnType<typeof buildEntityHashesToSign>,
): Promise<string[]> => {
  await assertEntityConfigBoardAuthority(
    env,
    replica.state.entityId,
    state.config,
    state,
  );
  return Promise.all(
    hashesToSign.map(hash => signAccountFrame(env, replica.signerId, hash.hash)),
  );
};

const assertMultiSignerProposalPrefix = (
  env: EntityRuntimeContext,
  replica: EntityReplica,
  selection: EntityProposalSelection,
  view: number,
): void => {
  const { proposalJPrefixCertificate, proposalTxs } = selection;
  assertProposerJRangesMatchLocalHistory(env, replica, proposalTxs);
  assertFrameJPrefix(env, replica, {
    height: replica.state.height + 1,
    parentFrameHash: getPrevFrameHash(replica.state),
    leader: { proposerSignerId: replica.signerId.toLowerCase(), view },
    txs: proposalTxs,
    ...(proposalJPrefixCertificate ? { jPrefixCertificate: proposalJPrefixCertificate } : {}),
  });
};

const storeMultiSignerCandidate = (
  replica: EntityReplica,
  applied: Awaited<ReturnType<typeof applyEntityFrame>>,
  state: EntityState,
  frameHash: string,
  hashesToSign: ReturnType<typeof buildEntityHashesToSign>,
): void => {
  replica.candidate = {
    frameHash,
    height: state.height,
    state,
    outputs: applied.outputs,
    jOutputs: applied.jOutputs,
    hashesToSign,
    candidateEffects: applied.candidateEffects,
    storageChanges: applied.storageChanges,
    proposableAccounts: copyProposableAccounts(applied.proposableAccounts),
    ...(applied.consumptionNodeChanges ? { consumptionNodeChanges: applied.consumptionNodeChanges } : {}),
    ...(applied.accountJClaimNodeChanges ? { accountJClaimNodeChanges: applied.accountJClaimNodeChanges } : {}),
  };
};

const assembleMultiSignerFrame = (
  replica: EntityReplica,
  selection: EntityProposalSelection,
  applied: Awaited<ReturnType<typeof applyEntityFrame>>,
  state: EntityState,
  entityContext: EntityFrame['entityContext'],
  frameHash: string,
  stateRoot: string,
  authorityRoot: string,
  hashesToSign: ReturnType<typeof buildEntityHashesToSign>,
  selfSigs: string[],
  timestamp: number,
  view: number,
): EntityFrame => ({
  height: state.height,
  parentFrameHash: getPrevFrameHash(replica.state),
  stateRoot,
  authorityRoot,
  entityContext,
  txs: [...selection.proposalTxs],
  events: structuredClone(applied.events),
  hash: frameHash,
  timestamp,
  leader: {
    proposerSignerId: replica.signerId.toLowerCase(),
    view,
    ...(replica.pendingLeaderCertificate ? { certificate: replica.pendingLeaderCertificate } : {}),
  },
  ...(selection.proposalJPrefixCertificate ? { jPrefixCertificate: structuredClone(selection.proposalJPrefixCertificate) } : {}),
  hashesToSign,
  collectedSigs: new Map([[replica.signerId, selfSigs]]),
});

const buildMultiSignerProposal = async (
  context: ApplyEntityInputContext,
  selection: EntityProposalSelection,
): Promise<EntityFrame | null> => {
  const { env, workingReplica } = context;
  const { proposalJPrefixCertificate, proposalTxs } = selection;
  const authorityConfig = getEntityFrameConsensusConfig(
    env,
    workingReplica.state,
    proposalTxs,
  );
  const authorityReplica = authorityConfig === workingReplica.state.config
    ? workingReplica
    : {
        ...workingReplica,
        state: withBoardAuthority(workingReplica.state, authorityConfig),
      };
  const leader = getReplicaProposalLeader(authorityReplica);
  assertMultiSignerProposalPrefix(env, authorityReplica, selection, leader.view);
  const fitted = await fitEntityProposalToWireBudget({
    env,
    replica: workingReplica,
    proposalTxs,
    jPrefixCertificate: proposalJPrefixCertificate ?? undefined,
    usePersistedReplayContext: context.usePersistedReplayContext,
  });
  if (fitted.txs.length !== selection.proposalTxs.length) {
    selection.proposalTxs = fitted.txs;
  }
  const entityContext = fitted.entityContext;
  const applied = await applyEntityFrame(
    env,
    workingReplica.state,
    entityContext,
    selection.proposalTxs,
    env.state.timestamp,
  );
  if (!shouldKeepPreparedEntityFrame(selection, applied.accountsToProposeFramesCount)) {
    return null;
  }
  const height = workingReplica.state.height + 1;
  const state = buildProposalState(
    env,
    workingReplica,
    applied.newState,
    proposalTxs,
    height,
    env.state.timestamp,
    leader.view,
  );
  const parentFrameHash = getPrevFrameHash(workingReplica.state);
  const stateRoot = computeCanonicalEntityConsensusStateHash(state);
  const authorityRoot = computeEntityFrameAuthorityRoot(buildEntityFrameAuthority(state));
  const frameHash = createEntityFrameHashFromStateRoot(
    parentFrameHash,
    height,
    env.state.timestamp,
    proposalTxs,
    applied.events,
    state.entityId,
    stateRoot,
    authorityRoot,
    entityContext,
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
  const selfSigs = await signProposalManifest(env, workingReplica, state, hashesToSign);
  storeMultiSignerCandidate(workingReplica, applied, state, frameHash, hashesToSign);
  const frame = assembleMultiSignerFrame(
    workingReplica, selection, applied, state, entityContext, frameHash,
    stateRoot, authorityRoot, hashesToSign, selfSigs, env.state.timestamp, leader.view,
  );
  validateProposedEntityFrame(frame, 'MultiSignerEntityFrame');
  markEntityFrameBodyVerified(frame);
  return frame;
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
  if (!proposal) return;
  context.workingReplica.proposal = proposal;
  entityLog.debug('proposal.created', {
    frame: shortHash(proposal.hash),
    txs: proposal.txs.length,
    hashes: proposal.hashesToSign?.length ?? 0,
  });
  const proposalValidators = proposal.txs.some(tx => tx.type === 'boardHandover')
    ? context.workingReplica.candidate?.state.config.validators
    : context.workingReplica.state.config.validators;
  if (!proposalValidators) throw new Error('ENTITY_PROPOSAL_CANDIDATE_MISSING');
  for (const validatorId of proposalValidators) {
    if (validatorId === context.workingReplica.signerId) continue;
    context.entityOutbox.push({
      entityId: context.entityInput.entityId,
      signerId: validatorId,
      proposedFrame: proposal,
    });
  }
};
