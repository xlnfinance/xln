import { encodeCanonicalConsensusValue } from '../../protocol/canonical-consensus-value';
/**
 * Entity consensus: validator replicas agree on entity frames, then route
 * committed account/J-layer side effects back into the runtime.
 */

import { verifyAccountSignature } from '../../account/crypto';
import { LIMITS } from '../../config/constants';
import { buildCrossJurisdictionFillId, CROSS_J_PENDING_FILL_ACK_TTL_MS } from '../../extensions/cross-j/fill-ack';
import { cloneCrossJurisdictionAccountTxRoute } from '../../extensions/cross-j/index';
import { getEntityConfigBoardHash } from '../../hanko/signing';
import { createStructuredLogger, logError, shortId, shortOrder } from '../../infra/logger';
import { isRuntimePerfProfileEnabled, readRuntimePerfSlowMs } from '../../infra/perf-runtime-flags';
import { getCertifiedBoardNodeStore, resolveObserverCertifiedBoardRecord } from '../../jurisdiction/board-registry';
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
import { getEntityFrameJRangeBudgetError, selectEntityTxsWithinJRangeBudget } from '../../jurisdiction/range-budget';
import {
  deterministicEntityTimestamp,
  findAccountByCounterparty,
  findCrossJurisdictionBookAdmissionForAck,
  getCrossJurisdictionBookAdmissionError,
  isCrossJurisdictionBookAdmissionPending,
  normalizeEntityRef,
} from '../../orderbook/cross-j-orderbook';
import {
  markWorkingOrderbookOffer,
  type NormalizedOrderbookOffer,
  type WorkingOrderbookOffer,
} from '../../orderbook/swap-execution';
import { cloneIsolatedProposedEntityFrame } from '../../protocol/runtime-input-clone';
import { compareStableText, safeStringify } from '../../protocol/serialization';
import { nodeProcess } from '../../infra/runtime-process';
import type {
  AccountTx,
  AccountReplica,
  CertifiedEntityFrameLink,
  ConsensusConfig,
  ConsensusOutputOrigin,
  EntityFrameAuthority,
  EntityCandidateEffect,
  EntityInput,
  EntityOutput,
  EntityLeaderCertificate,
  EntityLeaderTimeoutVote,
  EntityReplica,
  EntityState,
  EntityTx,
  RuntimeState,
  HankoString,
  HashToSign,
  ProposedEntityFrame,
  RuntimeOverlayRecord,
  EntityCandidate,
} from '../../types';
import { log } from '../../infra/diagnostics';
import { validateProposedEntityFrame } from './frame-validation';
import {
  applyConsumptionOutput,
  createConsumptionProof,
  createEmptyConsumptionAccumulator,
  getConsumptionKey,
  type ConsumptionNode,
  type ConsumptionOutputIdentity,
} from '../consumption-accumulator';
import { getConsumptionNodeStore } from '../consumption-store';
import { selectCrossJCommitPhaseTxs } from '../cross-j-proposer-materialization';
import { emitDefaultProposerHtlcOnionAdvances } from '../htlc-onion-post-commit';
import { collectCommittedCrossJurisdictionCancelAcks } from '../tx/handlers/account';
import { applyAccountInput } from '../../account/consensus';
import { createLocalAccountInput } from '../../account/input';
import { createEntityFrameHashFromStateRoot, selectEntityFrameTxByteBudget } from './frame';
import {
  assertEntityLeaderVoteMatchesState,
  getEntityLeaderState,
  hashEntityLeaderVoteBody,
  isEntityActiveLeader,
  leaderVoteCollectionKey,
  type EntityLeaderStateView,
} from './leader';
import {
  assertCertifiedOutputSemanticIdentity,
  buildCertifiedEntityOutputHashes,
  buildConsensusOutputOriginForState,
  hashCertifiedEntityOutput,
  isLocalRuntimeProtocolOutput,
  isNonMutatingEntityWakeOutput,
  normalizeConsensusOutputOrigin,
  resolveConsensusOutputBoardAuthority,
} from './output-certification';
import { orderCertifiedOutputsBySequence } from './output-envelope';
import { classifyEntityConsensusStateQuotaTransition, measureEntityConsensusStateBytes } from './state-quota';
import {
  buildEntityFrameAuthority,
  computeCanonicalEntityConsensusStateHash,
  computeEntityFrameAuthorityRoot,
} from './state-root';

export { CROSS_J_PENDING_FILL_ACK_TTL_MS } from '../../extensions/cross-j/fill-ack';
export { createEntityFrameHash } from './frame';
export { mergeEntityInputs, prioritizeEntityConsensusInputs, prioritizeProtocolEntityInputs } from './input-merge';

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
  env: RuntimeState,
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
  env: RuntimeState,
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
  env: RuntimeState,
  replica: EntityReplica,
  txs: EntityTx[],
): void => {
  const error = getReplicaJRangeValidationError(env, replica, txs);
  if (error) throw new Error(`ENTITY_PROPOSER_J_RANGE_INVALID:${error}`);
};

export const getFrameJPrefixValidationError = (
  env: RuntimeState,
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
  env: RuntimeState,
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
  env: RuntimeState,
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
  env: RuntimeState,
  replica: EntityReplica,
  entityOutbox: EntityOutput[],
): Promise<void> => {
  advanceLocalJPrefixRoundAfterCommit(env, replica, entityOutbox);
  await emitDefaultProposerHtlcOnionAdvances(env, replica, entityOutbox);
};

type EntityAccountState = EntityState['accounts'] extends Map<string, infer T> ? T : never;
type CrossSwapFillAckTx = Extract<AccountTx, { type: 'cross_swap_fill_ack' }>;
type CrossJurisdictionFillNoticeTx = Extract<EntityTx, { type: 'crossJurisdictionFillNotice' }>;

const hasQueuedOrderLifecycleTx = (account: EntityAccountState, offerId: string): boolean => {
  for (const tx of account.mempool ?? []) {
    if (
      (tx.type === 'swap_resolve' || tx.type === 'cross_swap_fill_ack' || tx.type === 'swap_cancel_request') &&
      tx.data.offerId === offerId
    ) {
      return true;
    }
  }
  for (const tx of account.pendingFrame?.accountTxs ?? []) {
    if (
      (tx.type === 'swap_resolve' || tx.type === 'cross_swap_fill_ack' || tx.type === 'swap_cancel_request') &&
      tx.data.offerId === offerId
    ) {
      return true;
    }
  }
  return false;
};

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
  env: RuntimeState,
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
  env: RuntimeState,
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
  env: RuntimeState,
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
  env: RuntimeState,
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
  env: RuntimeState,
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
  env: RuntimeState,
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

export const buildConsumptionOutputIdentity = (
  origin: ConsensusOutputOrigin,
  targetEntityId: string,
  outputHash: string,
  outputHanko: string,
): ConsumptionOutputIdentity => ({
  targetEntityId,
  sourceEntityId: origin.sourceEntityId,
  lane: origin.lane,
  sequence: origin.sequence,
  semanticHash: origin.semanticHash,
  outputHash,
  outputHanko,
});

/**
 * The source certifies only origin + target + nested effects. The target
 * proposer adds a witness from its own pre-state; validators never trust a
 * proof supplied by the source or transport.
 */
export const attachTargetConsumptionProofs = (
  env: RuntimeState,
  state: EntityState,
  txs: readonly EntityTx[],
): EntityTx[] => {
  let accumulator = state.consumptionAccumulator ?? createEmptyConsumptionAccumulator();
  const overlay = new Map<string, ConsumptionNode>(getConsumptionNodeStore(env));
  const selected: EntityTx[] = [];
  for (const tx of orderCertifiedOutputsBySequence(txs)) {
    if (tx.type !== 'consensusOutput') {
      selected.push(tx);
      continue;
    }
    const origin = normalizeConsensusOutputOrigin(tx.data.origin);
    const targetEntityId = String(tx.data.targetEntityId ?? '')
      .trim()
      .toLowerCase();
    const outputHash = hashCertifiedEntityOutput(origin, targetEntityId, tx.data.entityTxs);
    assertCertifiedOutputSemanticIdentity(origin, targetEntityId, tx.data.entityTxs);
    const identity = buildConsumptionOutputIdentity(origin, targetEntityId, outputHash, tx.data.outputHanko);
    const key = getConsumptionKey(identity);
    const proof = createConsumptionProof(overlay, accumulator.root, key);
    const applied = applyConsumptionOutput(accumulator, identity, proof);
    if (applied.status === 'gap') {
      entityLog.warn('consensus_output.sequence_gap_deferred', {
        sourceEntityId: origin.sourceEntityId,
        targetEntityId,
        lane: origin.lane,
        received: origin.sequence.toString(),
      });
      continue;
    }
    if (applied.status === 'quarantined' && applied.newNodes.length === 0) {
      logError('FRAME_CONSENSUS', 'Certified output excluded for quarantined relationship', {
        sourceEntityId: origin.sourceEntityId,
        targetEntityId,
        lane: origin.lane,
      });
      continue;
    }
    for (const { hash, node } of applied.newNodes) overlay.set(hash, node);
    for (const hash of applied.replacedNodeHashes) overlay.delete(hash);
    accumulator = applied.state;
    selected.push({
      ...structuredClone(tx),
      data: { ...structuredClone(tx.data), consumptionProof: proof },
    });
  }
  return selected;
};

export const wrapCertifiedEntityOutputs = (
  outputs: EntityOutput[],
  frame: ProposedEntityFrame,
  sourceState: EntityState,
  env: RuntimeState,
  hashesToSign: HashToSign[],
  hankos: HankoString[],
  emitLocalRuntimeOutputs: boolean,
): EntityOutput[] => {
  const outputHashes = buildCertifiedEntityOutputHashes(sourceState, env, frame.height, frame.hash, outputs);
  return outputs.flatMap((output, outputIndex): EntityOutput[] => {
    if (isNonMutatingEntityWakeOutput(output)) return [structuredClone(output)];
    if (isLocalRuntimeProtocolOutput(output)) {
      if (!emitLocalRuntimeOutputs) return [];
      const targetEntityId = output.entityId.trim().toLowerCase();
      const localTarget = Array.from(env.eReplicas.values()).some(
        replica =>
          replica.entityId.toLowerCase() === targetEntityId &&
          replica.signerId.toLowerCase() === output.signerId.toLowerCase(),
      );
      if (!localTarget) {
        throw new Error(`RUNTIME_OUTPUT_TARGET_NOT_LOCAL:${targetEntityId}:${output.signerId}`);
      }
      if (!output.entityTxs?.length) throw new Error(`RUNTIME_OUTPUT_ENTITY_TXS_MISSING:index=${outputIndex}`);
      return [
        {
          entityId: targetEntityId,
          signerId: output.signerId.toLowerCase(),
          entityTxs: [
            {
              type: 'runtimeOutput',
              data: {
                protocol: 'cross-j',
                sourceEntityId: sourceState.entityId.toLowerCase(),
                targetEntityId,
                entityTxs: structuredClone(output.entityTxs),
              },
            },
          ],
        },
      ];
    }
    const outputHash = outputHashes.find(
      hashInfo => hashInfo.context === `entity-output:${frame.height}:${outputIndex}`,
    );
    if (!outputHash) throw new Error(`CONSENSUS_OUTPUT_HASH_MISSING:index=${outputIndex}`);
    const manifestIndex = hashesToSign.findIndex(
      hashInfo =>
        hashInfo.type === 'entityOutput' &&
        hashInfo.hash.toLowerCase() === outputHash.hash.toLowerCase() &&
        hashInfo.context === outputHash.context,
    );
    if (manifestIndex < 0) {
      throw new Error(`CONSENSUS_OUTPUT_MANIFEST_ENTRY_MISSING:index=${outputIndex}:hash=${outputHash.hash}`);
    }
    const outputHanko = hankos[manifestIndex];
    if (!outputHanko) {
      throw new Error(`CONSENSUS_OUTPUT_HANKO_MISSING:index=${outputIndex}:hash=${outputHash.hash}`);
    }
    const semanticIdentity = output.certifiedOutputIdentity;
    if (!semanticIdentity) throw new Error(`CONSENSUS_OUTPUT_SEMANTIC_IDENTITY_MISSING:index=${outputIndex}`);
    const origin = buildConsensusOutputOriginForState(
      sourceState,
      env,
      frame.height,
      frame.hash,
      outputIndex,
      semanticIdentity,
    );
    const targetEntityId = output.entityId.toLowerCase();
    const entityTxs = output.entityTxs;
    if (!entityTxs) throw new Error(`CONSENSUS_OUTPUT_ENTITY_TXS_MISSING:index=${outputIndex}`);
    const routedOutput = structuredClone(output);
    delete routedOutput.certifiedOutputIdentity;
    return [
      {
        ...routedOutput,
        entityTxs: [
          {
            type: 'consensusOutput',
            data: {
              origin,
              outputHanko,
              targetEntityId,
              entityTxs: structuredClone(entityTxs),
            },
          },
        ],
      },
    ];
  });
};

const FOUNDATION_ENTITY_ID = `0x${'0'.repeat(63)}1`;

const getSelfAuthorityTargetFromJRange = (
  tx: Extract<EntityTx, { type: 'j_event' }>,
  entityId: string,
): string | null => {
  const normalizedEntityId = entityId.toLowerCase();
  let target: string | null = null;
  for (const block of tx.data.blocks) {
    for (const event of block.events) {
      if (event.type === 'FoundationBootstrapped' && normalizedEntityId === FOUNDATION_ENTITY_ID) {
        target = event.data.boardHash.toLowerCase();
      } else if (
        (event.type === 'EntityRegistered' || event.type === 'BoardActivated') &&
        event.data.entityId.toLowerCase() === normalizedEntityId
      ) {
        target = (event.type === 'EntityRegistered' ? event.data.boardHash : event.data.newBoardHash).toLowerCase();
      }
    }
  }
  return target;
};

export type ProposableEntityTxSelection = {
  txs: EntityTx[];
  currentAuthorityReady: boolean;
  reason?: string;
};

const applyJRangeBudgetToSelection = (selection: ProposableEntityTxSelection): ProposableEntityTxSelection => {
  const budgeted = selectEntityTxsWithinJRangeBudget(selection.txs);
  const frameBudgetedTxs = selectEntityFrameTxByteBudget(budgeted.txs);
  const deferredByFrameBytes = frameBudgetedTxs.length !== budgeted.txs.length;
  if (budgeted.deferredJRangeCount === 0 && !deferredByFrameBytes) return selection;
  return {
    ...selection,
    txs: frameBudgetedTxs,
    ...(selection.reason
      ? {}
      : { reason: deferredByFrameBytes ? 'ENTITY_FRAME_BYTE_BUDGET_DEFERRED' : 'J_RANGE_FRAME_BUDGET_DEFERRED' }),
  };
};

/**
 * Registered Entities cannot use their local config as bootstrap authority.
 * Before registration (and during rotation handover), only the exact J-range
 * whose post-state certifies that config may be proposed. An output waiting on
 * a remote authority prefix stays durable in this replica's mempool while a J
 * prerequisite frame advances independently.
 */
export const selectProposableEntityTxs = async (
  env: RuntimeState,
  state: EntityState,
  mempool: EntityTx[],
): Promise<ProposableEntityTxSelection> => {
  const configBoardHash = await getEntityConfigBoardHash(env, state.config);
  const normalizedEntityId = state.entityId.toLowerCase();
  const selfRecord = resolveObserverCertifiedBoardRecord(state, getCertifiedBoardNodeStore(env), normalizedEntityId);
  const currentAuthorityReady = configBoardHash === normalizedEntityId || selfRecord?.boardHash === configBoardHash;
  const jRanges = mempool.filter((tx): tx is Extract<EntityTx, { type: 'j_event' }> => tx.type === 'j_event');
  const selfAuthorityRanges = jRanges
    .map(tx => ({ tx, target: getSelfAuthorityTargetFromJRange(tx, normalizedEntityId) }))
    .filter((entry): entry is { tx: Extract<EntityTx, { type: 'j_event' }>; target: string } => Boolean(entry.target));

  if (selfAuthorityRanges.length > 0) {
    const latestTarget = selfAuthorityRanges.at(-1)!.target;
    if (latestTarget !== configBoardHash) {
      return { txs: [], currentAuthorityReady, reason: 'SELF_BOARD_CONFIG_HANDOVER_REQUIRED' };
    }
    return applyJRangeBudgetToSelection({
      txs: selfAuthorityRanges.map(entry => entry.tx),
      currentAuthorityReady,
      reason: currentAuthorityReady ? 'SELF_BOARD_ROTATION_PRIORITY' : 'SELF_BOARD_BOOTSTRAP_PRIORITY',
    });
  }

  if (!currentAuthorityReady) {
    return { txs: [], currentAuthorityReady: false, reason: 'SELF_BOARD_CERTIFICATION_REQUIRED' };
  }

  let blockedOutput = false;
  for (const tx of mempool) {
    if (tx.type !== 'consensusOutput') continue;
    const origin = normalizeConsensusOutputOrigin(tx.data.origin);
    const authority = resolveConsensusOutputBoardAuthority(origin, state, env);
    if (authority.kind === 'defer') blockedOutput = true;
  }
  if (!blockedOutput) {
    const phaseSelection = selectCrossJCommitPhaseTxs(mempool);
    return applyJRangeBudgetToSelection({
      txs: attachTargetConsumptionProofs(env, state, phaseSelection.txs),
      currentAuthorityReady: true,
      ...(phaseSelection.deferredCrossJSetup ? { reason: 'CROSS_J_ACCOUNT_COMMIT_PRIORITY' } : {}),
    });
  }
  if (jRanges.length > 0) {
    return applyJRangeBudgetToSelection({
      txs: [jRanges[0]!],
      currentAuthorityReady: true,
      reason: 'OUTPUT_BOARD_CATCH_UP_PRIORITY',
    });
  }
  return { txs: [], currentAuthorityReady: true, reason: 'OUTPUT_BOARD_CATCH_UP_REQUIRED' };
};

export const isSelfBoardAuthorityTransitionFrame = async (
  env: RuntimeState,
  state: EntityState,
  entityTxs: EntityTx[],
): Promise<boolean> => {
  if (entityTxs.length === 0 || entityTxs.some(tx => tx.type !== 'j_event')) return false;
  const configBoardHash = await getEntityConfigBoardHash(env, state.config);
  if (configBoardHash === state.entityId.toLowerCase()) return false;
  const current = resolveObserverCertifiedBoardRecord(state, getCertifiedBoardNodeStore(env), state.entityId);
  if (current?.boardHash === configBoardHash) return false;
  const finalTarget = entityTxs
    .map(tx => getSelfAuthorityTargetFromJRange(tx as Extract<EntityTx, { type: 'j_event' }>, state.entityId))
    .filter((target): target is string => Boolean(target))
    .at(-1);
  return finalTarget === configBoardHash;
};

export const validateProposedFrameLeader = (
  env: RuntimeState,
  state: EntityState,
  frame: ProposedEntityFrame,
): boolean => {
  return Boolean(
    frame.leader && verifyEntityLeaderCertificate(env, state, frame) && verifyEntityRelayCertificate(env, state, frame),
  );
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
  env: RuntimeState,
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
  env: RuntimeState,
  state: EntityState,
  account: AccountReplica,
  tx: AccountTx,
): Promise<boolean> => {
  const result = await applyAccountInput(env, account, createLocalAccountInput(account, state.entityId, [tx]));
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
  env: RuntimeState,
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
    if (await admitGeneratedAccountTx(env, currentEntityState, account, pendingAck.tx)) {
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
  env: RuntimeState,
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
    if (!(await admitGeneratedAccountTx(env, currentEntityState, account, tx))) continue;
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

const assertCommittedSwapOfferMatchesEvent = (
  state: EntityState,
  offer: NormalizedOrderbookOffer,
): EntityAccountState => {
  const account = findAccountByCounterparty(state, offer.accountId);
  const committedOffer = account?.swapOffers?.get(offer.offerId);
  if (!account || !committedOffer) {
    throw new Error(`ORDERBOOK_ORDER_NOT_COMMITTED: account=${offer.accountId} offer=${offer.offerId}`);
  }
  if (hasQueuedOrderLifecycleTx(account, offer.offerId)) {
    throw new Error(`ORDERBOOK_ORDER_NOT_READY: account=${offer.accountId} offer=${offer.offerId}`);
  }
  const committedPriceTicks = committedOffer.priceTicks ?? offer.priceTicks;
  if (
    committedOffer.giveTokenId !== offer.giveTokenId ||
    committedOffer.wantTokenId !== offer.wantTokenId ||
    (committedOffer.quantizedGive ?? committedOffer.giveAmount) !== (offer.quantizedGive ?? offer.giveAmount) ||
    (committedOffer.quantizedWant ?? committedOffer.wantAmount) !== (offer.quantizedWant ?? offer.wantAmount) ||
    committedPriceTicks !== offer.priceTicks ||
    committedOffer.makerIsLeft !== offer.makerIsLeft ||
    Boolean(committedOffer.crossJurisdiction) !== Boolean(offer.crossJurisdiction)
  ) {
    throw new Error(`ORDERBOOK_ORDER_COMMITTED_MISMATCH: account=${offer.accountId} offer=${offer.offerId}`);
  }
  return account;
};

const assertSameJurisdictionOrderHoldCommitted = (
  account: EntityAccountState,
  offer: NormalizedOrderbookOffer,
): void => {
  const committedOffer = account.swapOffers.get(offer.offerId);
  if (!committedOffer) {
    throw new Error(`ORDERBOOK_ORDER_NOT_COMMITTED: account=${offer.accountId} offer=${offer.offerId}`);
  }
  const delta = account.deltas?.get(committedOffer.giveTokenId);
  const requiredHold = committedOffer.quantizedGive ?? committedOffer.giveAmount;
  const committedHold = committedOffer.makerIsLeft ? (delta?.leftHold ?? 0n) : (delta?.rightHold ?? 0n);
  if (requiredHold <= 0n || committedHold < requiredHold) {
    throw new Error(
      `ORDERBOOK_ORDER_HOLD_NOT_COMMITTED: account=${offer.accountId} offer=${offer.offerId} ` +
        `required=${requiredHold.toString()} committed=${committedHold.toString()}`,
    );
  }
};

export const admitOrderbookOfferForMatching = (
  env: RuntimeState,
  state: EntityState,
  offer: NormalizedOrderbookOffer,
): WorkingOrderbookOffer | null => {
  if (offer.crossJurisdiction) {
    const crossStatus = offer.crossJurisdiction.status;
    if (crossStatus !== 'resting' && crossStatus !== 'partially_filled') {
      throw new Error(`CROSS_J_ORDERBOOK_ROUTE_NOT_WORKING: offer=${offer.offerId} status=${crossStatus}`);
    }
    const account = findAccountByCounterparty(state, offer.accountId);
    if ((account?.status ?? 'active') !== 'active') return null;
    if (account?.swapOffers?.has(offer.offerId)) {
      assertCommittedSwapOfferMatchesEvent(state, offer);
    }
    // Cross-j orders are allowed into the shared matcher only after both
    // bilateral account frames committed their source/target pull_lock receipts.
    const admissionError = getCrossJurisdictionBookAdmissionError(
      state,
      offer.crossJurisdiction,
      deterministicEntityTimestamp(state, env),
    );
    if (admissionError) {
      if (isCrossJurisdictionBookAdmissionPending(admissionError)) {
        entityLog.debug('crossj.orderbook.admission_pending', {
          offer: shortOrder(offer.offerId, 8),
          reason: admissionError,
        });
        return null;
      }
      throw new Error(admissionError);
    }
  } else {
    const account = assertCommittedSwapOfferMatchesEvent(state, offer);
    if ((account.status ?? 'active') !== 'active') return null;
    assertSameJurisdictionOrderHoldCommitted(account, offer);
  }
  return markWorkingOrderbookOffer(offer);
};

/**
 * Get previous frame hash from entity state.
 * Genesis if height=0, otherwise hash from last committed frame.
 */
export function getPrevFrameHash(state: EntityState): string {
  if (state.height === 0) return 'genesis';
  if (typeof state.prevFrameHash === 'string' && state.prevFrameHash.length > 0) {
    return state.prevFrameHash;
  }
  throw new Error(
    `ENTITY_FRAME_CHAIN_CORRUPTED: missing prevFrameHash at height=${state.height} entity=${state.entityId}`,
  );
}

export const assertFrameParentMatchesState = (
  state: EntityState,
  frame: ProposedEntityFrame,
  context: string,
): void => {
  const expected = getPrevFrameHash(state);
  if (frame.parentFrameHash !== expected) {
    throw new Error(`${context}:expected=${expected}:received=${frame.parentFrameHash}:height=${frame.height}`);
  }
};

export const buildCertifiedEntityFrameLink = (
  entityId: string,
  frame: ProposedEntityFrame,
  postState: EntityState,
  verifiedCommitment?: Readonly<{
    stateRoot: string;
    authority: EntityFrameAuthority;
  }>,
): CertifiedEntityFrameLink => {
  if (postState.entityId.toLowerCase() !== entityId.toLowerCase()) {
    throw new Error(`ENTITY_CERTIFIED_LINK_ENTITY_MISMATCH:expected=${entityId}:received=${postState.entityId}`);
  }
  if (postState.height !== frame.height) {
    throw new Error(`ENTITY_CERTIFIED_LINK_HEIGHT_MISMATCH:state=${postState.height}:frame=${frame.height}`);
  }
  if (postState.prevFrameHash !== frame.hash) {
    throw new Error(
      `ENTITY_CERTIFIED_LINK_HEAD_MISMATCH:state=${postState.prevFrameHash ?? 'missing'}:frame=${frame.hash}`,
    );
  }
  const postStateRoot = verifiedCommitment?.stateRoot ?? computeCanonicalEntityConsensusStateHash(postState);
  if (postStateRoot !== frame.stateRoot) {
    throw new Error(`ENTITY_CERTIFIED_LINK_STATE_ROOT_MISMATCH:expected=${postStateRoot}:received=${frame.stateRoot}`);
  }
  const postAuthority = verifiedCommitment?.authority ?? buildEntityFrameAuthority(postState);
  const authorityRoot = computeEntityFrameAuthorityRoot(postAuthority);
  if (authorityRoot !== frame.authorityRoot) {
    throw new Error(
      `ENTITY_CERTIFIED_LINK_AUTHORITY_ROOT_MISMATCH:expected=${authorityRoot}:received=${frame.authorityRoot}`,
    );
  }
  const recomputed = createEntityFrameHashFromStateRoot(
    frame.parentFrameHash,
    frame.height,
    frame.timestamp,
    frame.txs,
    frame.events,
    entityId,
    postStateRoot,
    authorityRoot,
    frame.jPrefixCertificate,
  );
  if (recomputed !== frame.hash) {
    throw new Error(`ENTITY_CERTIFIED_LINK_HASH_MISMATCH:expected=${recomputed}:received=${frame.hash}`);
  }
  if (!frame.collectedSigs?.size) {
    throw new Error(`ENTITY_CERTIFIED_LINK_SIGNATURES_MISSING:${frame.height}:${frame.hash}`);
  }
  const frameManifestEntry = frame.hashesToSign?.[0];
  if (!frameManifestEntry || frameManifestEntry.type !== 'entityFrame' || frameManifestEntry.hash !== frame.hash) {
    throw new Error(`ENTITY_CERTIFIED_LINK_FRAME_MANIFEST_INVALID:${frame.height}:${frame.hash}`);
  }
  return { frame: cloneIsolatedProposedEntityFrame(frame), postAuthority };
};

export const appendCertifiedEntityFrameLink = (
  replica: EntityReplica,
  link: CertifiedEntityFrameLink,
  candidateEffects: EntityCandidateEffect[],
): void => {
  const lineage = replica.certifiedFrameLineage ?? [];
  const sameHeight = lineage.filter(candidate => candidate.frame.height === link.frame.height);
  const fork = sameHeight.find(candidate => candidate.frame.hash !== link.frame.hash);
  if (fork) {
    throw new Error(
      `ENTITY_CERTIFIED_LINEAGE_FORK:height=${link.frame.height}:` +
        `existing=${fork.frame.hash}:incoming=${link.frame.hash}`,
    );
  }
  const fingerprint = encodeCanonicalConsensusValue(link);
  if (sameHeight.some(candidate => encodeCanonicalConsensusValue(candidate) === fingerprint)) return;
  candidateEffects.push({
    kind: 'entityFrameHistory',
    entityId: replica.entityId,
    link: structuredClone(link),
  });
  // The exact old history is durable in the Runtime/frame WAL. Keep only the
  // contiguous links produced after this R-frame's rolling anchor: a cross-j
  // cascade may certify the same Entity more than once before the R-frame is
  // committed, and dropping an intermediate link would break its own chain.
  replica.certifiedFrameLineage = [...lineage, structuredClone(link)];
};

// === SECURITY VALIDATION ===

/**
 * Validates entity input to prevent malicious or corrupted data
 */
const hasWellFormedEntityTxs = (input: EntityInput): boolean => {
  if (!input.entityTxs) return true;
  if (!Array.isArray(input.entityTxs)) {
    log.error(`❌ EntityTxs must be array, got: ${typeof input.entityTxs}`);
    return false;
  }
  if (input.entityTxs.length > LIMITS.MEMPOOL_SIZE) {
    log.error(`❌ Too many transactions: ${input.entityTxs.length} > ${LIMITS.MEMPOOL_SIZE}`);
    return false;
  }
  const invalid = input.entityTxs.find(tx => !tx.type || !tx.data);
  if (!invalid) return true;
  log.error(`❌ Invalid transaction: ${safeStringify(invalid)}`);
  return false;
};

const hasWellFormedHashPrecommits = (input: EntityInput): boolean => {
  if (!input.hashPrecommits) return true;
  if (!(input.hashPrecommits instanceof Map)) {
    log.error(`❌ HashPrecommits must be Map, got: ${typeof input.hashPrecommits}`);
    return false;
  }
  if (input.hashPrecommits.size > LIMITS.MAX_VALIDATORS) {
    log.error(`❌ Too many hashPrecommits: ${input.hashPrecommits.size} > ${LIMITS.MAX_VALIDATORS}`);
    return false;
  }
  const reference = input.hashPrecommitFrame;
  if (
    !reference ||
    !Number.isSafeInteger(reference.height) ||
    reference.height < 0 ||
    typeof reference.frameHash !== 'string' ||
    reference.frameHash.trim().length === 0
  ) {
    log.error(`❌ Invalid hashPrecommitFrame: ${safeStringify(reference)}`);
    return false;
  }
  for (const [signerId, sigs] of input.hashPrecommits) {
    if (typeof signerId === 'string' && Array.isArray(sigs)) continue;
    log.error(`❌ Invalid hashPrecommit format: ${signerId} -> ${typeof sigs}`);
    return false;
  }
  return true;
};

const hasWellFormedJPrefixAttestations = (input: EntityInput): boolean => {
  if (!input.jPrefixAttestations) return true;
  if (!(input.jPrefixAttestations instanceof Map) || input.jPrefixAttestations.size === 0) {
    log.error(`❌ J-prefix attestations must be a non-empty Map`);
    return false;
  }
  if (input.jPrefixAttestations.size > LIMITS.MAX_VALIDATORS) {
    log.error(`❌ Too many J-prefix attestations: ${input.jPrefixAttestations.size}`);
    return false;
  }
  for (const [signerId, attestation] of input.jPrefixAttestations) {
    if (typeof signerId === 'string' && attestation && typeof attestation === 'object') continue;
    log.error(`❌ Invalid J-prefix attestation entry`);
    return false;
  }
  return true;
};

const hasWellFormedProposedFrame = (input: EntityInput): boolean => {
  if (!input.proposedFrame) return true;
  const frame = input.proposedFrame;
  validateProposedEntityFrame(frame, 'EntityInput.proposedFrame');
  if (typeof frame.height !== 'number' || frame.height < 0) {
    log.error(`❌ Invalid frame height: ${frame.height}`);
    return false;
  }
  if (!Array.isArray(frame.txs)) {
    log.error(`❌ Frame txs must be array`);
    return false;
  }
  if (!frame.hash || typeof frame.hash !== 'string') {
    log.error(`❌ Invalid frame hash: ${frame.hash}`);
    return false;
  }
  if (
    !frame.leader ||
    typeof frame.leader.proposerSignerId !== 'string' ||
    !Number.isSafeInteger(frame.leader.view) ||
    frame.leader.view < 0
  ) {
    log.error(`❌ Invalid frame leader metadata`);
    return false;
  }
  return true;
};

const hasWellFormedLeaderTimeoutVote = (input: EntityInput): boolean => {
  if (!input.leaderTimeoutVote) return true;
  const vote = input.leaderTimeoutVote;
  const valid =
    typeof vote.entityId === 'string' &&
    typeof vote.voterId === 'string' &&
    typeof vote.signature === 'string' &&
    Number.isSafeInteger(vote.targetHeight) &&
    Number.isSafeInteger(vote.fromView) &&
    Number.isSafeInteger(vote.toView);
  if (!valid) log.error(`❌ Invalid leader timeout vote`);
  return valid;
};

export const isEntityInputWellFormed = (input: EntityInput): boolean => {
  try {
    if (!input.entityId || typeof input.entityId !== 'string') {
      log.error(`❌ Invalid entityId: ${input.entityId}`);
      return false;
    }
    return (
      hasWellFormedEntityTxs(input) &&
      hasWellFormedHashPrecommits(input) &&
      hasWellFormedJPrefixAttestations(input) &&
      hasWellFormedProposedFrame(input) &&
      hasWellFormedLeaderTimeoutVote(input)
    );
  } catch (error) {
    log.error(`❌ Input validation error: ${error}`);
    return false;
  }
};

/**
 * Validates entity replica to prevent corrupted state
 */
const isCrossJurisdictionLocalRuntimeTx = (tx: EntityTx): boolean =>
  tx.type === 'runtimeOutput' && tx.data.protocol === 'cross-j';

export const isSingleSignerEntity = (state: EntityState): boolean => {
  if (state.config.validators.length !== 1) return false;
  try {
    return BigInt(state.config.threshold ?? 0) === 1n;
  } catch {
    return false;
  }
};

export const validateEntityReplica = (replica: EntityReplica): boolean => {
  try {
    if (!replica.entityId || !replica.signerId) {
      log.error(`❌ Invalid replica IDs: ${replica.entityId}:${replica.signerId}`);
      return false;
    }
    if (replica.state.height < 0) {
      log.error(`❌ Invalid state height: ${replica.state.height}`);
      return false;
    }
    if (replica.mempool.length > LIMITS.MEMPOOL_SIZE) {
      log.error(`❌ External mempool overflow: ${replica.mempool.length} > ${LIMITS.MEMPOOL_SIZE}`);
      return false;
    }
    return true;
  } catch (error) {
    log.error(`❌ Replica validation error: ${error}`);
    return false;
  }
};

export const getEntityMempoolAdmissionError = (
  replica: EntityReplica,
  input: EntityInput,
  trustedLocalCrossJurisdiction = false,
): string | null => {
  if (!Array.isArray(input.entityTxs) || input.entityTxs.length === 0) return null;
  const incoming = input.entityTxs.length;
  if (trustedLocalCrossJurisdiction) {
    if (!input.entityTxs.every(isCrossJurisdictionLocalRuntimeTx)) {
      return 'trusted local cross-j lane contains a non-cross-j runtime transaction';
    }
    return null;
  }
  const existing = Array.isArray(replica.mempool) ? replica.mempool.length : 0;
  if (incoming > LIMITS.MEMPOOL_SIZE) {
    return `entityTxs overflow: ${incoming} > ${LIMITS.MEMPOOL_SIZE}`;
  }
  const next = existing + incoming;
  if (next > LIMITS.MEMPOOL_SIZE) {
    return `entity mempool admission overflow: ${existing} + ${incoming} > ${LIMITS.MEMPOOL_SIZE}`;
  }
  return null;
};

/**
 * Validates voting power to prevent overflow attacks
 */
export const validateVotingPower = (power: bigint): boolean => {
  try {
    if (power < 0n) {
      log.error(`❌ Negative voting power: ${power}`);
      return false;
    }
    // Check for overflow (2^53 - 1 in bigint)
    if (power > BigInt(Number.MAX_SAFE_INTEGER)) {
      log.error(`❌ Voting power overflow: ${power} > ${Number.MAX_SAFE_INTEGER}`);
      return false;
    }
    return true;
  } catch (error) {
    log.error(`❌ Voting power validation error: ${error}`);
    return false;
  }
};

// === CORE ENTITY PROCESSING ===

export const calculateQuorumPower = (config: ConsensusConfig, signers: string[]): bigint => {
  const uniqueSigners = new Set<string>();
  return signers.reduce((total, rawSignerId) => {
    const signerId = rawSignerId.trim().toLowerCase();
    if (uniqueSigners.has(signerId)) {
      throw new Error(`ENTITY_QUORUM_DUPLICATE_SIGNER:${rawSignerId}`);
    }
    uniqueSigners.add(signerId);
    if (!config.validators.some(validator => validator.trim().toLowerCase() === signerId)) {
      throw new Error(`ENTITY_QUORUM_UNKNOWN_SIGNER:${rawSignerId}`);
    }
    const shares = Object.entries(config.shares).find(
      ([shareSignerId]) => shareSignerId.trim().toLowerCase() === signerId,
    )?.[1];
    if (typeof shares !== 'bigint' || shares <= 0n) {
      throw new Error(`ENTITY_QUORUM_INVALID_SHARES:${rawSignerId}`);
    }
    return total + shares;
  }, 0n);
};

export const sortSignatures = (signatures: Map<string, string>, config: ConsensusConfig): Map<string, string> => {
  const sortedEntries = Array.from(signatures.entries()).sort(([a], [b]) => {
    const indexA = config.validators.indexOf(a);
    const indexB = config.validators.indexOf(b);
    return indexA - indexB;
  });
  return new Map(sortedEntries);
};

// === ENTITY UTILITIES (existing) ===

/**
 * Gets entity state summary for debugging
 */
export const getEntityStateSummary = (replica: EntityReplica): string => {
  const hasProposal = replica.proposal ? '✓' : '✗';
  return `mempool=${replica.mempool.length}, proposal=${hasProposal}`;
};

/**
 * Checks if entity should auto-propose (simplified version)
 */
export const shouldAutoPropose = (replica: EntityReplica, _config: ConsensusConfig): boolean => {
  const hasMempool = replica.mempool.length > 0;
  const isProposer = replica.isProposer;
  const hasProposal = replica.proposal !== undefined;

  return hasMempool && isProposer && !hasProposal;
};
