import { signAccountFrame, signDigestsBatch } from '../../../account/crypto';
import {
  assertEntityConfigBoardAuthority,
  encodeSingleSignerEntityHankos,
} from '../../../hanko/signing';
import { shortHash, shortId } from '../../../support/logger';
import { assertFrameJPrefix } from '../../../jurisdiction/machine/history/j-prefix-consensus';
import {
  cloneIsolatedEntityLeaderCertificate,
  cloneIsolatedProposedEntityFrame,
} from '../../state/input-clone';
import type { EntityReplica, EntityState, EntityFrame, EntityCandidate } from '../../types';
import type { EntityRuntimeContext } from '../../runtime-context';
import type { EntityTx } from '../../../types/entity-tx';
import type { HankoString } from '../../../types/hanko';
import {
  createEntityFrameHashFromStateRoot,
  entityFrameEventsEqual,
} from '../frame';
import { applyEntityFrame, applyRuntimeOwnedEntityFrame } from '../frame/application';
import { copyProposableAccounts } from '../account/touched-accounts';
import {
  buildEntityHashesToSign,
  getEntityHashManifestMismatch,
} from '../input/hanko-witness';
import type { ApplyEntityInputContext, ApplyEntityInputResult } from '../input/types';
import { getReplicaProposalLeader } from '../leader';
import { buildCertifiedEntityOutputHashes } from '../output/certification';
import {
  shouldKeepPreparedEntityFrame,
  type EntityProposalSelection,
} from './selection';
import { expectedCommittedLeaderState } from '../leader/certificates';
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
import { primeProposalHankos } from './prime-hankos';
import { requireEntityProposalReplayOracleEntry } from './replay-oracle';
import { countOp, OP_COUNTERS_ENABLED } from '../../../support/performance/op-counters';
import { assertEstimatedSealedEntityFrameWire } from '../frame/validation';
import { cumulativeMarksToPhases, snapshotPerfPhases } from '../../../support/performance/profile';
import { assertHtlcPreparedInfraContext, startInboundLayerPriming } from '../../htlc/materialize-context';
import { requireEntityEncryptionPrivateKey } from '../../auth/crypto';
import { assertEntityInfraContextAuthority } from '../frame/infra-context-validation';
import {
  getBoardHandoverFrameConfig,
  getBoardHandoverLeaderState,
  getEntityFrameConsensusConfig,
  withBoardAuthority,
} from '../authority/board-handover';
import { finalizeCommitNotification } from '../commit/finalization';
import { MalformedEntityFrameInputError } from '../../tx/processing/invariant-errors';
import { entityFrameProfileEnabled, entityFrameSlowMs } from '../frame/profile';
import { getPerfMs } from '../../../support/time';

export type ProposalProfile = {
  startedAt: number;
  checkpoints: Record<string, number>;
  checkpoint: (label: string) => void;
};

const noProfile: ProposalProfile = { startedAt: 0, checkpoints: {}, checkpoint: () => undefined };

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
  txs: readonly EntityTx[],
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
  const authorityAt = OP_COUNTERS_ENABLED ? getPerfMs() : 0;
  await assertEntityConfigBoardAuthority(
    env,
    replica.state.entityId,
    state.config,
    state,
  );
  countOp('entity.proposal.boardAuthority', 0, OP_COUNTERS_ENABLED ? Math.round((getPerfMs() - authorityAt) * 1_000) : 0);
  // Same deterministic secp256k1 bytes either way; the pool takes the batch
  // off the main thread on a Hub, a single-runtime host signs inline.
  const pooled = await signDigestsBatch(env, replica.signerId, hashesToSign.map(hash => hash.hash));
  if (pooled) return pooled;
  return hashesToSign.map(hash => signAccountFrame(env, replica.signerId, hash.hash));
};

const assertProposalPrefix = (
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

const storeCandidate = (
  replica: EntityReplica,
  applied: Awaited<ReturnType<typeof applyEntityFrame>>,
  state: EntityState,
  frameHash: string,
  hashesToSign: ReturnType<typeof buildEntityHashesToSign>,
  authority: ReturnType<typeof buildEntityFrameAuthority>,
): EntityCandidate => {
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
    authority,
    ...(applied.consumptionNodeChanges ? { consumptionNodeChanges: applied.consumptionNodeChanges } : {}),
    ...(applied.accountJClaimNodeChanges ? { accountJClaimNodeChanges: applied.accountJClaimNodeChanges } : {}),
  };
  return replica.candidate;
};

type PreparedEntityProposal = Readonly<{
  txs: EntityTx[];
  entityContext: EntityFrame['entityContext'];
  applied: Awaited<ReturnType<typeof applyEntityFrame>>;
  leader: ReturnType<typeof getReplicaProposalLeader>;
  jPrefixCertificate: EntityFrame['jPrefixCertificate'] | undefined;
}>;

type SealedEntityProposal = Readonly<{
  frame: EntityFrame;
  /** Full secondary proof material lives only across this local commit call. */
  localCommitHankos?: readonly HankoString[];
}>;

const fitAndApplyEntityProposal = async (
  context: ApplyEntityInputContext,
  selection: EntityProposalSelection,
  profile: ProposalProfile,
): Promise<PreparedEntityProposal | null> => {
  const { env, workingReplica } = context;
  const { proposalJPrefixCertificate, proposalTxs } = selection;
  const authorityConfig = getEntityFrameConsensusConfig(env, workingReplica.state, proposalTxs);
  const authorityReplica = authorityConfig === workingReplica.state.config
    ? workingReplica
    : { ...workingReplica, state: withBoardAuthority(workingReplica.state, authorityConfig) };
  const leader = getReplicaProposalLeader(authorityReplica);
  assertProposalPrefix(env, authorityReplica, selection, leader.view);
  const fitted = await fitEntityProposalToWireBudget({
    env,
    replica: workingReplica,
    proposalTxs,
    jPrefixCertificate: proposalJPrefixCertificate ?? undefined,
    usePersistedReplayContext: context.usePersistedReplayContext,
    ...(selection.proposalSelection.wirePrefixMeter
      ? { wirePrefixMeter: selection.proposalSelection.wirePrefixMeter }
      : {}),
    ...(selection.requiredTxPrefixCount !== undefined
      ? { requiredPrefixCount: selection.requiredTxPrefixCount }
      : {}),
  });
  if (fitted.txs.length !== selection.proposalTxs.length) selection.proposalTxs = fitted.txs;
  profile.checkpoint('wireFit');
  // Hanko recovery for the candidate set started at proposal start; the
  // synchronous verifiers below hit the memo once it lands.
  await (context.hankoPriming ?? primeProposalHankos(selection.proposalTxs));
  const applyFrame = context.promoteCandidateState && selection.isSingleSigner
    ? applyRuntimeOwnedEntityFrame
    : applyEntityFrame;
  const applied = await applyFrame(
    env,
    workingReplica.state,
    fitted.entityContext,
    selection.proposalTxs,
    env.state.timestamp,
    !fitted.replayed,
  );
  profile.checkpoint('frameApply');
  if (!shouldKeepPreparedEntityFrame(selection, applied.accountsToProposeFramesCount)) return null;
  return {
    txs: selection.proposalTxs,
    entityContext: fitted.entityContext,
    applied,
    leader,
    jPrefixCertificate: proposalJPrefixCertificate ?? undefined,
  };
};

const sealEntityProposal = async (
  context: ApplyEntityInputContext,
  selection: EntityProposalSelection,
  prepared: PreparedEntityProposal,
  profile: ProposalProfile,
): Promise<SealedEntityProposal> => {
  const { env, workingReplica } = context;
  const { txs, entityContext, applied, leader, jPrefixCertificate } = prepared;
  const height = workingReplica.state.height + 1;
  const timestamp = env.state.timestamp;
  const state = buildProposalState(env, workingReplica, applied.newState, txs, height, timestamp, leader.view);
  const parentFrameHash = getPrevFrameHash(workingReplica.state);
  profile.checkpoint('proposalState');
  const stateRoot = computeCanonicalEntityConsensusStateHash(state);
  profile.checkpoint('stateRoot');
  const authority = buildEntityFrameAuthority(state);
  const authorityRoot = computeEntityFrameAuthorityRoot(authority);
  profile.checkpoint('authorityRoot');
  const frameHash = createEntityFrameHashFromStateRoot(
    parentFrameHash, height, timestamp, txs, applied.events, state.entityId,
    stateRoot, authorityRoot, entityContext, jPrefixCertificate,
  );
  const replayOracle = env.infrastructure?.replayEntityProposalOracle;
  if (replayOracle && context.usePersistedReplayContext) {
    const expected = requireEntityProposalReplayOracleEntry(replayOracle, workingReplica.entityId, height);
    if (frameHash !== expected.frameHash) {
      throw new Error(`HLT_ENTITY_PROPOSAL_ORACLE_FRAME_HASH_MISMATCH:${height}:${expected.frameHash}:${frameHash}`);
    }
  }
  profile.checkpoint('frameHash');
  const outputHashes = buildCertifiedEntityOutputHashes(state, env, height, frameHash, applied.outputs);
  profile.checkpoint('outputHashes');
  const hashesToSign = buildEntityHashesToSign(
    workingReplica.state.entityId,
    height,
    frameHash,
    [...(applied.collectedHashes ?? []), ...outputHashes],
  );
  profile.checkpoint('hashManifest');
  const leaderBody = {
    proposerSignerId: workingReplica.signerId.toLowerCase(),
    view: leader.view,
    ...(workingReplica.pendingLeaderCertificate ? { certificate: workingReplica.pendingLeaderCertificate } : {}),
  };
  const sealedContext = selection.isSingleSigner ? 'SingleSignerEntityFrame' : 'MultiSignerEntityFrame';
  const estimatedWireBytes = assertEstimatedSealedEntityFrameWire({
    height, parentFrameHash, stateRoot, authorityRoot, entityContext,
    txs: [...txs], events: applied.events, hash: frameHash, timestamp,
    leader: leaderBody,
    ...(jPrefixCertificate ? { jPrefixCertificate } : {}),
    hashesToSign,
  }, workingReplica.signerId, selection.isSingleSigner, sealedContext);
  countOp('entity.frame.sealed', estimatedWireBytes);
  countOp(`entity.frame.txs.${
    txs.length === 0 ? '0' : txs.length === 1 ? '1' : txs.length < 8 ? '2-7'
      : txs.length < 32 ? '8-31' : txs.length < 128 ? '32-127' : '128+'
  }`);
  profile.checkpoint('wireEstimate');
  const selfSigs = await signProposalManifest(env, workingReplica, state, hashesToSign);
  profile.checkpoint('manifestSignatures');
  const localCommitHankos = selection.isSingleSigner
    ? encodeSingleSignerEntityHankos(
        env,
        workingReplica.state.entityId,
        workingReplica.signerId,
        selfSigs,
        state,
      )
    : undefined;
  const entityFrameHanko = localCommitHankos?.[0];
  if (selection.isSingleSigner && !entityFrameHanko) {
    throw new Error(`LOCAL_ENTITY_FRAME_HANKO_MISSING:${height}:${frameHash}`);
  }
  profile.checkpoint('hankoEncoding');
  const frame: EntityFrame = {
    height, parentFrameHash, stateRoot, authorityRoot, entityContext,
    txs: [...txs], events: structuredClone(applied.events), hash: frameHash, timestamp,
    leader: leaderBody,
    ...(jPrefixCertificate ? { jPrefixCertificate: structuredClone(jPrefixCertificate) } : {}),
    hashesToSign,
    collectedSigs: new Map([[workingReplica.signerId.toLowerCase(), selfSigs]]),
    ...(entityFrameHanko ? { hankos: [entityFrameHanko] } : {}),
  };
  // This is the owning constructor, not an untrusted wire boundary. The body
  // was already canonically encoded and bounded by createEntityFrameHash*, and
  // the conservative sealed-size template above includes every fixed-size
  // signature and a larger-than-canonical single-signer Hanko. Re-decoding the
  // object here encoded the multi-megabyte frame twice more per proposal.
  // Remote/recovered frames still use validateProposedEntityFrame at ingress.
  storeCandidate(workingReplica, applied, state, frameHash, hashesToSign, authority);
  return {
    frame,
    ...(localCommitHankos ? { localCommitHankos } : {}),
  };
};

/**
 * Build the next Entity frame from the selected mempool txs: fit to wire,
 * apply, hash, sign own manifest. Same for every board size; a single-signer
 * board additionally seals its own quorum hankos here since no precommit
 * round follows.
 */
const buildEntityProposal = async (
  context: ApplyEntityInputContext,
  selection: EntityProposalSelection,
  profile: ProposalProfile,
): Promise<SealedEntityProposal | null> => {
  const prepared = await fitAndApplyEntityProposal(context, selection, profile);
  return prepared ? sealEntityProposal(context, selection, prepared, profile) : null;
};

const isFrameByteLimitError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('ENTITY_FRAME_TOTAL_BYTE_LIMIT_EXCEEDED') ||
    message.includes('wire byte limit exceeded');
};

/**
 * Proposing straight from the mempool: one rejected tx (a peer's invalid
 * certified output, a stale command) must not poison every other tx batched
 * into the same frame — evict exactly that tx and rebuild. Invariant failures
 * keep propagating; only `reject`-disposition frame rejections are evicted.
 * A frame whose applied bytes outgrow the wire budget defers its tail to the
 * next frame instead of halting.
 */
const buildEntityProposalEvictingRejected = async (
  context: ApplyEntityInputContext,
  selection: EntityProposalSelection,
  profile: ProposalProfile,
): Promise<SealedEntityProposal | null> => {
  for (let round = 0; round <= selection.proposalTxs.length; round += 1) {
    try {
      return await buildEntityProposal(context, selection, profile);
    } catch (error) {
      if (isFrameByteLimitError(error) && selection.proposalTxs.length > 1) {
        // Both byte-limit errors end in `:<actual>:<limit>`; scale the kept
        // prefix by that ratio (10% margin) instead of blind halving.
        const message = error instanceof Error ? error.message : String(error);
        const ratioMatch = /(\d+):(\d+)\s*(?::txs=|$)/.exec(message);
        const actual = ratioMatch ? Number(ratioMatch[1]) : 0;
        const limit = ratioMatch ? Number(ratioMatch[2]) : 0;
        const scaled = actual > limit && limit > 0
          ? Math.floor(selection.proposalTxs.length * 0.9 * limit / actual)
          : Math.floor(selection.proposalTxs.length / 2);
        const keep = Math.max(1, Math.min(scaled, selection.proposalTxs.length - 1));
        entityLog.warn('proposal.frame_bytes_deferred', {
          entity: shortId(context.workingReplica.entityId),
          selected: keep,
          deferred: selection.proposalTxs.length - keep,
          error: message.slice(0, 400),
        });
        selection.proposalTxs = selection.proposalTxs.slice(0, keep);
        continue;
      }
      if (!(error instanceof MalformedEntityFrameInputError) || error.frameTx === undefined) throw error;
      const rejectedTx = error.frameTx as EntityTx;
      const inProposal = selection.proposalTxs.includes(rejectedTx);
      const inMempool = context.workingReplica.mempool.includes(rejectedTx);
      if (!inProposal || !inMempool || selection.proposalTxs.length === 1) throw error;
      entityLog.warn('proposal.tx_evicted', {
        entity: shortId(context.workingReplica.entityId),
        txType: error.txType,
        rejection: error.rejection,
        remaining: selection.proposalTxs.length - 1,
      });
      context.workingReplica.mempool = context.workingReplica.mempool.filter(tx => tx !== rejectedTx);
      selection.proposalTxs = selection.proposalTxs.filter(tx => tx !== rejectedTx);
    }
  }
  throw new Error('ENTITY_PROPOSAL_EVICTION_LOOP_EXHAUSTED');
};

// The perf snapshot sorts every phase's sample window for percentiles; doing
// that on each of ~900 frames per minute was ~9% of Hub CPU under profiling.
// Slow frames always carry it; fast frames at most every few seconds.
const PERF_SNAPSHOT_MIN_INTERVAL_MS = 5_000;
let lastPerfSnapshotAtMs = -Infinity;

const logProposalProfile = (
  context: ApplyEntityInputContext,
  frame: EntityFrame,
  profile: ProposalProfile,
): void => {
  const now = getPerfMs();
  const elapsedMs = Math.round(now - profile.startedAt);
  const slow = elapsedMs >= entityFrameSlowMs();
  if (!entityFrameProfileEnabled() && !slow) return;
  const withPerf = slow || now - lastPerfSnapshotAtMs >= PERF_SNAPSHOT_MIN_INTERVAL_MS;
  if (withPerf) lastPerfSnapshotAtMs = now;
  entityLog.info('single_signer.profile', {
    entity: String(context.workingReplica.entityId || '').slice(-8),
    elapsedMs,
    txs: frame.txs.length,
    outputs: context.entityOutbox.length,
    jOutputs: context.jOutbox.length,
    phases: cumulativeMarksToPhases(profile.checkpoints, elapsedMs),
    ...(withPerf ? { perf: snapshotPerfPhases() } : {}),
  });
};

/**
 * Build the next frame when this replica may propose. A single-signer board is
 * its own quorum, so the frame commits immediately (state, overlay, outputs
 * land in this same input); a larger board stores the frame as the open
 * proposal and sends it to the validators for precommits.
 */
export const startEntityProposalIfReady = async (
  context: ApplyEntityInputContext,
  selection: EntityProposalSelection,
  localCanPropose: boolean,
  profile: ProposalProfile = noProfile,
): Promise<ApplyEntityInputResult | null> => {
  const { workingReplica } = context;
  if (!shouldStartProposal(workingReplica, selection, localCanPropose)) return null;
  entityLog.debug('proposal.auto_start', {
    mempool: selection.proposalTxs.length,
    txs: selection.proposalTxs.map(tx => tx.type),
  });
  const priorState = workingReplica.state;
  // Pool work for the whole candidate set starts now and overlaps selection,
  // fitting and context materialization on the main thread.
  startInboundLayerPriming({
    state: workingReplica.state,
    proposalTxs: selection.proposalTxs,
    entityEncryptionPublicKey: workingReplica.state.entityEncryptionPublicKey,
    entityEncryptionPrivateKey: requireEntityEncryptionPrivateKey(context.env, workingReplica.entityId),
  });
  context.hankoPriming = primeProposalHankos(selection.proposalTxs);
  const sealed = await buildEntityProposalEvictingRejected(context, selection, profile);
  if (!sealed) return null;
  const { frame } = sealed;
  const candidate = workingReplica.candidate;
  if (!candidate) throw new Error('ENTITY_PROPOSAL_CANDIDATE_MISSING');
  if (selection.isSingleSigner) {
    // Retired validators of a board handover remain full-state observers:
    // deliver the certified transition to the old board, never authority.
    const handoverConfig = getBoardHandoverFrameConfig(context.env, priorState, frame.txs);
    const result = await finalizeCommitNotification(context, frame, candidate, frame.collectedSigs ?? new Map(), {
      localProposal: true,
      ...(sealed.localCommitHankos ? { localCommitHankos: sealed.localCommitHankos } : {}),
      ...(handoverConfig ? { broadcastCommit: true, broadcastValidators: priorState.config.validators } : {}),
    });
    profile.checkpoint('commit');
    logProposalProfile(context, frame, profile);
    return result;
  }
  workingReplica.proposal = frame;
  entityLog.debug('proposal.created', {
    frame: shortHash(frame.hash),
    txs: frame.txs.length,
    hashes: frame.hashesToSign?.length ?? 0,
  });
  const proposalValidators = frame.txs.some(tx => tx.type === 'boardHandover')
    ? candidate.state.config.validators
    : workingReplica.state.config.validators;
  for (const validatorId of proposalValidators) {
    if (validatorId === workingReplica.signerId) continue;
    context.entityOutbox.push({
      entityId: context.entityInput.entityId,
      signerId: validatorId,
      proposedFrame: frame,
    });
  }
  return null;
};
