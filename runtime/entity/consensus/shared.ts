import { encodeCanonicalConsensusValue } from '../../protocol/canonical-consensus-value';
/**
 * Entity consensus: validator replicas agree on entity frames, then route
 * committed account/J-layer side effects back into the runtime.
 */

import { verifyAccountSignature } from '../../account/crypto';
import { buildCrossJurisdictionFillId, CROSS_J_PENDING_FILL_ACK_TTL_MS } from '../../extensions/cross-j/fill-ack';
import { cloneCrossJurisdictionAccountTxRoute } from '../../extensions/cross-j/index';
import { createStructuredLogger, shortId, shortOrder } from '../../infra/logger';
import { isRuntimePerfProfileEnabled, readRuntimePerfSlowMs } from '../../infra/perf-runtime-flags';
import {
  assertFrameJPrefix,
  buildLocalJPrefixAttestation,
  entityRequiresJPrefixCertificate,
  getLocalJPrefixAttestableHeight,
  hasCurrentRoundJPrefixAttestation,
  hasDueLocalJPrefixAdvance,
  hasPendingLocalJEvent,
  mergeJPrefixAttestations,
} from '../../jurisdiction/j-prefix-consensus';
import {
  getJEventRangeValidationError,
  getValidatorJContiguousThroughHeight,
  isCertifiedJHistoryCorruption,
  pruneFinalizedValidatorJHistory,
} from '../../jurisdiction/local-history';
import { getEntityFrameJRangeBudgetError } from '../../jurisdiction/range-budget';
import {
  findCrossJurisdictionBookAdmissionForAck,
  normalizeEntityRef,
} from '../../orderbook/cross-j-orderbook';
import { compareStableText } from '../../protocol/serialization';
import { nodeProcess } from '../../infra/runtime-process';
import type { AccountTx, AccountReplica, RuntimeOverlayRecord } from '../../types/account';
import type { ConsensusConfig, EntityCandidate, EntityCandidateEffect, EntityInput, EntityLeaderCertificate, EntityLeaderTimeoutVote, EntityOutput, EntityReplica, EntityState, HashToSign, ProposedEntityFrame } from '../types';
import type { EntityRuntimeContext } from '../runtime-context';
import type { AccountConsensusContext } from '../../account/consensus/context';
import type { EntityTx } from '../../types/entity-tx';
import { log } from '../../infra/diagnostics';
import { emitDefaultProposerHtlcOnionAdvances } from '../htlc-onion-post-commit';
import { collectCommittedCrossJurisdictionCancelAcks } from '../tx/handlers/account';
import { applyAccountInput } from '../../account/consensus';
import { createLocalAccountInput } from '../../account/input';
import { createEntityFrameHashFromStateRoot } from './frame';
import {
  assertEntityLeaderVoteMatchesState,
  getEntityLeaderState,
  hashEntityLeaderVoteBody,
  isEntityActiveLeader,
  leaderVoteCollectionKey,
  type EntityLeaderStateView,
} from './leader';
import { classifyEntityConsensusStateQuotaTransition, measureEntityConsensusStateBytes } from './state-quota';
import { calculateQuorumPower } from './replica-validation';

export { CROSS_J_PENDING_FILL_ACK_TTL_MS } from '../../extensions/cross-j/fill-ack';

const consumptionStateMeasurement = (state: EntityState) =>
  measureEntityConsensusStateBytes(state, {
    getAccumulatorState: candidate => candidate.consumptionAccumulator,
  });

type ConsumptionSizeLog = Readonly<{
  warning: boolean;
  details: Record<string, string>;
}>;

const ENTITY_SIZE_OBSERVATION_PERIOD_FRAMES = 100;

export const prepareCommittedEntitySizeLog = (
  env: EntityRuntimeContext,
  preState: EntityState,
  postState: EntityState,
): ConsumptionSizeLog | null => {
  const configuredWarningBytes = env.runtimeConfig?.entityConsensusStateWarningBytes;
  // Canonical Entity encoding is already paid once for the consensus root.
  // Re-encoding both the pre- and post-state on every frame only to emit a
  // debug size line doubles the hot-path work. Observe periodically by default;
  // an explicitly configured quota keeps per-frame warning precision.
  if (
    configuredWarningBytes === undefined &&
    postState.height !== 1 &&
    postState.height % ENTITY_SIZE_OBSERVATION_PERIOD_FRAMES !== 0
  ) {
    return null;
  }
  const before = consumptionStateMeasurement(preState);
  const after = consumptionStateMeasurement(postState);
  const assessment = classifyEntityConsensusStateQuotaTransition(
    before.totalBytes,
    after.totalBytes,
    configuredWarningBytes === undefined ? undefined : { warningBytes: configuredWarningBytes },
  );
  return {
    warning: assessment.classification !== 'within',
    details: {
      entity: shortId(postState.entityId),
      outputCount: postState.consumptionAccumulator?.count.toString() ?? '0',
      consumptionTreeBytes: after.consumptionTreeBytes.toString(),
      totalBytes: after.totalBytes.toString(),
      warningBytes: assessment.warningBytes.toString(),
      overageBytes: assessment.overageBytes.toString(),
      classification: assessment.classification,
    },
  };
};

export const emitCommittedEntitySizeLog = (entry: ConsumptionSizeLog | null): void => {
  if (!entry) return;
  if (entry.warning) entityLog.warn('state.size_warning', entry.details);
  else entityLog.debug('state.size', entry.details);
};

export const MAX_PENDING_CROSS_J_FILL_ACKS = 1024;

const ENTITY_FRAME_PROFILE =
  nodeProcess?.env?.['XLN_ENTITY_FRAME_PROFILE'] === '1' ||
  nodeProcess?.env?.['XLN_ENTITY_INPUT_PROFILE'] === '1' ||
  nodeProcess?.env?.['XLN_RUNTIME_PROCESS_PROFILE'] === '1';
const ENTITY_FRAME_SLOW_MS = Math.max(0, Number(nodeProcess?.env?.['XLN_ENTITY_FRAME_SLOW_MS'] || '1000'));
export const entityFrameProfileEnabled = (): boolean =>
  ENTITY_FRAME_PROFILE || isRuntimePerfProfileEnabled('XLN_ENTITY_FRAME_PROFILE', 'XLN_ENTITY_INPUT_PROFILE');
export const entityFrameSlowMs = (): number => readRuntimePerfSlowMs('XLN_ENTITY_FRAME_SLOW_MS', ENTITY_FRAME_SLOW_MS);
export const entityLog = createStructuredLogger('entity');

export const getReplicaJRangeValidationError = (
  env: EntityRuntimeContext,
  replica: EntityReplica,
  txs: EntityTx[],
): string | null => {
  try {
    const budgetError = getEntityFrameJRangeBudgetError(txs);
    if (budgetError) return budgetError;
    const activeProposerId = getEntityLeaderState(replica.state).activeValidatorId;
    for (const tx of txs) {
      if (tx.type !== 'j_event') continue;
      const error = getJEventRangeValidationError(
        replica.state,
        replica.jHistory,
        tx.data,
        activeProposerId,
        (signerId, digest, signature) => verifyAccountSignature(env, signerId, digest, signature),
      );
      if (error) return error;
    }
  } catch (error) {
    if (isCertifiedJHistoryCorruption(error)) throw error;
    return error instanceof Error ? error.message : String(error);
  }
  return null;
};

export const assertProposerJRangesMatchLocalHistory = (
  env: EntityRuntimeContext,
  replica: EntityReplica,
  txs: EntityTx[],
): void => {
  const error = getReplicaJRangeValidationError(env, replica, txs);
  if (error) throw new Error(`ENTITY_PROPOSER_J_RANGE_INVALID:${error}`);
};

export const getFrameJPrefixValidationError = (
  env: EntityRuntimeContext,
  replica: EntityReplica,
  frame: ProposedEntityFrame,
): string | null => {
  try {
    assertFrameJPrefix(env, replica, frame);
    return null;
  } catch (error) {
    if (isCertifiedJHistoryCorruption(error)) throw error;
    return error instanceof Error ? error.message : String(error);
  }
};

export const isJPrefixLocalFreshnessRace = (error: string): boolean =>
  error === 'J_PREFIX_STRONGER_LOCAL_CERTIFICATE' || error === 'J_PREFIX_REQUIRED_LOCAL_EVENT';

export const pruneReplicaFinalizedJHistory = (replica: EntityReplica): void => {
  const pruned = pruneFinalizedValidatorJHistory(replica.jHistory, replica.state.lastFinalizedJHeight);
  if (pruned) replica.jHistory = pruned;
  else delete replica.jHistory;
};

const clearCommittedJPrefixRound = (replica: EntityReplica): void => {
  if (replica.jPrefixRound && replica.jPrefixRound.targetEntityHeight <= replica.state.height) {
    delete replica.jPrefixRound;
  }
};

export const ensureLocalJPrefixAttestation = (
  env: EntityRuntimeContext,
  replica: EntityReplica,
  entityOutbox: EntityOutput[],
  force: boolean,
): boolean => {
  if (hasCurrentRoundJPrefixAttestation(replica)) return false;
  if (replica.proposal || replica.lockedFrame) return false;
  if (
    !force &&
    !entityRequiresJPrefixCertificate(replica.state) &&
    !hasPendingLocalJEvent(replica.state, replica.jHistory)
  ) {
    return false;
  }
  const history = replica.jHistory;
  if (!history) return false;
  if (history.scannedThroughHeight < replica.state.lastFinalizedJHeight) {
    throw new Error(
      `J_PREFIX_LOCAL_HISTORY_BEHIND:${history.scannedThroughHeight}:` + `${replica.state.lastFinalizedJHeight}`,
    );
  }
  if (getLocalJPrefixAttestableHeight(replica.state, history) === null) {
    entityLog.debug('j_prefix.local_attestation_deferred', {
      entity: shortId(replica.entityId),
      baseHeight: replica.state.lastFinalizedJHeight,
      scannedThroughHeight: history.scannedThroughHeight,
      contiguousThroughHeight: getValidatorJContiguousThroughHeight(replica.state, history),
      reason: 'authenticated_headers_incomplete',
    });
    return false;
  }
  const attestation = buildLocalJPrefixAttestation(env, replica, history);
  if (!attestation) {
    throw new Error(`J_PREFIX_LOCAL_ATTESTATION_MISSING:${replica.entityId}:${history.scannedThroughHeight}`);
  }
  const sourceValidatorId = replica.signerId.trim().toLowerCase();
  replica.jPrefixRound = mergeJPrefixAttestations(
    env,
    replica.state,
    replica.jPrefixRound,
    new Map([[sourceValidatorId, attestation]]),
  );
  replica.lastConsensusProgressAt = env.timestamp;
  for (const validatorId of replica.state.config.validators) {
    if (validatorId.trim().toLowerCase() === sourceValidatorId) continue;
    entityOutbox.push({
      entityId: replica.entityId,
      signerId: validatorId,
      jPrefixAttestations: new Map([[sourceValidatorId, structuredClone(attestation)]]),
    });
  }
  return true;
};

/**
 * Carry due J work observed after this validator cast its previous-round vote
 * into the next Entity round immediately after commit.
 *
 * A signed prefix is immutable for its Entity height. The watcher therefore
 * keeps a later scan in durable validator-local history. A semantic event
 * must not wait for unrelated Entity traffic,
 * so deriving that due vote here is a deterministic consequence of the commit.
 * An empty suffix remains local and is certified by the next real Entity frame
 * instead of creating one itself.
 */
const advanceLocalJPrefixRoundAfterCommit = (
  env: EntityRuntimeContext,
  replica: EntityReplica,
  entityOutbox: EntityOutput[],
): void => {
  clearCommittedJPrefixRound(replica);
  if (!hasDueLocalJPrefixAdvance(replica.state, replica.jHistory)) return;
  if (!ensureLocalJPrefixAttestation(env, replica, entityOutbox, false)) return;
  const round = replica.jPrefixRound!;
  if (
    isEntityActiveLeader(replica) &&
    round.certificate &&
    round.certificate.selected.scannedThroughHeight > replica.state.lastFinalizedJHeight
  ) {
    // Empty addressed inputs are the canonical immediate consensus wake. The
    // signed head itself is already in the same durable replica projection.
    entityOutbox.push({ entityId: replica.entityId, signerId: replica.signerId, entityTxs: [] });
  }
};

export const runLocalPostCommitHooks = async (
  env: EntityRuntimeContext,
  replica: EntityReplica,
  entityOutbox: EntityOutput[],
): Promise<void> => {
  advanceLocalJPrefixRoundAfterCommit(env, replica, entityOutbox);
  await emitDefaultProposerHtlcOnionAdvances(env, replica, entityOutbox);
};

type CrossSwapFillAckTx = Extract<AccountTx, { type: 'cross_swap_fill_ack' }>;
type CrossJurisdictionFillNoticeTx = Extract<EntityTx, { type: 'crossJurisdictionFillNotice' }>;

const fallbackFrameHashToSign = (hash: string, height: number): HashToSign[] => [
  {
    hash,
    type: 'entityFrame',
    context: `entity-frame:${height}`,
  },
];

export const normalizePrecommitBundles = (
  config: ConsensusConfig,
  bundles: Map<string, string[]>,
  context: string,
): Map<string, string[]> => {
  const validators = new Map(config.validators.map(validator => [validator.toLowerCase(), validator]));
  const normalized = new Map<string, string[]>();
  for (const [rawSignerId, signatures] of bundles) {
    const signerId = rawSignerId.trim().toLowerCase();
    if (!validators.has(signerId)) {
      throw new Error(`${context}:UNKNOWN_SIGNER:${rawSignerId}`);
    }
    if (normalized.has(signerId)) {
      throw new Error(`${context}:DUPLICATE_SIGNER:${rawSignerId}`);
    }
    if (!Array.isArray(signatures)) {
      throw new Error(`${context}:SIGNATURE_BUNDLE_NOT_ARRAY:${rawSignerId}`);
    }
    normalized.set(signerId, [...signatures]);
  }
  return normalized;
};

export const verifyHashPrecommitSignatures = (
  env: EntityRuntimeContext,
  signerId: string,
  hashesToSign: HashToSign[] | undefined,
  frameHash: string,
  frameHeight: number,
  sigs: string[],
  context: string,
): boolean => {
  const expectedHashes = hashesToSign?.length ? hashesToSign : fallbackFrameHashToSign(frameHash, frameHeight);
  if (sigs.length !== expectedHashes.length) {
    log.error(
      `❌ ${context}: signature count mismatch from ${signerId}: got ${sigs.length}, expected ${expectedHashes.length}`,
    );
    return false;
  }
  for (let i = 0; i < expectedHashes.length; i++) {
    const hashInfo = expectedHashes[i];
    const sig = sigs[i];
    if (!hashInfo || !sig) {
      log.error(`❌ ${context}: missing signature[${i}] from ${signerId}`);
      return false;
    }
    if (!verifyAccountSignature(env, signerId, hashInfo.hash, sig)) {
      log.error(
        `❌ ${context}: invalid ${hashInfo.type} signature[${i}] from ${signerId} ` +
          `hash=${hashInfo.hash.slice(0, 30)}... context=${hashInfo.context}`,
      );
      return false;
    }
  }
  return true;
};

export const hasVerifiedPreparedQuorum = (
  env: EntityRuntimeContext,
  state: EntityLeaderStateView,
  frame: ProposedEntityFrame,
  context: string,
): boolean => {
  const hashes = frame.hashesToSign;
  if (!hashes?.length || hashes[0]?.type !== 'entityFrame' || hashes[0]?.hash !== frame.hash) {
    throw new Error(`${context}_MANIFEST_INVALID:${frame.hash}`);
  }
  const signatures = normalizePrecommitBundles(state.config, frame.collectedSigs ?? new Map(), context);
  for (const [signerId, bundle] of signatures) {
    if (!verifyHashPrecommitSignatures(env, signerId, hashes, frame.hash, frame.height, bundle, context)) {
      throw new Error(`${context}_SIGNATURE_INVALID:${frame.hash}:${signerId}`);
    }
  }
  return calculateQuorumPower(state.config, Array.from(signatures.keys())) >= state.config.threshold;
};

const getCertificateSignedVotes = (certificate: EntityLeaderCertificate): Map<string, EntityLeaderTimeoutVote> => {
  const compact = new Map<string, string>();
  for (const [rawSignerId, signature] of certificate.votes) {
    const signerId = rawSignerId.trim().toLowerCase();
    if (compact.has(signerId)) throw new Error(`ENTITY_LEADER_CERT_DUPLICATE_SIGNER:${rawSignerId}`);
    compact.set(signerId, signature);
  }
  if (certificate.preparedVotes) {
    const prepared = new Map<string, EntityLeaderTimeoutVote>();
    for (const [rawSignerId, vote] of certificate.preparedVotes) {
      const signerId = rawSignerId.trim().toLowerCase();
      if (prepared.has(signerId)) throw new Error(`ENTITY_LEADER_CERT_DUPLICATE_PREPARED_SIGNER:${rawSignerId}`);
      if (vote.voterId.trim().toLowerCase() !== signerId) {
        throw new Error(`ENTITY_LEADER_CERT_VOTER_KEY_MISMATCH:${rawSignerId}:${vote.voterId}`);
      }
      if (compact.get(signerId) !== vote.signature) {
        throw new Error(`ENTITY_LEADER_CERT_SIGNATURE_MAP_MISMATCH:${rawSignerId}`);
      }
      prepared.set(signerId, vote);
    }
    if (prepared.size !== compact.size) throw new Error('ENTITY_LEADER_CERT_PREPARED_VOTE_SET_MISMATCH');
    return prepared;
  }
  return new Map(
    Array.from(compact.entries()).map(([signerId, signature]) => [
      signerId,
      {
        entityId: certificate.entityId,
        targetHeight: certificate.targetHeight,
        previousFrameHash: certificate.previousFrameHash,
        fromView: certificate.fromView,
        toView: certificate.toView,
        previousLeaderId: certificate.previousLeaderId,
        nextLeaderId: certificate.nextLeaderId,
        voterId: signerId,
        signature,
      },
    ]),
  );
};

export const verifyEntityLeaderCertificate = (
  env: EntityRuntimeContext,
  state: EntityLeaderStateView,
  frame: ProposedEntityFrame,
): boolean => {
  const committedLeader = getEntityLeaderState(state);
  const proposedLeaderId = frame.leader.proposerSignerId.toLowerCase();
  const certificate = frame.leader.certificate;
  if (!certificate) {
    return proposedLeaderId === committedLeader.activeValidatorId && frame.leader.view === committedLeader.view;
  }
  try {
    assertEntityLeaderVoteMatchesState(state, certificate);
  } catch (error) {
    entityLog.warn('leader.certificate.stale', {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
  if (proposedLeaderId !== certificate.nextLeaderId || frame.leader.view !== certificate.toView) return false;
  const validSigners: string[] = [];
  let signedVotes: Map<string, EntityLeaderTimeoutVote>;
  try {
    signedVotes = getCertificateSignedVotes(certificate);
  } catch (error) {
    entityLog.warn('leader.certificate_vote_map_rejected', {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
  for (const [rawSignerId, vote] of signedVotes) {
    const signerId = rawSignerId.toLowerCase();
    if (!state.config.validators.some(validator => validator.toLowerCase() === signerId)) return false;
    if (vote.voterId.toLowerCase() !== signerId) return false;
    if (leaderVoteCollectionKey(vote) !== leaderVoteCollectionKey(certificate)) return false;
    if (!verifyAccountSignature(env, signerId, hashEntityLeaderVoteBody(vote), vote.signature)) return false;
    validSigners.push(signerId);
  }
  try {
    return calculateQuorumPower(state.config, validSigners) >= state.config.threshold;
  } catch (error) {
    entityLog.warn('leader.certificate_power_rejected', {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
};

type PreparedFrameGroup = {
  frame: ProposedEntityFrame;
  signatures: Map<string, string[]>;
};

const validatePreparedFrameEvidence = (
  env: EntityRuntimeContext,
  state: EntityLeaderStateView,
  certificate: EntityLeaderCertificate,
  evidence: ProposedEntityFrame,
): Map<string, string[]> => {
  if (evidence.height !== certificate.targetHeight) {
    throw new Error(`ENTITY_PREPARED_HEIGHT_MISMATCH:${evidence.height}:${certificate.targetHeight}`);
  }
  const expectedParent = state.height === 0 ? 'genesis' : String(state.prevFrameHash || '');
  if (evidence.parentFrameHash !== expectedParent) {
    throw new Error(`ENTITY_PREPARED_PARENT_MISMATCH:${evidence.parentFrameHash}:${expectedParent}`);
  }
  const recomputedHash = createEntityFrameHashFromStateRoot(
    evidence.parentFrameHash,
    evidence.height,
    evidence.timestamp,
    evidence.txs,
    evidence.events,
    state.entityId,
    evidence.stateRoot,
    evidence.authorityRoot,
    evidence.jPrefixCertificate,
  );
  if (recomputedHash !== evidence.hash) {
    throw new Error(`ENTITY_PREPARED_FRAME_HASH_MISMATCH:${recomputedHash}:${evidence.hash}`);
  }
  if (evidence.leader.relayCertificate) {
    throw new Error(`ENTITY_PREPARED_RELAY_CERTIFICATE_NESTED:${evidence.hash}`);
  }
  if (!verifyEntityLeaderCertificate(env, state, evidence)) {
    throw new Error(`ENTITY_PREPARED_LEADER_INVALID:${evidence.hash}:${evidence.leader.view}`);
  }
  const hashes = evidence.hashesToSign;
  if (!hashes?.length || hashes[0]?.type !== 'entityFrame' || hashes[0]?.hash !== evidence.hash) {
    throw new Error(`ENTITY_PREPARED_MANIFEST_INVALID:${evidence.hash}`);
  }
  const normalized = normalizePrecommitBundles(
    state.config,
    evidence.collectedSigs ?? new Map(),
    'ENTITY_PREPARED_EVIDENCE',
  );
  for (const [signerId, signatures] of normalized) {
    if (
      !verifyHashPrecommitSignatures(
        env,
        signerId,
        hashes,
        evidence.hash,
        evidence.height,
        signatures,
        'ENTITY_PREPARED_EVIDENCE',
      )
    ) {
      throw new Error(`ENTITY_PREPARED_SIGNATURE_INVALID:${evidence.hash}:${signerId}`);
    }
  }
  return normalized;
};

const mergePreparedFrameEvidence = (
  groups: Map<string, PreparedFrameGroup>,
  evidence: ProposedEntityFrame,
  signatures: Map<string, string[]>,
): void => {
  const group = groups.get(evidence.hash) ?? {
    frame: structuredClone(evidence),
    signatures: new Map<string, string[]>(),
  };
  if (
    encodeCanonicalConsensusValue({ ...group.frame, collectedSigs: undefined }) !==
    encodeCanonicalConsensusValue({ ...evidence, collectedSigs: undefined })
  ) {
    throw new Error(`ENTITY_PREPARED_BODY_CONFLICT:${evidence.hash}`);
  }
  for (const [signerId, signerSignatures] of signatures) {
    const existing = group.signatures.get(signerId);
    if (
      existing &&
      (existing.length !== signerSignatures.length ||
        existing.some((signature, index) => signature !== signerSignatures[index]))
    ) {
      throw new Error(`ENTITY_PREPARED_SIGNER_EQUIVOCATION:${evidence.hash}:${signerId}`);
    }
    group.signatures.set(signerId, signerSignatures);
  }
  groups.set(evidence.hash, group);
};

export const selectPreparedFrameFromCertificate = (
  env: EntityRuntimeContext,
  state: EntityLeaderStateView,
  certificate: EntityLeaderCertificate,
): ProposedEntityFrame | null => {
  const groups = new Map<string, PreparedFrameGroup>();
  let evidenceCount = 0;
  for (const vote of getCertificateSignedVotes(certificate).values()) {
    const evidence = vote.preparedFrame;
    if (!evidence) continue;
    evidenceCount += 1;
    const signatures = validatePreparedFrameEvidence(env, state, certificate, evidence);
    mergePreparedFrameEvidence(groups, evidence, signatures);
  }
  if (evidenceCount === 0) return null;

  const prepared = Array.from(groups.values()).filter(
    group => calculateQuorumPower(state.config, Array.from(group.signatures.keys())) >= state.config.threshold,
  );
  // A signed proposal below threshold is a vote, not a prepared certificate.
  // Requiring every partial vote to reach quorum would let a vanished proposer
  // permanently wedge view change after collecting only one validator vote.
  // Invalid bodies/signatures still fail above; only valid sub-threshold
  // evidence is safely abandoned by the certified higher view.
  if (prepared.length === 0) return null;
  const highestView = Math.max(...prepared.map(group => group.frame.leader.view));
  const highest = prepared.filter(group => group.frame.leader.view === highestView);
  if (highest.length !== 1) {
    throw new Error(`ENTITY_PREPARED_CONFLICTING_QUORUMS:view=${highestView}:count=${highest.length}`);
  }
  highest[0]!.frame.collectedSigs = new Map(
    Array.from(highest[0]!.signatures.entries()).sort(([left], [right]) => compareStableText(left, right)),
  );
  return highest[0]!.frame;
};

export const verifyEntityRelayCertificate = (
  env: EntityRuntimeContext,
  state: EntityLeaderStateView,
  frame: ProposedEntityFrame,
): boolean => {
  const relay = frame.leader.relayCertificate;
  if (!relay) return true;
  if (
    !verifyEntityLeaderCertificate(env, state, {
      ...frame,
      leader: {
        proposerSignerId: relay.nextLeaderId,
        view: relay.toView,
        certificate: relay,
      },
    })
  )
    return false;
  try {
    const selected = selectPreparedFrameFromCertificate(env, state, relay);
    return selected?.hash === frame.hash && relay.preparedFrameHash === frame.hash;
  } catch (error) {
    entityLog.warn('leader.relay_certificate_rejected', {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
};

export const expectedCommittedLeaderState = (
  state: EntityLeaderStateView,
  frame: ProposedEntityFrame,
): NonNullable<EntityState['leaderState']> => {
  const current = getEntityLeaderState(state);
  const certificate = frame.leader.certificate;
  return certificate
    ? {
        activeValidatorId: certificate.nextLeaderId,
        view: certificate.toView,
        changedAtHeight: frame.height,
      }
    : current;
};

export const getValidatorExecutionForFrame = (
  replica: EntityReplica,
  frame: ProposedEntityFrame,
): EntityCandidate | undefined => {
  const execution = replica.candidate;
  if (!execution) return undefined;
  if (
    execution.frameHash !== frame.hash ||
    execution.height !== frame.height ||
    execution.state.height !== frame.height
  ) {
    throw new Error(
      `ENTITY_VALIDATOR_EXECUTION_FRAME_MISMATCH:execution=${execution.height}:${execution.frameHash}:` +
        `frame=${frame.height}:${frame.hash}`,
    );
  }
  return execution;
};

const buildCrossJurisdictionFillNoticeTx = (
  tx: CrossSwapFillAckTx,
  accountId: string,
): CrossJurisdictionFillNoticeTx => {
  const fillSeq = Math.floor(Number(tx.data.fillSeq ?? 0));
  const cumulativeFillRatio = Math.floor(Number(tx.data.cumulativeFillRatio ?? 0));
  if (fillSeq <= 0 || cumulativeFillRatio <= 0) {
    throw new Error(
      `CROSS_J_FILL_ACK_INVALID_NOTICE: account=${accountId} offer=${tx.data.offerId} ` +
        `fillSeq=${fillSeq} ratio=${cumulativeFillRatio}`,
    );
  }
  return {
    type: 'crossJurisdictionFillNotice',
    data: {
      orderId: tx.data.offerId,
      ...(tx.data.routeHash ? { routeHash: tx.data.routeHash } : {}),
      ...(tx.data.previousFillSeq !== undefined
        ? { previousFillSeq: Math.floor(Number(tx.data.previousFillSeq)) }
        : {}),
      fillSeq,
      incrementalSourceAmount: tx.data.incrementalSourceAmount ?? tx.data.executionSourceAmount ?? 0n,
      incrementalTargetAmount: tx.data.incrementalTargetAmount ?? tx.data.executionTargetAmount ?? 0n,
      cumulativeSourceAmount: tx.data.cumulativeSourceAmount ?? 0n,
      cumulativeTargetAmount: tx.data.cumulativeTargetAmount ?? 0n,
      cumulativeFillRatio,
      ...(tx.data.fillNumerator !== undefined ? { fillNumerator: tx.data.fillNumerator } : {}),
      ...(tx.data.fillDenominator !== undefined ? { fillDenominator: tx.data.fillDenominator } : {}),
      ...(tx.data.priceImprovementMode ? { priceImprovementMode: tx.data.priceImprovementMode } : {}),
      ...(tx.data.priceImprovementAmount !== undefined
        ? { priceImprovementAmount: tx.data.priceImprovementAmount }
        : {}),
      ...(tx.data.priceImprovementTokenId !== undefined
        ? { priceImprovementTokenId: tx.data.priceImprovementTokenId }
        : {}),
      ...(tx.data.cancelRemainder !== undefined ? { cancelRemainder: tx.data.cancelRemainder } : {}),
      ...(tx.data.priceTicks !== undefined ? { priceTicks: tx.data.priceTicks } : {}),
      pairId: String(tx.data.pairId || ''),
    },
  };
};

const buildCrossJurisdictionAdmissionFillNoticeOutput = (
  currentEntityState: EntityState,
  accountId: string,
  tx: CrossSwapFillAckTx,
): EntityInput | null => {
  const admission = findCrossJurisdictionBookAdmissionForAck(
    currentEntityState,
    accountId,
    tx.data.offerId,
    tx.data.routeHash,
  );
  if (!admission) return null;
  if (admission.status === 'closed' || admission.status === 'resolving') return null;
  const sourceHubEntityId = normalizeEntityRef(admission.route.source.counterpartyEntityId);
  if (!sourceHubEntityId) {
    throw new Error(`CROSS_J_FILL_ACK_SOURCE_HUB_MISSING: account=${accountId} offer=${tx.data.offerId}`);
  }
  if (sourceHubEntityId === normalizeEntityRef(currentEntityState.entityId)) return null;
  const hintedSignerRaw = String(admission.route.sourceHubSignerId || '');
  if (!normalizeEntityRef(hintedSignerRaw)) {
    throw new Error(
      `CROSS_J_FILL_ACK_SOURCE_HUB_SIGNER_MISSING: account=${accountId} offer=${tx.data.offerId} ` +
        `sourceHub=${sourceHubEntityId}`,
    );
  }
  return {
    entityId: sourceHubEntityId,
    signerId: hintedSignerRaw,
    entityTxs: [buildCrossJurisdictionFillNoticeTx(tx, accountId)],
    localRuntimeProtocol: 'cross-j',
  };
};

export const buildCrossJurisdictionFillNoticeOutput = (
  currentEntityState: EntityState,
  accountId: string,
  tx: CrossSwapFillAckTx,
): EntityInput | null => {
  return buildCrossJurisdictionAdmissionFillNoticeOutput(currentEntityState, accountId, tx);
};

const pendingCrossJurisdictionFillAckKey = (accountId: string, tx: CrossSwapFillAckTx): string =>
  [
    normalizeEntityRef(accountId),
    tx.data.offerId,
    Math.floor(Number(tx.data.fillSeq ?? 0)),
    Math.floor(Number(tx.data.cumulativeFillRatio ?? 0)),
    tx.data.cumulativeSourceAmount?.toString() ?? '',
    tx.data.cumulativeTargetAmount?.toString() ?? '',
  ].join('|');

export const ownsSourceHubRouteForFillAck = (currentEntityState: EntityState, tx: CrossSwapFillAckTx): boolean => {
  const route = currentEntityState.crossJurisdictionSwaps?.get(tx.data.offerId);
  if (!route) return false;
  return normalizeEntityRef(route.source.counterpartyEntityId) === normalizeEntityRef(currentEntityState.entityId);
};

export const stashPendingCrossJurisdictionFillAck = (
  env: EntityRuntimeContext,
  currentEntityState: EntityState,
  accountId: string,
  tx: CrossSwapFillAckTx,
  reason: string,
): void => {
  currentEntityState.pendingCrossJurisdictionFillAcks ||= new Map();
  const key = pendingCrossJurisdictionFillAckKey(accountId, tx);
  if (currentEntityState.pendingCrossJurisdictionFillAcks.has(key)) return;
  if (currentEntityState.pendingCrossJurisdictionFillAcks.size >= MAX_PENDING_CROSS_J_FILL_ACKS) {
    throw new Error(
      `CROSS_J_FILL_ACK_PENDING_CAPACITY: entity=${currentEntityState.entityId} ` +
        `account=${accountId} offer=${tx.data.offerId} max=${MAX_PENDING_CROSS_J_FILL_ACKS}`,
    );
  }
  currentEntityState.pendingCrossJurisdictionFillAcks.set(key, {
    accountId,
    tx: cloneCrossJurisdictionAccountTxRoute(tx) as CrossSwapFillAckTx,
    storedAt: currentEntityState.timestamp || env.timestamp,
    reason,
  });
  entityLog.info('crossj.fill_ack_deferred', {
    entity: shortId(currentEntityState.entityId, 8),
    account: shortId(accountId, 8),
    offer: shortOrder(tx.data.offerId, 8),
    reason,
  });
};

const admitGeneratedAccountTx = async (
  accountConsensusContext: AccountConsensusContext,
  state: EntityState,
  account: AccountReplica,
  tx: AccountTx,
): Promise<boolean> => {
  const result = await applyAccountInput(
    accountConsensusContext,
    account,
    createLocalAccountInput(account, state.entityId, [tx]),
  );
  return result.admittedAccountTxCount === 1;
};

type PendingCrossJurisdictionFillAck =
  NonNullable<EntityState['pendingCrossJurisdictionFillAcks']> extends Map<string, infer Value> ? Value : never;

const queueCrossJFillAckIncidentEffect = (
  candidateEffects: EntityCandidateEffect[],
  kind: 'securityIncidentRecord' | 'securityIncidentResolve',
  state: EntityState,
  pendingAck: PendingCrossJurisdictionFillAck,
): void => {
  candidateEffects.push({
    kind,
    identity: {
      domain: 'cross-j',
      code: 'CROSS_J_FILL_ACK_TTL_EXPIRED',
      source: 'local-consensus',
      severity: 'critical',
      summary: 'A committed sibling fill acknowledgement has no matching local source offer',
      entityId: state.entityId,
      accountId: pendingAck.accountId,
      offerId: pendingAck.tx.data.offerId,
      routeHash: pendingAck.tx.data.routeHash || '',
    },
  });
};

export const drainPendingCrossJurisdictionFillAcks = async (
  env: EntityRuntimeContext,
  accountConsensusContext: AccountConsensusContext,
  currentEntityState: EntityState,
  proposableAccounts: Set<string>,
  storageChanges: RuntimeOverlayRecord[],
  candidateEffects: EntityCandidateEffect[],
): Promise<number> => {
  const pending = currentEntityState.pendingCrossJurisdictionFillAcks;
  if (!pending || pending.size === 0) return 0;
  const now = Number(currentEntityState.timestamp || env.timestamp || 0);
  let drained = 0;
  for (const [key, pendingAck] of Array.from(pending.entries()).sort(([a], [b]) => compareStableText(a, b))) {
    const ageMs = Math.max(0, now - Number(pendingAck.storedAt || 0));
    if (ageMs > CROSS_J_PENDING_FILL_ACK_TTL_MS && !pendingAck.ttlExpiredAt) {
      const payload = {
        entityId: currentEntityState.entityId,
        accountId: pendingAck.accountId,
        offerId: pendingAck.tx.data.offerId,
        routeHash: pendingAck.tx.data.routeHash || '',
        fillSeq: pendingAck.tx.data.fillSeq,
        previousFillSeq: pendingAck.tx.data.previousFillSeq,
        fillId: buildCrossJurisdictionFillId({
          routeHash: pendingAck.tx.data.routeHash || '',
          offerId: pendingAck.tx.data.offerId,
          ...(pendingAck.tx.data.fillSeq !== undefined ? { fillSeq: pendingAck.tx.data.fillSeq } : {}),
          cumulativeFillRatio: pendingAck.tx.data.cumulativeFillRatio,
          ...(pendingAck.tx.data.cumulativeSourceAmount !== undefined
            ? { cumulativeSourceAmount: pendingAck.tx.data.cumulativeSourceAmount }
            : {}),
          ...(pendingAck.tx.data.cumulativeTargetAmount !== undefined
            ? { cumulativeTargetAmount: pendingAck.tx.data.cumulativeTargetAmount }
            : {}),
        }),
        ackKind: pendingAck.tx.data.ackKind || (pendingAck.tx.data.cancelRemainder ? 'cancel_or_fill' : 'fill'),
        cumulativeFillRatio: pendingAck.tx.data.cumulativeFillRatio,
        cumulativeSourceAmount: pendingAck.tx.data.cumulativeSourceAmount?.toString() ?? '',
        cumulativeTargetAmount: pendingAck.tx.data.cumulativeTargetAmount?.toString() ?? '',
        fillNumerator: pendingAck.tx.data.fillNumerator?.toString() ?? '',
        fillDenominator: pendingAck.tx.data.fillDenominator?.toString() ?? '',
        storedAt: pendingAck.storedAt,
        ageMs,
        ttlMs: CROSS_J_PENDING_FILL_ACK_TTL_MS,
        reason: pendingAck.reason ?? 'unknown',
        repairProtocol: {
          classification: 'unexpected_cross_j_fill_ack_without_local_source_offer',
          preserveEvidence: true,
          operatorAction:
            'Inspect the source-hub route, account swapOffers, pending frames, and book-owner admission before replaying or voiding this order.',
          forbiddenAction:
            'Do not delete this pending ack silently; it is evidence for a possible cross-j state divergence.',
        },
      };
      pendingAck.ttlExpiredAt = now;
      queueCrossJFillAckIncidentEffect(candidateEffects, 'securityIncidentRecord', currentEntityState, pendingAck);
      entityLog.warn('crossj.fill_ack_ttl_expired_preserved', payload);
    }
    const account = currentEntityState.accounts.get(pendingAck.accountId);
    if (!account?.swapOffers?.has(pendingAck.tx.data.offerId)) continue;
    if (await admitGeneratedAccountTx(accountConsensusContext, currentEntityState, account, pendingAck.tx)) {
      proposableAccounts.add(pendingAck.accountId);
      storageChanges.push({
        family: 'account',
        entityId: currentEntityState.entityId,
        counterpartyId: pendingAck.accountId,
      });
    }
    if (pendingAck.ttlExpiredAt !== undefined) {
      queueCrossJFillAckIncidentEffect(candidateEffects, 'securityIncidentResolve', currentEntityState, pendingAck);
    }
    pending.delete(key);
    drained++;
    entityLog.info('crossj.fill_ack_drained', {
      entity: shortId(currentEntityState.entityId, 8),
      account: shortId(pendingAck.accountId, 8),
      offer: shortOrder(pendingAck.tx.data.offerId, 8),
      storedAt: pendingAck.storedAt,
    });
  }
  return drained;
};

export const drainCommittedCrossJurisdictionCancelAcks = async (
  accountConsensusContext: AccountConsensusContext,
  currentEntityState: EntityState,
  proposableAccounts: Set<string>,
  storageChanges: RuntimeOverlayRecord[],
): Promise<number> => {
  let queued = 0;
  for (const { accountId, tx } of collectCommittedCrossJurisdictionCancelAcks(currentEntityState)) {
    if (tx.type !== 'cross_swap_fill_ack') {
      throw new Error(`CROSS_J_CANCEL_ACK_TX_INVALID:account=${accountId}:type=${tx.type}`);
    }
    const account = currentEntityState.accounts.get(accountId);
    if (!account) {
      throw new Error(`CROSS_J_CANCEL_ACK_ACCOUNT_MISSING:account=${accountId}:offer=${tx.data.offerId}`);
    }
    if (!(await admitGeneratedAccountTx(accountConsensusContext, currentEntityState, account, tx))) continue;
    proposableAccounts.add(accountId);
    storageChanges.push({
      family: 'account',
      entityId: currentEntityState.entityId,
      counterpartyId: accountId,
    });
    queued += 1;
  }
  return queued;
};
