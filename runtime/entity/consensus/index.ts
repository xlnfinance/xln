/**
 * Entity consensus: validator replicas agree on entity frames, then route
 * committed account/J-layer side effects back into the runtime.
 */

import { applyEntityTx } from '../tx';
import {
  appendDefaultProposerAcceptedHtlcReveals,
  emitDefaultProposerHtlcOnionAdvances,
} from '../htlc-onion-post-commit';
import { appendDefaultProposerCrossJMaterializations } from '../cross-j-proposer-materialization';
import { assertLocalJRebroadcastAllowed } from '../tx/handlers/j-rebroadcast';
import type {
  AccountInput,
  AccountTx,
  CertifiedEntityFrameLink,
  ConsensusConfig,
  ConsensusOutputOrigin,
  EntityInput,
  EntityLeaderCertificate,
  EntityLeaderTimeoutVote,
  EntityReplica,
  EntityState,
  EntityTx,
  Env,
  HankoString,
  HashToSign,
  HashType,
  JInput,
  ProposedEntityFrame,
  ValidatorEntityFrameExecution,
} from '../../types';
import { DEBUG, HEAVY_LOGS, formatEntityDisplay, getPerfMs, log } from '../../utils';
import { compareStableText, safeStringify } from '../../protocol/serialization';
import {
  cloneIsolatedEntityInput,
  cloneIsolatedEntityLeaderCertificate,
  cloneIsolatedEntityLeaderTimeoutVote,
  cloneIsolatedProposedEntityFrame,
} from '../../protocol/runtime-input-clone';
import { nodeProcess } from '../../machine/platform';
import {
  createStructuredLogger,
  logError,
  shortHash,
  shortId,
  shortOrder,
  shouldLogFullPayloads,
} from '../../infra/logger';
import { accountInputProposal, accountInputReferenceHeight } from '../../account/consensus/flush';
import { resolveCertifiedAccountCounterpartyProposer } from '../../account/counterparty-route';
import {
  addMessages,
  cloneEntityReplica,
  cloneEntityState,
  getAccountPerspective,
  emitScopedEvents,
  removeCommittedTxsFromMempool,
  resolveEntityProposerId,
} from '../../state-helpers';
import { markStorageAccountDirty, markStorageEntityDirty, recordOrderbookPairUpdate } from '../../machine/env-events';
import { LIMITS } from '../../constants';
import { signAccountFrame as signFrame, verifyAccountSignature as verifyFrame } from '../../account/crypto';
import { appendAccountMempoolTx } from '../../account/mempool';
import { queueAccountMempoolTx } from './account-mempool-queue';
import {
  normalizeSwapOfferForOrderbook,
  collectCommittedCrossJurisdictionCancelAcks,
  processOrderbookSwaps,
  processOrderbookCancels,
  routeRemoteCrossJurisdictionBookCancels,
  type SwapCancelEvent,
  type SwapCancelRequestEvent,
  type SwapOfferEvent,
} from '../tx/handlers/account';
import {
  markWorkingOrderbookOffer,
  swapKey,
  type NormalizedOrderbookOffer,
  type WorkingOrderbookOffer,
} from '../../orderbook/swap-execution';
import { assertScheduledWakeFrameOrder } from '../../machine/scheduled-wake';
import { replaceOrderbookPair, type OrderbookExtState } from '../../orderbook';
import {
  emitCommittedPendingFrameWarnings,
  initCrontab,
  scheduleHook as scheduleCrontabHook,
  cancelHook as cancelCrontabHook,
} from '../scheduler';
import {
  applyCommittedSwapCancelsToOrderbook,
  crossJurisdictionBookOwnerRef,
  deterministicEntityTimestamp,
  findAccountByCounterparty,
  findCrossJurisdictionBookAdmissionForAck,
  getCrossJurisdictionBookAdmissionError,
  isCrossJurisdictionBookAdmissionPending,
  normalizeEntityRef,
} from '../../orderbook/cross-j-orderbook';
import { markCrossJurisdictionBookAdmissionResolving } from '../../extensions/cross-j/orderbook';
import {
  assertEntityFrameTxByteBudget,
  createEntityFrameHash,
  createEntityFrameHashFromStateRoot,
  isCanonicalEntityFrameDigest,
  selectEntityFrameTxByteBudget,
} from './frame';
import {
  assertEntityLeaderVoteMatchesState,
  buildEntityLeaderCertificate,
  copyLocalEntityLeaderTimeoutVoteAuthorization,
  getEntityLeaderState,
  getEntityQuorumSafetyWarning,
  getReplicaProposalLeader,
  hashEntityLeaderVoteBody,
  isEntityActiveLeader,
  isLocalEntityLeaderTimeoutVote,
  isReplicaProposalLeader,
  leaderVoteCollectionKey,
  type EntityLeaderStateView,
} from './leader';
import {
  assertEntityConfigBoardAuthority,
  buildQuorumHanko,
  getEntityConfigBoardHash,
  signEntityHashes,
} from '../../hanko/signing';
import { getCertifiedBoardNodeStore, resolveObserverCertifiedBoardRecord } from '../../jurisdiction/board-registry';
import {
  getJEventRangeValidationError,
  getValidatorJContiguousThroughHeight,
  isCertifiedJHistoryCorruption,
  pruneFinalizedValidatorJHistory,
} from '../../jurisdiction/local-history';
import {
  assertFrameJPrefix,
  buildCertifiedJPrefixTx,
  buildJPrefixCertificate,
  buildLocalJPrefixAttestation,
  entityRequiresJPrefixCertificate,
  getLocalJPrefixAttestableHeight,
  getJPrefixAttestationTemporalDisposition,
  hasCurrentRoundJPrefixAttestation,
  hasDueLocalJPrefixAdvance,
  hasPendingLocalJEvent,
  isFrozenBaseJPrefixRollAuthorized,
  mergeJPrefixAttestations,
  verifyOutOfRoundJPrefixAttestation,
} from '../../jurisdiction/j-prefix-consensus';
import { proposeAccountFrame } from '../../account/consensus/propose';
import { accountHasProposableMempool } from './account-mempool-eligibility';
import {
  attachHankoWitnessToOutputs,
  buildEntityHashesToSign,
  getEntityHashManifestMismatch,
  isWitnessHashType,
  normalizeProposedFrameCollectedSigs,
  pruneHankoWitnessToReachableState,
  sealHankoWitnessInState,
  type HankoWitnessEntry,
} from './hanko-witness';
import {
  assignCertifiedOutputIdentities,
  assertCertifiedOutputSemanticIdentity,
  buildCertifiedEntityOutputHashes,
  buildConsensusOutputOriginForState,
  hashCertifiedEntityOutput,
  isLocalRuntimeProtocolOutput,
  isNonMutatingEntityWakeOutput,
  normalizeConsensusOutputOrigin,
  resolveConsensusOutputBoardAuthority,
  verifyCertifiedEntityOutput,
} from './output-certification';
import { orderCertifiedOutputsBySequence } from './output-envelope';
import { cloneCrossJurisdictionAccountTxRoute } from '../../extensions/cross-j/index';
import { buildCrossJurisdictionFillId, CROSS_J_PENDING_FILL_ACK_TTL_MS } from '../../extensions/cross-j/fill-ack';
import { pruneSettledOriginatedHtlcRoutes, terminateHtlcRoute } from '../tx/htlc-route-lifecycle';
import { computeHtlcEnvelopeContextHash } from '../../protocol/htlc/envelope';
import { encryptedHtlcLayer } from '../../protocol/htlc/onion-advance';
import { validateMultiRecipientCiphertext } from '../../protocol/htlc/multi-recipient';
import { validateProposedEntityFrame } from '../../validation-utils';
import {
  buildEntityFrameAuthority,
  computeCanonicalEntityConsensusStateHash,
  computeEntityFrameAuthorityRoot,
  encodeCanonicalEntityConsensusValue,
} from './state-root';
import { prioritizeScheduledWakeTransactions } from './input-merge';
import {
  advanceEntityCommandNonce,
  assertSignedEntityCommand,
  getEntityCommandDisposition,
  normalizeEntityCommandNonceBoard,
  prepareLocallyAuthoredEntityTxs,
} from '../command';
import { isEntityCommandForbiddenTx } from '../command-codec';
import {
  assertRuntimeOutputAuthorization,
  isCollectiveEntityActionTx,
  isIndividualEntityCommandTx,
} from '../authorization';
import { normalizeEntityProposalBoard } from '../tx/proposals';
import {
  assertEntityFrameJRangeBudget,
  getEntityFrameJRangeBudgetError,
  selectEntityTxsWithinJRangeBudget,
} from '../../jurisdiction/range-budget';
import {
  applyConsumptionOutput,
  createConsumptionProof,
  createEmptyConsumptionAccumulator,
  getConsumptionKey,
  type ConsumptionNode,
  type ConsumptionOutputIdentity,
} from '../consumption-accumulator';
import {
  cacheCommittedConsumptionNodeChanges,
  getConsumptionNodeStore,
  type ConsumptionNodeChanges,
} from '../consumption-store';
import type { AccountJClaimNode, AccountJClaimNodeChanges, AccountJClaimNodeStore } from '../../types/account-j-claims';
import { cacheCommittedAccountJClaimNodeChanges, getAccountJClaimNodeStore } from '../../account/j-claim-store';
import { classifyEntityConsensusStateQuotaTransition, measureEntityConsensusStateBytes } from './state-quota';
import { buildSettlementSealDraft } from '../tx/handlers/settle';
import {
  assertCanonicalSettlementWorkspace,
  hasPendingSettlementTransition,
} from '../../account/tx/handlers/settle-transition';
export {
  mergeEntityInputs,
  prioritizeEntityConsensusInputs,
  prioritizeProtocolEntityInputs,
} from './input-merge';

const consumptionStateMeasurement = (state: EntityState) =>
  measureEntityConsensusStateBytes(state, {
    getAccumulatorState: candidate => candidate.consumptionAccumulator,
  });

type ConsumptionSizeLog = Readonly<{
  warning: boolean;
  details: Record<string, string>;
}>;

const prepareCommittedEntitySizeLog = (env: Env, preState: EntityState, postState: EntityState): ConsumptionSizeLog => {
  const before = consumptionStateMeasurement(preState);
  const after = consumptionStateMeasurement(postState);
  const configuredWarningBytes = env.runtimeConfig?.entityConsensusStateWarningBytes;
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

const emitCommittedEntitySizeLog = (entry: ConsumptionSizeLog): void => {
  if (entry.warning) entityLog.warn('state.size_warning', entry.details);
  else entityLog.debug('state.size', entry.details);
};

export const MAX_PENDING_CROSS_J_FILL_ACKS = 1024;

const ENTITY_FRAME_PROFILE =
  nodeProcess?.env?.['XLN_ENTITY_FRAME_PROFILE'] === '1' ||
  nodeProcess?.env?.['XLN_ENTITY_INPUT_PROFILE'] === '1' ||
  nodeProcess?.env?.['XLN_RUNTIME_PROCESS_PROFILE'] === '1';
const ENTITY_FRAME_SLOW_MS = Math.max(0, Number(nodeProcess?.env?.['XLN_ENTITY_FRAME_SLOW_MS'] || '1000'));
export { createEntityFrameHash } from './frame';
export { CROSS_J_PENDING_FILL_ACK_TTL_MS } from '../../extensions/cross-j/fill-ack';
const entityLog = createStructuredLogger('entity');

const getReplicaJRangeValidationError = (env: Env, replica: EntityReplica, txs: EntityTx[]): string | null => {
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
        (signerId, digest, signature) => verifyFrame(env, signerId, digest, signature),
      );
      if (error) return error;
    }
  } catch (error) {
    if (isCertifiedJHistoryCorruption(error)) throw error;
    return error instanceof Error ? error.message : String(error);
  }
  return null;
};

const assertProposerJRangesMatchLocalHistory = (env: Env, replica: EntityReplica, txs: EntityTx[]): void => {
  const error = getReplicaJRangeValidationError(env, replica, txs);
  if (error) throw new Error(`ENTITY_PROPOSER_J_RANGE_INVALID:${error}`);
};

const getFrameJPrefixValidationError = (
  env: Env,
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

const isJPrefixLocalFreshnessRace = (error: string): boolean =>
  error === 'J_PREFIX_STRONGER_LOCAL_CERTIFICATE' || error === 'J_PREFIX_REQUIRED_LOCAL_EVENT';

const pruneReplicaFinalizedJHistory = (replica: EntityReplica): void => {
  const pruned = pruneFinalizedValidatorJHistory(replica.jHistory, replica.state.lastFinalizedJHeight);
  if (pruned) replica.jHistory = pruned;
  else delete replica.jHistory;
};

const clearCommittedJPrefixRound = (replica: EntityReplica): void => {
  if (replica.jPrefixRound && replica.jPrefixRound.targetEntityHeight <= replica.state.height) {
    delete replica.jPrefixRound;
  }
};

const ensureLocalJPrefixAttestation = (
  env: Env,
  replica: EntityReplica,
  entityOutbox: EntityInput[],
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
 * keeps a later scan in durable validator-local history. A semantic event (or
 * the bounded liveness interval) must not wait for unrelated Entity traffic,
 * so deriving that due vote here is a deterministic consequence of the commit.
 * An empty suffix below the liveness boundary intentionally remains local and
 * is certified by the next real Entity frame instead of creating one itself.
 */
const advanceLocalJPrefixRoundAfterCommit = (env: Env, replica: EntityReplica, entityOutbox: EntityInput[]): void => {
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

const runLocalPostCommitHooks = async (
  env: Env,
  replica: EntityReplica,
  entityOutbox: EntityInput[],
): Promise<void> => {
  advanceLocalJPrefixRoundAfterCommit(env, replica, entityOutbox);
  await emitDefaultProposerHtlcOnionAdvances(env, replica, entityOutbox);
};

type EntityAccountMachine = EntityState['accounts'] extends Map<string, infer T> ? T : never;
type CrossSwapFillAckTx = Extract<AccountTx, { type: 'cross_swap_fill_ack' }>;
type CrossJurisdictionFillNoticeTx = Extract<EntityTx, { type: 'crossJurisdictionFillNotice' }>;

const hasQueuedOrderLifecycleTx = (account: EntityAccountMachine, offerId: string): boolean => {
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

const normalizePrecommitBundles = (
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

const verifyHashPrecommitSignatures = (
  env: Env,
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
    if (!verifyFrame(env, signerId, hashInfo.hash, sig)) {
      log.error(
        `❌ ${context}: invalid ${hashInfo.type} signature[${i}] from ${signerId} ` +
          `hash=${hashInfo.hash.slice(0, 30)}... context=${hashInfo.context}`,
      );
      return false;
    }
  }
  return true;
};

const hasVerifiedPreparedQuorum = (
  env: Env,
  state: EntityLeaderStateView,
  frame: ProposedEntityFrame,
  context: string,
): boolean => {
  const hashes = frame.hashesToSign;
  if (!hashes?.length || hashes[0]?.type !== 'entityFrame' || hashes[0]?.hash !== frame.hash) {
    throw new Error(`${context}_MANIFEST_INVALID:${frame.hash}`);
  }
  const signatures = normalizePrecommitBundles(
    state.config,
    frame.collectedSigs ?? new Map(),
    context,
  );
  for (const [signerId, bundle] of signatures) {
    if (!verifyHashPrecommitSignatures(
      env,
      signerId,
      hashes,
      frame.hash,
      frame.height,
      bundle,
      context,
    )) {
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
  env: Env,
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
    if (!verifyFrame(env, signerId, hashEntityLeaderVoteBody(vote), vote.signature)) return false;
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

export const selectPreparedFrameFromCertificate = (
  env: Env,
  state: EntityLeaderStateView,
  certificate: EntityLeaderCertificate,
): ProposedEntityFrame | null => {
  type PreparedGroup = { frame: ProposedEntityFrame; signatures: Map<string, string[]> };
  const groups = new Map<string, PreparedGroup>();
  let evidenceCount = 0;
  for (const vote of getCertificateSignedVotes(certificate).values()) {
    const evidence = vote.preparedFrame;
    if (!evidence) continue;
    evidenceCount += 1;
    if (evidence.height !== certificate.targetHeight) {
      throw new Error(`ENTITY_PREPARED_HEIGHT_MISMATCH:${evidence.height}:${certificate.targetHeight}`);
    }
    const expectedParent = state.height === 0 ? 'genesis' : String(state.prevFrameHash || '');
    if (evidence.parentFrameHash !== expectedParent) {
      throw new Error(`ENTITY_PREPARED_PARENT_MISMATCH:${evidence.parentFrameHash}:${expectedParent}`);
    }
    const recomputedEvidenceHash = createEntityFrameHashFromStateRoot(
      evidence.parentFrameHash,
      evidence.height,
      evidence.timestamp,
      evidence.txs,
      state.entityId,
      evidence.stateRoot,
      evidence.authorityRoot,
      evidence.jPrefixCertificate,
    );
    if (recomputedEvidenceHash !== evidence.hash) {
      throw new Error(`ENTITY_PREPARED_FRAME_HASH_MISMATCH:${recomputedEvidenceHash}:${evidence.hash}`);
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
    const group = groups.get(evidence.hash) ?? {
      frame: structuredClone(evidence),
      signatures: new Map<string, string[]>(),
    };
    if (
      encodeCanonicalEntityConsensusValue({ ...group.frame, collectedSigs: undefined }) !==
      encodeCanonicalEntityConsensusValue({ ...evidence, collectedSigs: undefined })
    ) {
      throw new Error(`ENTITY_PREPARED_BODY_CONFLICT:${evidence.hash}`);
    }
    for (const [signerId, signatures] of normalized) {
      const existing = group.signatures.get(signerId);
      if (
        existing &&
        (existing.length !== signatures.length || existing.some((signature, index) => signature !== signatures[index]))
      ) {
        throw new Error(`ENTITY_PREPARED_SIGNER_EQUIVOCATION:${evidence.hash}:${signerId}`);
      }
      group.signatures.set(signerId, signatures);
    }
    groups.set(evidence.hash, group);
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
  env: Env,
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

const replayPreparedFrameForRelay = async (
  env: Env,
  replica: EntityReplica,
  frame: ProposedEntityFrame,
): Promise<ValidatorEntityFrameExecution> => {
  assertFrameParentMatchesState(replica.state, frame, 'ENTITY_PREPARED_PARENT_MISMATCH');
  const jRangeError = getReplicaJRangeValidationError(env, replica, frame.txs);
  if (jRangeError) throw new Error(`ENTITY_PREPARED_J_RANGE_MISMATCH:${jRangeError}`);
  assertFrameJPrefix(env, replica, frame);
  const {
    newState,
    collectedHashes = [],
    outputs,
    jOutputs,
    consumptionNodeChanges,
    accountJClaimNodeChanges,
  } = await applyEntityFrame(env, replica.state, frame.txs, frame.timestamp);
  const replayedState = {
    ...newState,
    entityId: replica.state.entityId,
    height: frame.height,
    timestamp: frame.timestamp,
    leaderState: expectedCommittedLeaderState(replica.state, frame),
  };
  const replayedStateRoot = computeCanonicalEntityConsensusStateHash(replayedState);
  if (replayedStateRoot !== frame.stateRoot) {
    throw new Error(`ENTITY_PREPARED_STATE_ROOT_MISMATCH:expected=${replayedStateRoot}:received=${frame.stateRoot}`);
  }
  const replayedAuthorityRoot = computeEntityFrameAuthorityRoot(buildEntityFrameAuthority(replayedState));
  if (replayedAuthorityRoot !== frame.authorityRoot) {
    throw new Error(
      `ENTITY_PREPARED_AUTHORITY_ROOT_MISMATCH:expected=${replayedAuthorityRoot}:received=${frame.authorityRoot}`,
    );
  }
  const replayedHash = await createEntityFrameHash(
    getPrevFrameHash(replica.state),
    frame.height,
    frame.timestamp,
    frame.txs,
    replayedState,
    frame.jPrefixCertificate,
  );
  if (replayedHash !== frame.hash) {
    throw new Error(`ENTITY_PREPARED_FRAME_HASH_MISMATCH:expected=${replayedHash}:received=${frame.hash}`);
  }
  const outputHashes = buildCertifiedEntityOutputHashes(replayedState, env, frame.height, replayedHash, outputs);
  const manifest = buildEntityHashesToSign(replica.entityId, frame.height, replayedHash, [
    ...collectedHashes,
    ...outputHashes,
  ]);
  const manifestMismatch = getEntityHashManifestMismatch(manifest, frame.hashesToSign);
  if (manifestMismatch) throw new Error(`ENTITY_PREPARED_MANIFEST_MISMATCH:${manifestMismatch}`);
  return {
    frameHash: frame.hash,
    height: frame.height,
    state: replayedState,
    outputs,
    jOutputs,
    hashesToSign: manifest,
    ...(consumptionNodeChanges ? { consumptionNodeChanges } : {}),
    ...(accountJClaimNodeChanges ? { accountJClaimNodeChanges } : {}),
  };
};

const getValidatorExecutionForFrame = (
  replica: EntityReplica,
  frame: ProposedEntityFrame,
): ValidatorEntityFrameExecution | undefined => {
  const execution = replica.validatorExecution;
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

const buildConsumptionOutputIdentity = (
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
export const attachTargetConsumptionProofs = (env: Env, state: EntityState, txs: readonly EntityTx[]): EntityTx[] => {
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

const wrapCertifiedEntityOutputs = (
  outputs: EntityInput[],
  frame: ProposedEntityFrame,
  sourceState: EntityState,
  env: Env,
  hashesToSign: HashToSign[],
  hankos: HankoString[],
  emitLocalRuntimeOutputs: boolean,
): EntityInput[] => {
  const outputHashes = buildCertifiedEntityOutputHashes(sourceState, env, frame.height, frame.hash, outputs);
  return outputs.flatMap((output, outputIndex): EntityInput[] => {
    if (isNonMutatingEntityWakeOutput(output)) return [structuredClone(output)];
    if (isLocalRuntimeProtocolOutput(output)) {
      if (!emitLocalRuntimeOutputs) return [];
      const targetEntityId = output.entityId.trim().toLowerCase();
      const localTarget = Array.from(env.eReplicas.values()).some(replica =>
        replica.entityId.toLowerCase() === targetEntityId &&
        replica.signerId.toLowerCase() === output.signerId.toLowerCase());
      if (!localTarget) {
        throw new Error(`RUNTIME_OUTPUT_TARGET_NOT_LOCAL:${targetEntityId}:${output.signerId}`);
      }
      if (!output.entityTxs?.length) throw new Error(`RUNTIME_OUTPUT_ENTITY_TXS_MISSING:index=${outputIndex}`);
      return [{
        entityId: targetEntityId,
        signerId: output.signerId.toLowerCase(),
        entityTxs: [{
          type: 'runtimeOutput',
          data: {
            protocol: 'cross-j',
            sourceEntityId: sourceState.entityId.toLowerCase(),
            targetEntityId,
            entityTxs: structuredClone(output.entityTxs),
          },
        }],
      }];
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
    return [{
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
    }];
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
  env: Env,
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
    return applyJRangeBudgetToSelection({
      txs: attachTargetConsumptionProofs(env, state, mempool),
      currentAuthorityReady: true,
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

const isSelfBoardAuthorityTransitionFrame = async (
  env: Env,
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

const validateProposedFrameLeader = (env: Env, state: EntityState, frame: ProposedEntityFrame): boolean => {
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

const buildCrossJurisdictionFillNoticeOutput = (
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

const ownsSourceHubRouteForFillAck = (currentEntityState: EntityState, tx: CrossSwapFillAckTx): boolean => {
  const route = currentEntityState.crossJurisdictionSwaps?.get(tx.data.offerId);
  if (!route) return false;
  return normalizeEntityRef(route.source.counterpartyEntityId) === normalizeEntityRef(currentEntityState.entityId);
};

const stashPendingCrossJurisdictionFillAck = (
  env: Env,
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
  markStorageEntityDirty(env, currentEntityState.entityId);
  entityLog.info('crossj.fill_ack_deferred', {
    entity: shortId(currentEntityState.entityId, 8),
    account: shortId(accountId, 8),
    offer: shortOrder(tx.data.offerId, 8),
    reason,
  });
};

const drainPendingCrossJurisdictionFillAcks = (
  env: Env,
  currentEntityState: EntityState,
  proposableAccounts: Set<string>,
): number => {
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
      markStorageEntityDirty(env, currentEntityState.entityId);
      entityLog.warn('crossj.fill_ack_ttl_expired_preserved', payload);
    }
    const account = currentEntityState.accounts.get(pendingAck.accountId);
    if (!account?.swapOffers?.has(pendingAck.tx.data.offerId)) continue;
    if (queueAccountMempoolTx(account, pendingAck.tx)) {
      proposableAccounts.add(pendingAck.accountId);
      markStorageAccountDirty(env, currentEntityState.entityId, pendingAck.accountId);
    }
    pending.delete(key);
    drained++;
    markStorageEntityDirty(env, currentEntityState.entityId);
    entityLog.info('crossj.fill_ack_drained', {
      entity: shortId(currentEntityState.entityId, 8),
      account: shortId(pendingAck.accountId, 8),
      offer: shortOrder(pendingAck.tx.data.offerId, 8),
      storedAt: pendingAck.storedAt,
    });
  }
  return drained;
};

const drainCommittedCrossJurisdictionCancelAcks = (
  env: Env,
  currentEntityState: EntityState,
  proposableAccounts: Set<string>,
): number => {
  let queued = 0;
  for (const { accountId, tx } of collectCommittedCrossJurisdictionCancelAcks(currentEntityState)) {
    const account = currentEntityState.accounts.get(accountId);
    if (!account) {
      throw new Error(`CROSS_J_CANCEL_ACK_ACCOUNT_MISSING:account=${accountId}:offer=${tx.data.offerId}`);
    }
    if (!queueAccountMempoolTx(account, tx)) continue;
    proposableAccounts.add(accountId);
    markStorageAccountDirty(env, currentEntityState.entityId, accountId);
    markStorageEntityDirty(env, currentEntityState.entityId);
    queued += 1;
  }
  return queued;
};

const assertCommittedSwapOfferMatchesEvent = (
  state: EntityState,
  offer: NormalizedOrderbookOffer,
): EntityAccountMachine => {
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
  account: EntityAccountMachine,
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

const admitOrderbookOfferForMatching = (
  env: Env,
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
function getPrevFrameHash(state: EntityState): string {
  if (state.height === 0) return 'genesis';
  if (typeof state.prevFrameHash === 'string' && state.prevFrameHash.length > 0) {
    return state.prevFrameHash;
  }
  throw new Error(
    `ENTITY_FRAME_CHAIN_CORRUPTED: missing prevFrameHash at height=${state.height} entity=${state.entityId}`,
  );
}

const assertFrameParentMatchesState = (state: EntityState, frame: ProposedEntityFrame, context: string): void => {
  const expected = getPrevFrameHash(state);
  if (frame.parentFrameHash !== expected) {
    throw new Error(`${context}:expected=${expected}:received=${frame.parentFrameHash}:height=${frame.height}`);
  }
};

const buildCertifiedEntityFrameLink = (
  entityId: string,
  frame: ProposedEntityFrame,
  postState: EntityState,
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
  const postStateRoot = computeCanonicalEntityConsensusStateHash(postState);
  if (postStateRoot !== frame.stateRoot) {
    throw new Error(`ENTITY_CERTIFIED_LINK_STATE_ROOT_MISMATCH:expected=${postStateRoot}:received=${frame.stateRoot}`);
  }
  const postAuthority = buildEntityFrameAuthority(postState);
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

const appendCertifiedEntityFrameLink = (replica: EntityReplica, link: CertifiedEntityFrameLink): void => {
  const lineage = replica.certifiedFrameLineage ?? [];
  const sameHeight = lineage.filter(candidate => candidate.frame.height === link.frame.height);
  const fork = sameHeight.find(candidate => candidate.frame.hash !== link.frame.hash);
  if (fork) {
    throw new Error(
      `ENTITY_CERTIFIED_LINEAGE_FORK:height=${link.frame.height}:` +
        `existing=${fork.frame.hash}:incoming=${link.frame.hash}`,
    );
  }
  const fingerprint = encodeCanonicalEntityConsensusValue(link);
  if (sameHeight.some(candidate => encodeCanonicalEntityConsensusValue(candidate) === fingerprint)) return;
  replica.certifiedFrameLineage = [...lineage, structuredClone(link)].sort(
    (left, right) =>
      left.frame.height - right.frame.height ||
      compareStableText(left.frame.hash, right.frame.hash) ||
      compareStableText(encodeCanonicalEntityConsensusValue(left), encodeCanonicalEntityConsensusValue(right)),
  );
};

// === SECURITY VALIDATION ===

/**
 * Validates entity input to prevent malicious or corrupted data
 */
const validateEntityInput = (input: EntityInput): boolean => {
  try {
    // Basic required fields
    if (!input.entityId || typeof input.entityId !== 'string') {
      log.error(`❌ Invalid entityId: ${input.entityId}`);
      return false;
    }
    // EntityTx validation
    if (input.entityTxs) {
      if (!Array.isArray(input.entityTxs)) {
        log.error(`❌ EntityTxs must be array, got: ${typeof input.entityTxs}`);
        return false;
      }
      if (input.entityTxs.length > LIMITS.MEMPOOL_SIZE) {
        log.error(`❌ Too many transactions: ${input.entityTxs.length} > ${LIMITS.MEMPOOL_SIZE}`);
        return false;
      }
      for (const tx of input.entityTxs) {
        if (!tx.type || !tx.data) {
          log.error(`❌ Invalid transaction: ${safeStringify(tx)}`);
          return false;
        }
        // Type system ensures tx.type is always a string literal
      }
    }

    // HashPrecommits validation (multi-hash signatures)
    if (input.hashPrecommits) {
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
        if (typeof signerId !== 'string' || !Array.isArray(sigs)) {
          log.error(`❌ Invalid hashPrecommit format: ${signerId} -> ${typeof sigs}`);
          return false;
        }
      }
    }

    if (input.jPrefixAttestations) {
      if (!(input.jPrefixAttestations instanceof Map) || input.jPrefixAttestations.size === 0) {
        log.error(`❌ J-prefix attestations must be a non-empty Map`);
        return false;
      }
      if (input.jPrefixAttestations.size > LIMITS.MAX_VALIDATORS) {
        log.error(`❌ Too many J-prefix attestations: ${input.jPrefixAttestations.size}`);
        return false;
      }
      for (const [signerId, attestation] of input.jPrefixAttestations) {
        if (typeof signerId !== 'string' || !attestation || typeof attestation !== 'object') {
          log.error(`❌ Invalid J-prefix attestation entry`);
          return false;
        }
      }
    }

    // ProposedFrame validation
    if (input.proposedFrame) {
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
    }

    if (input.leaderTimeoutVote) {
      const vote = input.leaderTimeoutVote;
      if (
        typeof vote.entityId !== 'string' ||
        typeof vote.voterId !== 'string' ||
        typeof vote.signature !== 'string' ||
        !Number.isSafeInteger(vote.targetHeight) ||
        !Number.isSafeInteger(vote.fromView) ||
        !Number.isSafeInteger(vote.toView)
      ) {
        log.error(`❌ Invalid leader timeout vote`);
        return false;
      }
    }

    return true;
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

const isSingleSignerEntity = (state: EntityState): boolean => {
  if (state.config.validators.length !== 1) return false;
  try {
    return BigInt(state.config.threshold ?? 0) === 1n;
  } catch {
    return false;
  }
};

const validateEntityReplica = (replica: EntityReplica): boolean => {
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

const getEntityMempoolAdmissionError = (
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
const validateVotingPower = (power: bigint): boolean => {
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

export type EntityInputOutcome =
  | { kind: 'committed' }
  | { kind: 'noop'; reason: string }
  | { kind: 'deferred'; reason: string }
  | { kind: 'rejected'; code: string };

type ApplyEntityInputResult = {
  outcome: EntityInputOutcome;
  newState: EntityState;
  outputs: EntityInput[];
  jOutputs: JInput[];
  workingReplica: EntityReplica;
  canonicalAppliedInput?: EntityInput;
};

type ApplyEntityInputContext = {
  env: Env;
  entityInput: EntityInput;
  workingReplica: EntityReplica;
  entityOutbox: EntityInput[];
  jOutbox: JInput[];
  frameHash: string;
  canonicalAppliedInput?: EntityInput;
};

const commitEntityConsensusInput = (context: ApplyEntityInputContext): ApplyEntityInputResult => ({
  outcome: { kind: 'committed' },
  newState: context.workingReplica.state,
  outputs: context.entityOutbox,
  jOutputs: context.jOutbox,
  workingReplica: context.workingReplica,
  ...(context.canonicalAppliedInput ? { canonicalAppliedInput: context.canonicalAppliedInput } : {}),
});

const noopEntityConsensusInput = (context: ApplyEntityInputContext, reason: string): ApplyEntityInputResult => ({
  outcome: { kind: 'noop', reason },
  newState: context.workingReplica.state,
  outputs: [],
  jOutputs: [],
  workingReplica: context.workingReplica,
});

const deferEntityConsensusInput = (context: ApplyEntityInputContext, reason: string): ApplyEntityInputResult => ({
  outcome: { kind: 'deferred', reason },
  newState: context.workingReplica.state,
  outputs: [],
  jOutputs: [],
  workingReplica: context.workingReplica,
});

const rejectEntityConsensusInput = (
  context: ApplyEntityInputContext,
  code = 'ENTITY_CONSENSUS_REJECTED',
): ApplyEntityInputResult => ({
  outcome: { kind: 'rejected', code },
  newState: context.workingReplica.state,
  outputs: [],
  jOutputs: [],
  workingReplica: context.workingReplica,
});

const handleJPrefixAttestations = (context: ApplyEntityInputContext): ApplyEntityInputResult | null => {
  const { env, entityInput, workingReplica, entityOutbox } = context;
  const incoming = entityInput.jPrefixAttestations;
  if (!incoming) return null;
  if (!(incoming instanceof Map) || incoming.size === 0) {
    return rejectEntityConsensusInput(context, 'J_PREFIX_ATTESTATION_INVALID');
  }
  const authorityConfigs = [
    workingReplica.state.config,
    ...(workingReplica.certifiedFrameAnchor ? [workingReplica.certifiedFrameAnchor.authority.config] : []),
    ...(workingReplica.certifiedFrameLineage ?? []).map(link => link.postAuthority.config),
  ];
  let outOfRoundDisposition: 'stale' | 'current' | 'future';
  try {
    const dispositions = new Set(
      [...incoming.values()].map(attestation =>
        getJPrefixAttestationTemporalDisposition(workingReplica.state, attestation),
      ),
    );
    if (dispositions.size !== 1) throw new Error('J_PREFIX_MIXED_TARGET_HEIGHTS');
    outOfRoundDisposition = dispositions.values().next().value!;
    if (outOfRoundDisposition !== 'current') {
      for (const [rawSignerId, rawAttestation] of incoming) {
        const attestation = verifyOutOfRoundJPrefixAttestation(
          env,
          workingReplica.state,
          rawAttestation,
          authorityConfigs,
        );
        if (rawSignerId.trim().toLowerCase() !== attestation.validatorId) {
          throw new Error(`J_PREFIX_MAP_SIGNER_MISMATCH:${rawSignerId}`);
        }
      }
    }
  } catch (error) {
    entityLog.error('j_prefix.attestation_rejected', {
      error: error instanceof Error ? error.message : String(error),
    });
    return rejectEntityConsensusInput(context, 'J_PREFIX_ATTESTATION_REJECTED');
  }
  if (outOfRoundDisposition === 'future') {
    return deferEntityConsensusInput(context, 'J_PREFIX_FUTURE_HEIGHT');
  }
  if (outOfRoundDisposition === 'stale') {
    entityLog.debug('j_prefix.attestation_stale_terminal', {
      targetEntityHeight: incoming.values().next().value!.targetEntityHeight,
      currentEntityHeight: workingReplica.state.height,
    });
    // The vote may have become stale only because unrelated Account/Entity
    // traffic committed while the watcher input was queued. Its authenticated
    // local J-history is still an unfulfilled obligation. Re-derive one vote
    // for the current parent immediately; otherwise a single-signer Entity can
    // permanently strand AccountSettled at H+1 with no later ingress to wake it.
    // The stale bytes remain terminal and never enter the new round.
    if (
      hasDueLocalJPrefixAdvance(workingReplica.state, workingReplica.jHistory) &&
      ensureLocalJPrefixAttestation(env, workingReplica, entityOutbox, false)
    ) return null;
    return commitEntityConsensusInput(context);
  }
  const priorRound = workingReplica.jPrefixRound;
  const priorHeads = encodeCanonicalEntityConsensusValue(priorRound?.attestations ?? new Map());
  let merged;
  try {
    merged = mergeJPrefixAttestations(env, workingReplica.state, workingReplica.jPrefixRound, incoming);
  } catch (error) {
    entityLog.error('j_prefix.attestation_rejected', {
      error: error instanceof Error ? error.message : String(error),
    });
    return rejectEntityConsensusInput(context, 'J_PREFIX_ATTESTATION_REJECTED');
  }
  const nextHeads = encodeCanonicalEntityConsensusValue(merged.attestations);
  const changed = priorHeads !== nextHeads;
  if (changed && (workingReplica.proposal || workingReplica.lockedFrame)) {
    // Once a validator has signed/locked a frame, a later head belongs to the
    // next Entity height. Mutating this round would let the same validator
    // authorize two different maximum-prefix frames.
    return rejectEntityConsensusInput(context, 'J_PREFIX_ROUND_FROZEN');
  }
  workingReplica.jPrefixRound = merged;
  if (changed) workingReplica.lastConsensusProgressAt = env.timestamp;

  for (const [signerId, attestation] of incoming) {
    const normalizedSignerId = signerId.trim().toLowerCase();
    if (normalizedSignerId !== workingReplica.signerId.trim().toLowerCase()) continue;
    const previous = priorRound?.attestations.get(normalizedSignerId);
    if (
      previous &&
      encodeCanonicalEntityConsensusValue(previous) === encodeCanonicalEntityConsensusValue(attestation)
    ) {
      continue;
    }
    for (const validatorId of workingReplica.state.config.validators) {
      if (validatorId.trim().toLowerCase() === normalizedSignerId) continue;
      entityOutbox.push({
        entityId: workingReplica.entityId,
        signerId: validatorId,
        jPrefixAttestations: new Map([[normalizedSignerId, structuredClone(attestation)]]),
      });
    }
  }
  return null;
};

async function handleLeaderTimeoutVote(context: ApplyEntityInputContext): Promise<ApplyEntityInputResult | null> {
  const { env, entityInput, workingReplica, entityOutbox } = context;
  const incoming = entityInput.leaderTimeoutVote;
  if (!incoming) return null;
  try {
    assertEntityLeaderVoteMatchesState(workingReplica.state, incoming);
  } catch (error) {
    entityLog.warn('leader.vote.rejected', { error: error instanceof Error ? error.message : String(error) });
    return rejectEntityConsensusInput(context);
  }

  const voterId = incoming.voterId.toLowerCase();
  const isValidator = workingReplica.state.config.validators.some(validator => validator.toLowerCase() === voterId);
  if (!isValidator) return rejectEntityConsensusInput(context);
  const voteHash = hashEntityLeaderVoteBody(incoming);
  let vote: EntityLeaderTimeoutVote = incoming;
  if (isLocalEntityLeaderTimeoutVote(incoming)) {
    if (voterId !== workingReplica.signerId.toLowerCase() || incoming.signature) {
      return rejectEntityConsensusInput(context);
    }
    vote = { ...incoming, signature: await signFrame(env, workingReplica.signerId, voteHash) };
    // The scheduler creates an explicitly local unsigned intent. Consensus turns
    // it into the signed protocol value, and that exact value must enter the WAL
    // and reliable-receipt path. Persisting the unsigned intent would lose its
    // non-enumerable local authorization on restart and make replay reject it.
    context.canonicalAppliedInput = {
      ...entityInput,
      leaderTimeoutVote: cloneIsolatedEntityLeaderTimeoutVote(vote),
    };
    workingReplica.lastConsensusProgressAt = env.timestamp;
    for (const validatorId of workingReplica.state.config.validators) {
      if (validatorId.toLowerCase() === workingReplica.signerId.toLowerCase()) continue;
      entityOutbox.push({
        entityId: entityInput.entityId,
        signerId: validatorId,
        leaderTimeoutVote: vote,
      });
    }
  } else if (!verifyFrame(env, voterId, voteHash, incoming.signature)) {
    return rejectEntityConsensusInput(context);
  }

  const collectionKey = leaderVoteCollectionKey(vote);
  const previousCollectionKey = workingReplica.leaderVotes?.values().next().value as
    EntityLeaderTimeoutVote | undefined;
  if (previousCollectionKey && leaderVoteCollectionKey(previousCollectionKey) !== collectionKey) {
    workingReplica.leaderVotes = new Map();
  }
  if (!workingReplica.leaderVotes) workingReplica.leaderVotes = new Map();
  const previousVote = workingReplica.leaderVotes.get(voterId);
  if (previousVote) {
    if (encodeCanonicalEntityConsensusValue(previousVote) !== encodeCanonicalEntityConsensusValue(vote)) {
      entityLog.error('leader.vote_equivocation', { voter: shortId(voterId) });
      return rejectEntityConsensusInput(context, 'ENTITY_LEADER_VOTE_EQUIVOCATION');
    }
    return null;
  }
  workingReplica.leaderVotes.set(voterId, vote);

  const signers = Array.from(workingReplica.leaderVotes.keys());
  const power = calculateQuorumPower(workingReplica.state.config, signers);
  if (power >= workingReplica.state.config.threshold) {
    const certificate = buildEntityLeaderCertificate(vote, workingReplica.leaderVotes);
    let preparedFrame: ProposedEntityFrame | null;
    try {
      const localLockHasPreparedQuorum = workingReplica.lockedFrame
        ? hasVerifiedPreparedQuorum(
            env,
            workingReplica.state,
            workingReplica.lockedFrame,
            'ENTITY_PREPARED_LOCAL_LOCK',
          )
        : false;
      preparedFrame = selectPreparedFrameFromCertificate(env, workingReplica.state, certificate);
      if (!preparedFrame && localLockHasPreparedQuorum && workingReplica.lockedFrame) {
        throw new Error(`ENTITY_PREPARED_LOCAL_LOCK_OMITTED:${workingReplica.lockedFrame.hash}`);
      }
      if (
        preparedFrame &&
        workingReplica.lockedFrame &&
        localLockHasPreparedQuorum &&
        workingReplica.lockedFrame.hash !== preparedFrame.hash &&
        workingReplica.lockedFrame.leader.view >= preparedFrame.leader.view
      ) {
        throw new Error(
          `ENTITY_PREPARED_LOCK_CONFLICT:local=${workingReplica.lockedFrame.hash}:selected=${preparedFrame.hash}`,
        );
      }
      if (!preparedFrame && workingReplica.lockedFrame && !localLockHasPreparedQuorum) {
        // The higher-view quorum certificate is the durable signing fence.
        // Retaining a sub-threshold local vote as `lockedFrame` would confuse a
        // vote with a QC and make the newly certified leader unable to propose.
        delete workingReplica.lockedFrame;
        delete workingReplica.validatorExecution;
      }
    } catch (error) {
      entityLog.error('leader.prepared_certificate_rejected', {
        error: error instanceof Error ? error.message : String(error),
      });
      return rejectEntityConsensusInput(context, 'LEADER_PREPARED_CERTIFICATE_REJECTED');
    }
    if (preparedFrame) {
      certificate.preparedFrameHash = preparedFrame.hash;
      workingReplica.lockedFrame = {
        ...preparedFrame,
        leader: {
          ...preparedFrame.leader,
          relayCertificate: cloneIsolatedEntityLeaderCertificate(certificate),
        },
      };
      if (
        workingReplica.validatorExecution &&
        (workingReplica.validatorExecution.height !== preparedFrame.height ||
          workingReplica.validatorExecution.frameHash.toLowerCase() !== preparedFrame.hash.toLowerCase())
      ) {
        delete workingReplica.validatorExecution;
      }
    }
    workingReplica.pendingLeaderCertificate = certificate;
    workingReplica.lastConsensusProgressAt = env.timestamp;
    entityLog.warn('leader.view_change_certified', {
      entity: shortId(workingReplica.entityId),
      from: shortId(vote.previousLeaderId),
      to: shortId(vote.nextLeaderId),
      view: vote.toView,
      power: power.toString(),
    });
  }
  return null;
}

async function handleCommitNotification(context: ApplyEntityInputContext): Promise<ApplyEntityInputResult | null> {
  const { env, entityInput, workingReplica, entityOutbox, jOutbox } = context;
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

  let execution = getValidatorExecutionForFrame(workingReplica, proposedFrame);

  // Normally use the validator-computed state. If this replica missed the proposal
  // but is exactly one frame behind, replay the signed txs locally.
  if (!execution) {
    const expectedPrevHeight = proposedFrame.height - 1;
    if (workingReplica.state.height !== expectedPrevHeight) {
      entityLog.warn('commit.catch_up_state_wait', {
        height: workingReplica.state.height,
        expectedPrevHeight,
        commitHeight: proposedFrame.height,
        frame: shortHash(proposedFrame.hash),
      });
      // A valid certificate can arrive before this validator has the exact
      // predecessor state. It is not invalid, but it must never be ACKed as
      // applied: the sender retains the authoritative reliable output and
      // retries after the missing height commits.
      return deferEntityConsensusInput(context, 'COMMIT_CATCH_UP_STATE_WAIT');
    }

    const jRangeError = getReplicaJRangeValidationError(env, workingReplica, proposedFrame.txs);
    if (jRangeError) {
      entityLog.error('commit.catch_up_j_range_rejected', { error: jRangeError });
      return rejectEntityConsensusInput(context, 'COMMIT_J_RANGE_MISMATCH');
    }
    const jPrefixError = getFrameJPrefixValidationError(env, workingReplica, proposedFrame);
    if (jPrefixError) {
      if (jPrefixError.startsWith('J_PREFIX_LOCAL_HISTORY_BEHIND:')) {
        return deferEntityConsensusInput(context, 'COMMIT_J_PREFIX_HISTORY_WAIT');
      }
      if (isJPrefixLocalFreshnessRace(jPrefixError)) {
        // This validator did not sign the historical frame: it is replaying an
        // already quorum-certified height before it can reach the later frame
        // that finalizes its newer local J observation. Reapplying proposal
        // freshness here deadlocks ordered catch-up (H cannot be skipped to
        // reach H+1). Intrinsic prefix/range/corruption checks remain mandatory,
        // and the validator still recomputes state plus every secondary hash
        // before cryptographically verifying the existing signer bundles.
        entityLog.info('commit.catch_up_local_j_prefix_ahead', {
          error: jPrefixError,
          frameHeight: proposedFrame.height,
          localFinalizedJHeight: workingReplica.state.lastFinalizedJHeight,
          localScannedThroughHeight: workingReplica.jHistory?.scannedThroughHeight ?? null,
        });
      } else {
        entityLog.error('commit.j_prefix_rejected', { error: jPrefixError });
        return rejectEntityConsensusInput(context, 'COMMIT_J_RANGE_MISMATCH');
      }
    }
    const {
      newState: replayedState,
      collectedHashes: replayedCollectedHashes = [],
      outputs: replayedOutputs,
      jOutputs: replayedJOutputs,
      consumptionNodeChanges,
      accountJClaimNodeChanges,
    } = await applyEntityFrame(env, workingReplica.state, proposedFrame.txs, proposedFrame.timestamp);
    const replayedCommitState = {
      ...replayedState,
      entityId: workingReplica.state.entityId,
      height: proposedFrame.height,
      timestamp: proposedFrame.timestamp,
      leaderState: expectedCommittedLeaderState(workingReplica.state, proposedFrame),
    };
    const replayedStateRoot = computeCanonicalEntityConsensusStateHash(replayedCommitState);
    if (replayedStateRoot !== proposedFrame.stateRoot) {
      return rejectEntityConsensusInput(context, 'COMMIT_STATE_ROOT_MISMATCH');
    }
    const replayedAuthorityRoot = computeEntityFrameAuthorityRoot(buildEntityFrameAuthority(replayedCommitState));
    if (replayedAuthorityRoot !== proposedFrame.authorityRoot) {
      return rejectEntityConsensusInput(context, 'COMMIT_AUTHORITY_ROOT_MISMATCH');
    }
    const replayedHash = await createEntityFrameHash(
      getPrevFrameHash(workingReplica.state),
      proposedFrame.height,
      proposedFrame.timestamp,
      proposedFrame.txs,
      replayedCommitState,
      proposedFrame.jPrefixCertificate,
    );
    if (replayedHash !== proposedFrame.hash) {
      logError('FRAME_CONSENSUS', `❌ COMMIT REJECTED: replayed catch-up state does not match signed frame hash!`);
      logError('FRAME_CONSENSUS', `   Expected: ${replayedHash.slice(0, 30)}...`);
      logError('FRAME_CONSENSUS', `   Received: ${proposedFrame.hash.slice(0, 30)}...`);
      return rejectEntityConsensusInput(context);
    }
    const outputHashes = buildCertifiedEntityOutputHashes(
      replayedCommitState,
      env,
      proposedFrame.height,
      replayedHash,
      replayedOutputs,
    );
    const expectedHashesToSign = buildEntityHashesToSign(
      workingReplica.state.entityId,
      proposedFrame.height,
      replayedHash,
      [...replayedCollectedHashes, ...outputHashes],
    );
    execution = {
      frameHash: proposedFrame.hash,
      height: proposedFrame.height,
      state: replayedCommitState,
      outputs: replayedOutputs,
      jOutputs: replayedJOutputs,
      hashesToSign: expectedHashesToSign,
      ...(consumptionNodeChanges ? { consumptionNodeChanges } : {}),
      ...(accountJClaimNodeChanges ? { accountJClaimNodeChanges } : {}),
    };
    entityLog.warn('commit.catch_up_state_replayed', {
      height: proposedFrame.height,
      frame: shortHash(proposedFrame.hash),
    });
  }

  const stateToApply = execution.state;
  const expectedHashesToSign = execution.hashesToSign;

  const manifestMismatch = getEntityHashManifestMismatch(expectedHashesToSign, proposedFrame.hashesToSign);
  if (manifestMismatch) {
    logError('FRAME_CONSENSUS', `❌ BYZANTINE: Commit secondary hash manifest mismatch: ${manifestMismatch}`, {
      frame: proposedFrame.hash,
      expected: expectedHashesToSign,
      received: proposedFrame.hashesToSign ?? null,
    });
    return rejectEntityConsensusInput(context);
  }

  for (const [signerId, sigs] of frameCollectedSigs) {
    if (
      !verifyHashPrecommitSignatures(
        env,
        signerId,
        expectedHashesToSign,
        proposedFrame.hash,
        proposedFrame.height,
        sigs,
        'COMMIT_REJECTED',
      )
    ) {
      logError('FRAME_CONSENSUS', `❌ BYZANTINE: Invalid hash signature bundle from ${signerId}`);
      logError('FRAME_CONSENSUS', `   Frame hash: ${proposedFrame.hash.slice(0, 30)}...`);
      return rejectEntityConsensusInput(context);
    }
  }
  entityLog.debug('commit.signatures_verified', {
    count: frameCollectedSigs.size,
    frame: shortHash(proposedFrame.hash),
  });

  const committedHankos: HankoString[] = [];
  if (expectedHashesToSign) {
    for (let index = 0; index < expectedHashesToSign.length; index += 1) {
      const hashInfo = expectedHashesToSign[index];
      if (!hashInfo) continue;
      const signatures = Array.from(frameCollectedSigs.entries()).flatMap(([signerId, signerSigs]) => {
        const signature = signerSigs[index];
        return signature ? [{ signerId, signature }] : [];
      });
      committedHankos.push(
        await buildQuorumHanko(
          env,
          workingReplica.state.entityId,
          hashInfo.hash,
          signatures,
          workingReplica.state.config,
          stateToApply,
        ),
      );
    }
  }
  if (!workingReplica.hankoWitness) workingReplica.hankoWitness = new Map();
  for (let index = 0; index < (expectedHashesToSign?.length ?? 0); index += 1) {
    const hashInfo = expectedHashesToSign?.[index];
    const hanko = committedHankos[index];
    if (!hashInfo || !hanko || !isWitnessHashType(hashInfo.type)) continue;
    workingReplica.hankoWitness.set(hashInfo.hash, {
      hanko,
      type: hashInfo.type,
      entityHeight: proposedFrame.height,
      createdAt: env.timestamp,
    });
  }

  sealHankoWitnessInState(stateToApply, workingReplica.hankoWitness, proposedFrame.height);

  attachHankoWitnessToOutputs(
    execution.outputs,
    execution.jOutputs,
    workingReplica.hankoWitness,
    proposedFrame.height,
    stateToApply,
  );
  pruneHankoWitnessToReachableState(stateToApply, workingReplica.hankoWitness);
  const commitEmitterId =
    proposedFrame.leader.relayCertificate?.preparedFrameHash === proposedFrame.hash
      ? proposedFrame.leader.relayCertificate.nextLeaderId
      : proposedFrame.leader.proposerSignerId;
  entityOutbox.push(
    ...wrapCertifiedEntityOutputs(
      execution.outputs,
      proposedFrame,
      stateToApply,
      env,
      expectedHashesToSign,
      committedHankos,
      commitEmitterId.toLowerCase() === workingReplica.signerId.toLowerCase(),
    ),
  );
  if (commitEmitterId.toLowerCase() === workingReplica.signerId.toLowerCase()) {
    jOutbox.push(...execution.jOutputs);
  }

  const preCommitState = workingReplica.state;
  const committedState = {
    ...stateToApply,
    entityId: workingReplica.state.entityId,
    height: proposedFrame.height,
    prevFrameHash: proposedFrame.hash,
  } as EntityState;
  const entitySizeLog = prepareCommittedEntitySizeLog(env, preCommitState, committedState);
  cacheCommittedConsumptionNodeChanges(env, execution.consumptionNodeChanges);
  cacheCommittedAccountJClaimNodeChanges(env, execution.accountJClaimNodeChanges);
  workingReplica.state = committedState;
  emitCommittedPendingFrameWarnings(preCommitState, committedState);
  emitCommittedEntitySizeLog(entitySizeLog);
  proposedFrame.hankos = committedHankos;
  appendCertifiedEntityFrameLink(
    workingReplica,
    buildCertifiedEntityFrameLink(workingReplica.state.entityId, proposedFrame, workingReplica.state),
  );
  pruneReplicaFinalizedJHistory(workingReplica);

  const committedTxs = proposedFrame.txs;
  if (committedTxs.length > 0) {
    entityLog.debug('mempool.clear_committed', {
      committed: committedTxs.length,
      before: workingReplica.mempool.length,
    });
    workingReplica.mempool = removeCommittedTxsFromMempool(workingReplica.mempool, committedTxs);
    entityLog.debug('mempool.after_commit', { remaining: workingReplica.mempool.length });
  }

  delete workingReplica.proposal;
  delete workingReplica.lockedFrame;
  delete workingReplica.validatorExecution;
  if (proposedFrame.leader.relayCertificate?.preparedFrameHash === proposedFrame.hash) {
    workingReplica.pendingLeaderCertificate = structuredClone(proposedFrame.leader.relayCertificate);
  } else {
    delete workingReplica.pendingLeaderCertificate;
  }
  workingReplica.leaderVotes = new Map();
  workingReplica.lastConsensusProgressAt = env.timestamp;
  workingReplica.isProposer = isEntityActiveLeader(workingReplica);
  await runLocalPostCommitHooks(env, workingReplica, entityOutbox);
  markStorageEntityDirty(env, workingReplica.state.entityId);
  entityLog.debug('commit.applied', {
    height: workingReplica.state.height,
    frame: shortHash(proposedFrame.hash),
  });

  return commitEntityConsensusInput(context);
}

async function handleProposedFramePrecommit(context: ApplyEntityInputContext): Promise<ApplyEntityInputResult | null> {
  const { env, entityInput, workingReplica, entityOutbox, frameHash } = context;
  if (!entityInput.proposedFrame) return null;

  const config = workingReplica.state.config;
  const proposedFrame = entityInput.proposedFrame;
  if (proposedFrame.height < workingReplica.state.height) {
    return noopEntityConsensusInput(context, 'PROPOSAL_STALE');
  }
  if (proposedFrame.height === workingReplica.state.height) {
    return workingReplica.state.prevFrameHash === proposedFrame.hash
      ? noopEntityConsensusInput(context, 'PROPOSAL_ALREADY_COMMITTED')
      : rejectEntityConsensusInput(context, 'PROPOSAL_HEIGHT_HASH_CONFLICT');
  }
  const existingFrame = workingReplica.proposal ?? workingReplica.lockedFrame;
  if (existingFrame) {
    if (existingFrame.hash !== proposedFrame.hash) {
      if (existingFrame.height < proposedFrame.height) {
        return deferEntityConsensusInput(context, 'PROPOSAL_PRIOR_FRAME_PENDING');
      }
      entityLog.error('proposal.conflict_rejected', {
        existing: shortHash(existingFrame.hash),
        incoming: shortHash(proposedFrame.hash),
      });
      return rejectEntityConsensusInput(context);
    }
    return null;
  }
  const expectedPrevHeight = proposedFrame.height - 1;
  const canVerify = workingReplica.state.height === expectedPrevHeight;
  if (!canVerify) {
    entityLog.warn('proposal.catch_up_wait', {
      signer: shortId(workingReplica.signerId),
      height: workingReplica.state.height,
      expectedPrevHeight,
    });
    // Deferred is explicit: no state mutation, no delivery receipt, and the
    // sender remains responsible for ordered retry of the missing predecessor.
    return deferEntityConsensusInput(context, 'PROPOSAL_CATCH_UP_STATE_WAIT');
  }
  assertFrameParentMatchesState(workingReplica.state, proposedFrame, 'PROPOSAL_PARENT_MISMATCH');
  if (!validateProposedFrameLeader(env, workingReplica.state, proposedFrame)) {
    entityLog.error('proposal.leader_rejected', {
      proposer: shortId(proposedFrame.leader?.proposerSignerId ?? ''),
      view: proposedFrame.leader?.view ?? null,
    });
    return rejectEntityConsensusInput(context);
  }
  const effectiveProposalView = Math.max(
    proposedFrame.leader.view,
    proposedFrame.leader.certificate?.toView ?? -1,
    proposedFrame.leader.relayCertificate?.toView ?? -1,
  );
  const localValidatorId = workingReplica.signerId.trim().toLowerCase();
  const localVotedView = Math.max(
    -1,
    ...[...(workingReplica.leaderVotes?.values() ?? [])]
      .filter(vote =>
        vote.voterId.trim().toLowerCase() === localValidatorId &&
        vote.targetHeight === proposedFrame.height &&
        vote.signature.length > 0,
      )
      .map(vote => vote.toView),
  );
  const certifiedView = workingReplica.pendingLeaderCertificate?.targetHeight === proposedFrame.height
    ? workingReplica.pendingLeaderCertificate.toView
    : -1;
  if (Math.max(localVotedView, certifiedView) > effectiveProposalView) {
    // A validator that already signed a higher-view timeout must not later
    // sign the superseded proposal merely because transport reordered lanes.
    // New-view proposals and prepared relays carry that higher view explicitly.
    entityLog.info('proposal.superseded_by_local_view', {
      frame: shortHash(proposedFrame.hash),
      proposalView: effectiveProposalView,
      localVotedView,
      certifiedView,
    });
    return rejectEntityConsensusInput(context, 'PROPOSAL_SUPERSEDED_BY_LOCAL_VIEW_CHANGE');
  }

  const jRangeError = getReplicaJRangeValidationError(env, workingReplica, proposedFrame.txs);
  if (jRangeError) {
    entityLog.error('proposal.j_range_rejected', { error: jRangeError });
    return rejectEntityConsensusInput(context, 'PROPOSAL_J_RANGE_MISMATCH');
  }
  const jPrefixError = getFrameJPrefixValidationError(env, workingReplica, proposedFrame);
  if (jPrefixError) {
    if (jPrefixError.startsWith('J_PREFIX_LOCAL_HISTORY_BEHIND:')) {
      return deferEntityConsensusInput(context, 'PROPOSAL_J_PREFIX_HISTORY_WAIT');
    }
    if (isJPrefixLocalFreshnessRace(jPrefixError)) {
      // Ordered delivery can expose a stronger local prefix after the proposer
      // formed an earlier quorum certificate. Rejecting that stale proposal is
      // normal consensus flow; signatures, malformed certificates and actual
      // corruption remain error-severity failures above/below this branch.
      entityLog.info('proposal.j_prefix_stale', { error: jPrefixError });
    } else {
      entityLog.error('proposal.j_prefix_rejected', { error: jPrefixError });
    }
    return rejectEntityConsensusInput(context, 'PROPOSAL_J_RANGE_MISMATCH');
  }

  const {
    newState: validatorComputedState,
    collectedHashes: validatorCollectedHashes = [],
    outputs: validatorOutputs,
    jOutputs: validatorJOutputs,
    consumptionNodeChanges,
    accountJClaimNodeChanges,
  } = await applyEntityFrame(env, workingReplica.state, proposedFrame.txs, proposedFrame.timestamp);
  const validatorNewState = {
    ...validatorComputedState,
    entityId: workingReplica.state.entityId,
    height: proposedFrame.height,
    timestamp: proposedFrame.timestamp,
    leaderState: expectedCommittedLeaderState(workingReplica.state, proposedFrame),
  };
  const validatorStateRoot = computeCanonicalEntityConsensusStateHash(validatorNewState);
  if (validatorStateRoot !== proposedFrame.stateRoot) {
    entityLog.error('proposal.state_root_rejected', {
      expected: validatorStateRoot,
      received: proposedFrame.stateRoot,
    });
    return rejectEntityConsensusInput(context, 'PROPOSAL_STATE_ROOT_MISMATCH');
  }
  const validatorAuthorityRoot = computeEntityFrameAuthorityRoot(buildEntityFrameAuthority(validatorNewState));
  if (validatorAuthorityRoot !== proposedFrame.authorityRoot) {
    entityLog.error('proposal.authority_root_rejected', {
      expected: validatorAuthorityRoot,
      received: proposedFrame.authorityRoot,
    });
    return rejectEntityConsensusInput(context, 'PROPOSAL_AUTHORITY_ROOT_MISMATCH');
  }

  const prevFrameHash = getPrevFrameHash(workingReplica.state);
  const validatorComputedHash = await createEntityFrameHash(
    prevFrameHash,
    proposedFrame.height,
    proposedFrame.timestamp,
    proposedFrame.txs,
    validatorNewState,
    proposedFrame.jPrefixCertificate,
  );

  if (validatorComputedHash !== proposedFrame.hash) {
    logError('FRAME_CONSENSUS', `❌ HASH MISMATCH: Proposer sent invalid frame hash!`);
    logError('FRAME_CONSENSUS', `   Expected: ${validatorComputedHash.slice(0, 30)}...`);
    logError('FRAME_CONSENSUS', `   Received: ${proposedFrame.hash.slice(0, 30)}...`);
    logError('FRAME_CONSENSUS', `   This could indicate equivocation attack or state divergence bug.`);
    return rejectEntityConsensusInput(context, 'PROPOSAL_FRAME_HASH_MISMATCH');
  }

  entityLog.debug('proposal.hash_verified', { frame: shortHash(proposedFrame.hash) });

  const outputHashes = buildCertifiedEntityOutputHashes(
    validatorNewState,
    env,
    proposedFrame.height,
    validatorComputedHash,
    validatorOutputs,
  );
  const hashesToSign = buildEntityHashesToSign(
    workingReplica.state.entityId,
    proposedFrame.height,
    validatorComputedHash,
    [...validatorCollectedHashes, ...outputHashes],
  );
  const manifestMismatch = getEntityHashManifestMismatch(hashesToSign, proposedFrame.hashesToSign);
  if (manifestMismatch) {
    logError('FRAME_CONSENSUS', `❌ BYZANTINE: Secondary hash manifest mismatch: ${manifestMismatch}`, {
      frame: proposedFrame.hash,
      expected: hashesToSign,
      received: proposedFrame.hashesToSign ?? null,
    });
    return rejectEntityConsensusInput(context);
  }

  await assertEntityConfigBoardAuthority(
    env,
    workingReplica.state.entityId,
    workingReplica.state.config,
    validatorNewState,
  );
  const allSignatures = await Promise.all(
    hashesToSign.map(hashInfo => signFrame(env, workingReplica.signerId, hashInfo.hash)),
  );
  entityLog.debug('proposal.hashes_signed', { count: allSignatures.length });

  let proposedBundles: Map<string, string[]>;
  try {
    proposedBundles = normalizePrecommitBundles(
      config,
      proposedFrame.collectedSigs ?? new Map(),
      'PROPOSAL_PRECOMMIT_REJECTED',
    );
  } catch (error) {
    entityLog.error('proposal.precommit_bundle_rejected', {
      error: error instanceof Error ? error.message : String(error),
    });
    return rejectEntityConsensusInput(context, 'PROPOSAL_PRECOMMIT_REJECTED');
  }
  const collectedSigs = new Map<string, string[]>();
  for (const [signerId, signatures] of proposedBundles) {
    if (
      !verifyHashPrecommitSignatures(
        env,
        signerId,
        hashesToSign,
        proposedFrame.hash,
        proposedFrame.height,
        signatures,
        'PROPOSAL_PRECOMMIT_REJECTED',
      )
    )
      return rejectEntityConsensusInput(context);
    collectedSigs.set(signerId, [...signatures]);
  }
  const localSignerId = workingReplica.signerId.toLowerCase();
  const existingLocal = collectedSigs.get(localSignerId);
  if (
    existingLocal &&
    (existingLocal.length !== allSignatures.length ||
      existingLocal.some((signature, index) => signature !== allSignatures[index]))
  ) {
    return rejectEntityConsensusInput(context, 'PROPOSAL_LOCAL_PRECOMMIT_CONFLICT');
  }
  collectedSigs.set(localSignerId, allSignatures);
  workingReplica.lockedFrame = { ...proposedFrame, hashesToSign, collectedSigs };
  workingReplica.validatorExecution = {
    frameHash: proposedFrame.hash,
    height: proposedFrame.height,
    state: validatorNewState,
    outputs: validatorOutputs,
    jOutputs: validatorJOutputs,
    hashesToSign,
    ...(consumptionNodeChanges ? { consumptionNodeChanges } : {}),
    ...(accountJClaimNodeChanges ? { accountJClaimNodeChanges } : {}),
  };
  workingReplica.lastConsensusProgressAt = env.timestamp;

  config.validators.forEach(validatorId => {
    if (validatorId.toLowerCase() === workingReplica.signerId.toLowerCase()) return;
    entityOutbox.push({
      entityId: entityInput.entityId,
      signerId: validatorId,
      hashPrecommitFrame: {
        height: proposedFrame.height,
        frameHash: proposedFrame.hash,
      },
      hashPrecommits: new Map([[workingReplica.signerId, allSignatures]]),
    });
  });
  entityLog.debug('proposal.precommit_sent', {
    recipients: Math.max(0, config.validators.length - 1),
    frame: frameHash,
    signatures: allSignatures.length,
  });

  return null;
}

async function handleHashPrecommits(context: ApplyEntityInputContext): Promise<ApplyEntityInputResult | null> {
  const { env, entityInput, workingReplica, entityOutbox, jOutbox } = context;
  const hasIncomingPrecommits = Boolean(entityInput.hashPrecommits?.size);
  const frame = workingReplica.proposal ?? workingReplica.lockedFrame;
  if (!frame) {
    return hasIncomingPrecommits ? rejectEntityConsensusInput(context, 'PRECOMMIT_FRAME_NOT_ACTIVE') : null;
  }

  const proposal = frame;
  const execution = getValidatorExecutionForFrame(workingReplica, proposal);
  if (!execution) {
    throw new Error(`ENTITY_VALIDATOR_EXECUTION_MISSING:${proposal.height}:${proposal.hash}`);
  }
  const localManifestMismatch = getEntityHashManifestMismatch(execution.hashesToSign, proposal.hashesToSign);
  if (localManifestMismatch) {
    return rejectEntityConsensusInput(context, 'PRECOMMIT_LOCAL_MANIFEST_MISMATCH');
  }
  const precommitFrame = entityInput.hashPrecommitFrame;
  if (
    hasIncomingPrecommits &&
    (!precommitFrame ||
      precommitFrame.height !== proposal.height ||
      precommitFrame.frameHash.toLowerCase() !== proposal.hash.toLowerCase())
  ) {
    entityLog.warn('precommit.frame_mismatch', {
      receivedHeight: precommitFrame?.height,
      receivedHash: precommitFrame?.frameHash,
      activeHeight: proposal.height,
      activeHash: proposal.hash,
    });
    return rejectEntityConsensusInput(context, 'PRECOMMIT_FRAME_MISMATCH');
  }
  try {
    proposal.collectedSigs = normalizePrecommitBundles(
      workingReplica.state.config,
      proposal.collectedSigs ?? new Map(),
      'COLLECTED_PRECOMMITS_REJECTED',
    );
  } catch (error) {
    entityLog.error('precommit.collected_bundle_rejected', {
      error: error instanceof Error ? error.message : String(error),
    });
    return rejectEntityConsensusInput(context, 'COLLECTED_PRECOMMITS_REJECTED');
  }
  let incomingBundles = new Map<string, string[]>();
  if (entityInput.hashPrecommits?.size) {
    try {
      incomingBundles = normalizePrecommitBundles(
        workingReplica.state.config,
        entityInput.hashPrecommits,
        'PRECOMMIT_REJECTED',
      );
    } catch (error) {
      entityLog.error('precommit.bundle_rejected', { error: error instanceof Error ? error.message : String(error) });
      return rejectEntityConsensusInput(context, 'PRECOMMIT_BUNDLE_REJECTED');
    }
  }
  for (const [signerId, sigs] of incomingBundles) {
    if (
      !verifyHashPrecommitSignatures(
        env,
        signerId,
        execution.hashesToSign,
        proposal.hash,
        proposal.height,
        sigs,
        'PRECOMMIT_REJECTED',
      )
    )
      return rejectEntityConsensusInput(context, 'PRECOMMIT_SIGNATURE_REJECTED');
    if (!proposal.collectedSigs) {
      proposal.collectedSigs = new Map();
    }
    const existing = proposal.collectedSigs.get(signerId);
    if (
      existing &&
      (existing.length !== sigs.length || existing.some((signature, index) => signature !== sigs[index]))
    ) {
      return rejectEntityConsensusInput(context, 'PRECOMMIT_SIGNER_EQUIVOCATION');
    }
    proposal.collectedSigs.set(signerId, [...sigs]);
  }
  entityLog.debug('precommit.collected', {
    incoming: entityInput.hashPrecommits?.size ?? 0,
    total: proposal.collectedSigs?.size || 0,
  });

  const signers = Array.from(proposal.collectedSigs?.keys() || []);
  const totalPower = calculateQuorumPower(workingReplica.state.config, signers);
  if (!validateVotingPower(totalPower)) {
    throw new Error(`ENTITY_CONSENSUS_FATAL_INVALID_VOTING_POWER:${totalPower}`);
  }

  if (DEBUG) {
    const totalShares = Object.values(workingReplica.state.config.shares).reduce((sum, val) => sum + val, BigInt(0));
    const percentage = ((Number(totalPower) / Number(workingReplica.state.config.threshold)) * 100).toFixed(1);
    log.info(
      `    🔍 Threshold check: ${totalPower} / ${totalShares} [${percentage}% threshold${Number(totalPower) >= Number(workingReplica.state.config.threshold) ? '+' : ''}]`,
    );
  }

  if (totalPower < workingReplica.state.config.threshold) {
    return null;
  }

  entityLog.debug('commit.threshold_reached', {
    signers: signers.length,
    hashes: execution.hashesToSign.length,
  });

  const commitEmitterId =
    proposal.leader.relayCertificate?.preparedFrameHash === proposal.hash
      ? proposal.leader.relayCertificate.nextLeaderId
      : proposal.leader.proposerSignerId;
  const isFrameLeader = commitEmitterId.toLowerCase() === workingReplica.signerId.toLowerCase();
  if (!isFrameLeader && execution.jOutputs.length > 0) {
    entityLog.warn('commit.external_output_waiting_for_certified_emitter', {
      frame: shortHash(proposal.hash),
      emitter: shortId(commitEmitterId),
      jOutputs: execution.jOutputs.length,
    });
    return null;
  }

  const stateToCommit = execution.state;

  const committedHankos: HankoString[] = [];
  if (proposal.collectedSigs) {
    for (let i = 0; i < execution.hashesToSign.length; i++) {
      const hashInfo = execution.hashesToSign[i];
      if (!hashInfo) continue;
      const sigsForHash: Array<{ signerId: string; signature: string }> = [];
      for (const [signerId, sigs] of proposal.collectedSigs) {
        const sig = sigs[i];
        if (sig) {
          sigsForHash.push({ signerId, signature: sig });
        }
      }
      const hanko = await buildQuorumHanko(
        env,
        workingReplica.state.entityId,
        hashInfo.hash,
        sigsForHash,
        workingReplica.state.config,
        stateToCommit,
      );
      committedHankos.push(hanko);
    }
    entityLog.debug('commit.hankos_built', {
      count: committedHankos.length,
      validators: proposal.collectedSigs.size,
    });
  }

  // Witnesses are not consensus state; they let outputs carry quorum proofs.
  if (!workingReplica.hankoWitness) {
    workingReplica.hankoWitness = new Map();
  }
  if (execution.hashesToSign.length > 0) {
    for (let i = 0; i < execution.hashesToSign.length; i++) {
      const hashInfo = execution.hashesToSign[i];
      const hanko = committedHankos[i];
      if (hashInfo && hanko && isWitnessHashType(hashInfo.type)) {
        workingReplica.hankoWitness.set(hashInfo.hash, {
          hanko,
          type: hashInfo.type,
          entityHeight: workingReplica.state.height + 1,
          createdAt: env.timestamp,
        });
      }
    }
  }

  const sealedStateCount = sealHankoWitnessInState(
    stateToCommit,
    workingReplica.hankoWitness,
    workingReplica.state.height + 1,
  );

  // Only this validator's local replay may drive side effects. Proposer payloads
  // intentionally contain no outputs, so a valid frame signature cannot smuggle
  // an unrelated Entity/J message into the commit path.
  const attachedCount = attachHankoWitnessToOutputs(
    execution.outputs,
    execution.jOutputs,
    workingReplica.hankoWitness,
    workingReplica.state.height + 1,
    stateToCommit,
  );
  pruneHankoWitnessToReachableState(stateToCommit, workingReplica.hankoWitness);
  const commitOutputs = wrapCertifiedEntityOutputs(
    execution.outputs,
    proposal,
    stateToCommit,
    env,
    execution.hashesToSign,
    committedHankos,
    isFrameLeader,
  );
  entityOutbox.push(...commitOutputs);
  if (isFrameLeader) jOutbox.push(...execution.jOutputs);
  entityLog.info('commit.outputs', {
    outputs: commitOutputs.length,
    jOutputs: isFrameLeader ? execution.jOutputs.length : 0,
    hankos: attachedCount,
    stateHankos: sealedStateCount,
  });

  const preCommitState = workingReplica.state;
  const committedState = {
    ...stateToCommit,
    entityId: workingReplica.state.entityId,
    height: proposal.height,
    prevFrameHash: proposal.hash,
  } as EntityState;
  const entitySizeLog = prepareCommittedEntitySizeLog(env, preCommitState, committedState);
  cacheCommittedConsumptionNodeChanges(env, execution.consumptionNodeChanges);
  cacheCommittedAccountJClaimNodeChanges(env, execution.accountJClaimNodeChanges);
  workingReplica.state = committedState;
  emitCommittedPendingFrameWarnings(preCommitState, committedState);
  emitCommittedEntitySizeLog(entitySizeLog);
  pruneReplicaFinalizedJHistory(workingReplica);

  const committedFrame = proposal;
  committedFrame.hankos = committedHankos;
  appendCertifiedEntityFrameLink(
    workingReplica,
    buildCertifiedEntityFrameLink(workingReplica.state.entityId, committedFrame, workingReplica.state),
  );
  const committedTxs = committedFrame.txs;
  if (committedTxs.length > 0) {
    workingReplica.mempool = removeCommittedTxsFromMempool(workingReplica.mempool, committedTxs);
  }
  delete workingReplica.proposal;
  delete workingReplica.lockedFrame;
  delete workingReplica.validatorExecution;
  if (proposal.leader.relayCertificate?.preparedFrameHash === proposal.hash) {
    workingReplica.pendingLeaderCertificate = structuredClone(proposal.leader.relayCertificate);
  } else {
    delete workingReplica.pendingLeaderCertificate;
  }
  workingReplica.leaderVotes = new Map();
  workingReplica.lastConsensusProgressAt = env.timestamp;
  workingReplica.isProposer = isEntityActiveLeader(workingReplica);

  const committedProposalHash = committedFrame.hash.slice(0, 10);
  const precommitSigners = Array.from(committedFrame.collectedSigs?.keys() || []);
  entityLog.debug('commit.notify_validators', {
    frame: committedProposalHash,
    validators: workingReplica.state.config.validators.length - 1,
    precommitSigners: precommitSigners.map(shortId),
  });

  workingReplica.state.config.validators.forEach(validatorId => {
    if (validatorId.toLowerCase() === workingReplica.signerId.toLowerCase()) return;
    entityOutbox.push({
      entityId: entityInput.entityId,
      signerId: validatorId,
      proposedFrame: committedFrame,
    });
  });
  await runLocalPostCommitHooks(env, workingReplica, entityOutbox);
  markStorageEntityDirty(env, workingReplica.state.entityId);

  return commitEntityConsensusInput(context);
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
  const trustedLocalCrossJurisdiction = options.trustedLocalRuntimeProtocol === 'cross-j';
  if (trustedLocalCrossJurisdiction && !isSingleSignerEntity(entityReplica.state)) {
    throw new Error(`CROSS_J_LOCAL_COMMAND_SINGLE_SIGNER_REQUIRED:${entityReplica.entityId}`);
  }
  let trustedLocalEntityTxs: EntityTx[] = [];
  const admissionError = getEntityMempoolAdmissionError(
    entityReplica,
    entityInput,
    trustedLocalCrossJurisdiction,
  );
  if (admissionError) {
    log.error(`❌ Entity mempool admission rejected for ${entityInput.entityId}: ${admissionError}`);
    return {
      outcome: { kind: 'rejected', code: 'ENTITY_MEMPOOL_ADMISSION_REJECTED' },
      newState: entityReplica.state,
      outputs: [],
      jOutputs: [],
      workingReplica: entityReplica,
    };
  }

  // Ingress is an immutable retry payload. Consensus normalization attaches
  // canonical signature bundles and committed hankos to its working frame, so
  // it must never mutate the object retained by the Runtime mempool. Otherwise
  // a later same-frame failure would requeue bytes that were never received.
  const ingressEntityInput = entityInput;

  // Validate the exact ingress bytes before the type-aware clone canonicalizes
  // known protocol fields. Otherwise forbidden proposal side effects can be
  // dropped, and malformed iterable signature bundles can become arrays before
  // the strict EntityInput boundary gets a chance to reject them.
  const workingReplica = cloneEntityReplica(entityReplica);
  if (!validateEntityInput(ingressEntityInput)) {
    const detail =
      `entityId=${ingressEntityInput.entityId} ` +
      `txs=${ingressEntityInput.entityTxs?.map(tx => tx.type).join(',') || 'none'}`;
    log.error(`❌ Invalid ingress input for ${ingressEntityInput.entityId}: ${detail}`);
    return {
      outcome: { kind: 'rejected', code: 'ENTITY_INPUT_INVALID' },
      newState: workingReplica.state,
      outputs: [],
      jOutputs: [],
      workingReplica,
    };
  }
  entityInput = cloneIsolatedEntityInput(ingressEntityInput);
  if (ingressEntityInput.leaderTimeoutVote && entityInput.leaderTimeoutVote) {
    copyLocalEntityLeaderTimeoutVoteAuthorization(ingressEntityInput.leaderTimeoutVote, entityInput.leaderTimeoutVote);
  }

  // IMMUTABILITY: Clone replica at function start (fintech-safe, hacker-proof)
  // Prevents state mutations from escaping function scope
  normalizeProposedFrameCollectedSigs(entityInput.proposedFrame);

  const entityDisplay = formatEntityDisplay(entityInput.entityId);
  const timestamp = env.timestamp;
  const quietRuntimeLogs = env.quietRuntimeLogs === true;
  const currentProposalHash = workingReplica.proposal?.hash?.slice(0, 10) || 'none';
  const frameHash = entityInput.proposedFrame?.hash?.slice(0, 10) || 'none';

  if (!quietRuntimeLogs) {
    const hasInputActivity = Boolean(
      (entityInput.entityTxs?.length ?? 0) > 0 ||
      entityInput.proposedFrame ||
      entityInput.hashPrecommits?.size ||
      entityInput.jPrefixAttestations?.size,
    );
    const logInputReceived = hasInputActivity ? entityLog.info : entityLog.debug;
    logInputReceived('input.received', {
      entity: entityDisplay,
      signer: shortId(workingReplica.signerId),
      ts: timestamp,
      txs: entityInput.entityTxs?.map(tx => tx.type) ?? [],
      mempool: workingReplica.mempool.length,
      proposer: workingReplica.isProposer,
      proposal: currentProposalHash,
      frame: frameHash,
      precommits: entityInput.hashPrecommits?.size || 0,
      jPrefixAttestations: entityInput.jPrefixAttestations?.size || 0,
    });
  }
  if (entityInput.hashPrecommits?.size) {
    const precommitSigners = Array.from(entityInput.hashPrecommits.keys());
    if (HEAVY_LOGS) entityLog.debug('input.precommits', { signers: precommitSigners.map(shortId) });
  }

  // SECURITY: Validate all inputs
  if (!validateEntityInput(entityInput)) {
    const detail = `entityId=${entityInput.entityId} txs=${entityInput.entityTxs?.map(tx => tx.type).join(',') || 'none'}`;
    log.error(`❌ Invalid input for ${entityInput.entityId}: ${detail}`);
    return {
      outcome: { kind: 'rejected', code: 'ENTITY_INPUT_INVALID' },
      newState: workingReplica.state,
      outputs: [],
      jOutputs: [],
      workingReplica,
    };
  }
  if (!validateEntityReplica(workingReplica)) {
    log.error(`❌ Invalid replica state for ${workingReplica.entityId}:${workingReplica.signerId}`);
    return {
      outcome: { kind: 'rejected', code: 'ENTITY_REPLICA_INVALID' },
      newState: workingReplica.state,
      outputs: [],
      jOutputs: [],
      workingReplica,
    };
  }

  const entityOutbox: EntityInput[] = [];
  const jOutbox: JInput[] = []; // J-layer outputs
  const phaseContext: ApplyEntityInputContext = {
    env,
    entityInput,
    workingReplica,
    entityOutbox,
    jOutbox,
    frameHash,
  };

  const leaderVoteResult = await handleLeaderTimeoutVote(phaseContext);
  if (leaderVoteResult) return leaderVoteResult;
  const jPrefixResult = handleJPrefixAttestations(phaseContext);
  if (jPrefixResult) return jPrefixResult;
  const quorumSafetyWarning = getEntityQuorumSafetyWarning(workingReplica.state.config);
  if (quorumSafetyWarning && workingReplica.state.height === 0) {
    entityLog.warn('board.quorum_safety', { warning: quorumSafetyWarning });
  }
  const localCanPropose = isReplicaProposalLeader(workingReplica);
  workingReplica.isProposer = localCanPropose;
  if (localCanPropose && entityInput.entityTxs?.some(tx => tx.type === 'j_rebroadcast')) {
    assertLocalJRebroadcastAllowed(workingReplica);
  }

  // Add transactions to mempool (mutable for performance). A durable empty
  // self-wake is also allowed to trigger proposer-local work whose public
  // result must be signed into consensus, such as cross-J pull commitments.
  const suppliedEntityTxs = entityInput.entityTxs ?? [];
  const secretAwareEntityTxs = localCanPropose && suppliedEntityTxs.length > 0
    ? await appendDefaultProposerAcceptedHtlcReveals(env, workingReplica, suppliedEntityTxs)
    : suppliedEntityTxs;
  // The default source-hub signer owns the private cross-J ladder seed. During
  // leader failover it signs its individual materialization command locally;
  // the normal non-leader forwarding path delivers it to the active proposer.
  const admittedEntityTxs = appendDefaultProposerCrossJMaterializations(
    env,
    workingReplica,
    secretAwareEntityTxs,
  );
  if (admittedEntityTxs.length > 0) {
    if (!localCanPropose && workingReplica.lastConsensusProgressAt === undefined) {
      workingReplica.lastConsensusProgressAt = env.timestamp;
    }
    const voteTransactions = suppliedEntityTxs.filter(tx => tx.type === 'vote');
    if (voteTransactions.length > 0) {
      entityLog.debug('vote.mempool', { signer: shortId(workingReplica.signerId), count: voteTransactions.length });
      if (shouldLogFullPayloads()) entityLog.trace('vote.payload', { txs: voteTransactions });
    }

    if (shouldLogFullPayloads()) {
      for (const tx of admittedEntityTxs) {
        entityLog.trace('tx.payload', { type: tx.type, data: tx.data });
      }
    }
    if (trustedLocalCrossJurisdiction) {
      if (!localCanPropose) {
        throw new Error(
          `CROSS_J_LOCAL_COMMAND_PROPOSER_REQUIRED:${workingReplica.entityId}:${workingReplica.signerId}`,
        );
      }
      trustedLocalEntityTxs = prepareLocallyAuthoredEntityTxs(
        env,
        workingReplica.state,
        workingReplica.signerId,
        admittedEntityTxs,
      );
    } else {
      workingReplica.mempool = prioritizeScheduledWakeTransactions(
        prepareLocallyAuthoredEntityTxs(env, workingReplica.state, workingReplica.signerId, [
          ...workingReplica.mempool,
          ...admittedEntityTxs,
        ]),
      );
    }
    entityLog.debug('mempool.added', {
      added: admittedEntityTxs.length,
      external: workingReplica.mempool.length,
      localRuntime: trustedLocalEntityTxs.length,
    });
  }

  // Forward before handling commits so fresh validator txs cannot be cleared by a
  // commit notification in the same tick.
  if (!localCanPropose && workingReplica.mempool.length > 0) {
    const proposerId = getReplicaProposalLeader(workingReplica).activeValidatorId;
    if (!proposerId) {
      throw new Error(`ENTITY_CONSENSUS_FATAL_PROPOSER_MISSING:${workingReplica.state.config.validators.join(',')}`);
    }

    const txCount = workingReplica.mempool.length;
    entityOutbox.push({
      entityId: entityInput.entityId,
      signerId: proposerId,
      entityTxs: [...workingReplica.mempool],
    });

    entityLog.debug('mempool.forwarded_to_proposer', { txs: txCount, proposer: shortId(proposerId) });
  }

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
      accountHasProposableMempool(account, workingReplica.state));
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
      txs: [
        ...trustedLocalEntityTxs,
        ...workingReplica.mempool,
      ].map(tx => tx.type),
    });
  }

  const isSingleSigner = isSingleSignerEntity(workingReplica.state);
  const hasProposableAccountMempool = Array.from(workingReplica.state.accounts.values()).some(
    account => accountHasProposableMempool(account, workingReplica.state),
  );
  let proposalJPrefixCertificate =
    localCanPropose && workingReplica.jPrefixRound
      ? buildJPrefixCertificate(workingReplica.state, workingReplica.jPrefixRound.attestations)
      : null;
  if (proposalJPrefixCertificate && workingReplica.jPrefixRound) {
    workingReplica.jPrefixRound.certificate = proposalJPrefixCertificate;
    if (proposalJPrefixCertificate.selected.scannedThroughHeight > workingReplica.state.lastFinalizedJHeight) {
      const certifiedRange = buildCertifiedJPrefixTx(
        env,
        workingReplica,
        proposalJPrefixCertificate,
        getReplicaProposalLeader(workingReplica).activeValidatorId,
      );
      workingReplica.mempool = prioritizeScheduledWakeTransactions([
        certifiedRange,
        ...workingReplica.mempool.filter(tx => tx.type !== 'j_event'),
      ]);
    }
  }
  const jPrefixProposalBlocked =
    localCanPropose &&
    !proposalJPrefixCertificate &&
    (entityRequiresJPrefixCertificate(workingReplica.state) ||
      hasPendingLocalJEvent(workingReplica.state, workingReplica.jHistory));
  // One signed head per Entity round prevents equivocation. If a validator
  // signed the certified base and only then observed a later J event, it may
  // not replace that vote in-place. Commit exactly one certificate-only frame
  // to open the next round. Requiring pending local evidence is essential:
  // allowing every base certificate to roll would create infinite empty
  // Entity frames while the jurisdiction is idle.
  const shouldRollFrozenBaseJPrefixRound = isFrozenBaseJPrefixRollAuthorized(
    workingReplica,
    proposalJPrefixCertificate,
  );
  const proposalSelection =
    localCanPropose && !jPrefixProposalBlocked
      ? await selectProposableEntityTxs(
          env,
          workingReplica.state,
          trustedLocalCrossJurisdiction ? trustedLocalEntityTxs : workingReplica.mempool,
        )
      : {
          txs: [],
          currentAuthorityReady: false,
          ...(jPrefixProposalBlocked ? { reason: 'J_PREFIX_QUORUM_REQUIRED' } : {}),
        };
  // A frozen-base roll exists only to open a fresh J-prefix voting round.
  // Mixing user/governance work into it lets a proposer keep advancing Entity
  // state while an honest validator has an observed J event, so the queued
  // work remains untouched until the next (stronger) prefix certificate.
  const proposalTxs = shouldRollFrozenBaseJPrefixRound ? [] : proposalSelection.txs;
  if (
    trustedLocalCrossJurisdiction &&
    proposalTxs.length !== trustedLocalEntityTxs.length
  ) {
    throw new Error(
      `CROSS_J_LOCAL_COMMAND_PARTIAL_FRAME_FORBIDDEN:${workingReplica.entityId}:` +
        `selected=${proposalTxs.length}:required=${trustedLocalEntityTxs.length}`,
    );
  }
  if (proposalSelection.reason) {
    entityLog.debug('proposal.authority_gate', {
      reason: proposalSelection.reason,
      selected: proposalTxs.map(tx => tx.type),
      pending: workingReplica.mempool.map(tx => tx.type),
    });
  }

  // Single-signer entities still produce a hash-linked frame; they only skip
  // the multi-validator precommit/commit round trip.
  if (
    localCanPropose &&
    (proposalTxs.length > 0 ||
      shouldRollFrozenBaseJPrefixRound ||
      (proposalSelection.currentAuthorityReady && hasProposableAccountMempool)) &&
    !workingReplica.proposal &&
    isSingleSigner
  ) {
    entityLog.debug('single_signer.execute', { txs: proposalTxs.map(tx => tx.type) });
    const singleSignerLeader = getEntityLeaderState(workingReplica.state);
    assertProposerJRangesMatchLocalHistory(env, workingReplica, proposalTxs);
    assertFrameJPrefix(env, workingReplica, {
      height: workingReplica.state.height + 1,
      parentFrameHash: getPrevFrameHash(workingReplica.state),
      leader: { proposerSignerId: workingReplica.signerId.toLowerCase(), view: singleSignerLeader.view },
      txs: proposalTxs,
      ...(proposalJPrefixCertificate ? { jPrefixCertificate: proposalJPrefixCertificate } : {}),
    });
    const {
      newState: newEntityState,
      outputs: frameOutputs,
      jOutputs: frameJOutputs,
      collectedHashes = [],
      consumptionNodeChanges,
      accountJClaimNodeChanges,
    } = await applyEntityFrame(env, workingReplica.state, proposalTxs, env.timestamp);
    const newHeight = workingReplica.state.height + 1;
    const newTimestamp = env.timestamp;

    const prevFrameHash = getPrevFrameHash(workingReplica.state);
    const singleSignerNewState = {
      ...newEntityState,
      entityId: workingReplica.state.entityId,
      height: newHeight,
      timestamp: newTimestamp,
      leaderState: singleSignerLeader,
    };
    const singleSignerFrameHash = await createEntityFrameHash(
      prevFrameHash,
      newHeight,
      newTimestamp,
      proposalTxs,
      singleSignerNewState,
      proposalJPrefixCertificate ?? undefined,
    );
    const singleSignerStateRoot = computeCanonicalEntityConsensusStateHash(singleSignerNewState);
    const singleSignerAuthorityRoot = computeEntityFrameAuthorityRoot(buildEntityFrameAuthority(singleSignerNewState));
    const singleSignerOutputHashes = buildCertifiedEntityOutputHashes(
      singleSignerNewState,
      env,
      newHeight,
      singleSignerFrameHash,
      frameOutputs,
    );

    const hashesToSign = buildEntityHashesToSign(workingReplica.state.entityId, newHeight, singleSignerFrameHash, [
      ...collectedHashes,
      ...singleSignerOutputHashes,
    ]);

    const hankos = await signEntityHashes(
      env,
      workingReplica.state.entityId,
      workingReplica.signerId,
      hashesToSign.map(hashInfo => hashInfo.hash),
      singleSignerNewState,
    );
    const collectedSigs = new Map<string, string[]>([
      [
        workingReplica.signerId.toLowerCase(),
        await Promise.all(hashesToSign.map(hashInfo => signFrame(env, workingReplica.signerId, hashInfo.hash))),
      ],
    ]);

    if (!workingReplica.hankoWitness) {
      workingReplica.hankoWitness = new Map();
    }
    for (let i = 0; i < hashesToSign.length; i++) {
      const hashInfo = hashesToSign[i];
      const hanko = hankos[i];
      if (!hashInfo || !hanko) continue;
      if (!isWitnessHashType(hashInfo.type)) continue;
      workingReplica.hankoWitness.set(hashInfo.hash, {
        hanko,
        type: hashInfo.type,
        entityHeight: newHeight,
        createdAt: newTimestamp,
      });
    }
    const sealedStateCount = sealHankoWitnessInState(
      singleSignerNewState,
      workingReplica.hankoWitness as Map<string, HankoWitnessEntry>,
      newHeight,
    );
    const attachedHankos = attachHankoWitnessToOutputs(
      frameOutputs,
      frameJOutputs,
      workingReplica.hankoWitness as Map<string, HankoWitnessEntry>,
      newHeight,
      singleSignerNewState,
    );
    pruneHankoWitnessToReachableState(
      singleSignerNewState,
      workingReplica.hankoWitness as Map<string, HankoWitnessEntry>,
    );
    if (attachedHankos > 0 || sealedStateCount > 0) {
      entityLog.debug('single_signer.hankos_attached', { count: attachedHankos, stateCount: sealedStateCount });
    }

    const singleSignerFrame: ProposedEntityFrame = {
      height: newHeight,
      parentFrameHash: prevFrameHash,
      stateRoot: singleSignerStateRoot,
      authorityRoot: singleSignerAuthorityRoot,
      timestamp: newTimestamp,
      txs: [...proposalTxs],
      hash: singleSignerFrameHash,
      leader: {
        proposerSignerId: workingReplica.signerId.toLowerCase(),
        view: singleSignerLeader.view,
      },
      ...(proposalJPrefixCertificate ? { jPrefixCertificate: structuredClone(proposalJPrefixCertificate) } : {}),
      hashesToSign,
      collectedSigs,
      hankos,
    };
    const commitOutputs = wrapCertifiedEntityOutputs(
      frameOutputs,
      singleSignerFrame,
      singleSignerNewState,
      env,
      hashesToSign,
      hankos,
      true,
    );

    const preCommitState = workingReplica.state;
    const committedState = {
      ...singleSignerNewState,
      prevFrameHash: singleSignerFrameHash,
    };
    const entitySizeLog = prepareCommittedEntitySizeLog(env, preCommitState, committedState);
    cacheCommittedConsumptionNodeChanges(env, consumptionNodeChanges);
    cacheCommittedAccountJClaimNodeChanges(env, accountJClaimNodeChanges);
    workingReplica.state = committedState;
    emitCommittedPendingFrameWarnings(preCommitState, committedState);
    emitCommittedEntitySizeLog(entitySizeLog);
    appendCertifiedEntityFrameLink(
      workingReplica,
      buildCertifiedEntityFrameLink(workingReplica.state.entityId, singleSignerFrame, workingReplica.state),
    );
    pruneReplicaFinalizedJHistory(workingReplica);
    await runLocalPostCommitHooks(env, workingReplica, entityOutbox);
    workingReplica.lastConsensusProgressAt = env.timestamp;
    markStorageEntityDirty(env, workingReplica.state.entityId);

    entityOutbox.push(...commitOutputs);
    jOutbox.push(...frameJOutputs);

    workingReplica.mempool = removeCommittedTxsFromMempool(workingReplica.mempool, proposalTxs);
    return {
      outcome: { kind: 'committed' },
      newState: workingReplica.state,
      outputs: entityOutbox,
      jOutputs: jOutbox,
      workingReplica,
      ...(phaseContext.canonicalAppliedInput
        ? { canonicalAppliedInput: phaseContext.canonicalAppliedInput }
        : {}),
    };
  }

  const relayCertificate = workingReplica.pendingLeaderCertificate;
  if (
    !isSingleSigner &&
    localCanPropose &&
    !workingReplica.proposal &&
    relayCertificate?.targetHeight === workingReplica.state.height + 1 &&
    relayCertificate?.preparedFrameHash
  ) {
    const preparedFrame = workingReplica.lockedFrame;
    if (!preparedFrame || preparedFrame.hash !== relayCertificate.preparedFrameHash) {
      throw new Error(
        `ENTITY_PREPARED_RELAY_FRAME_MISSING:expected=${relayCertificate.preparedFrameHash}:` +
          `actual=${preparedFrame?.hash ?? 'none'}`,
      );
    }
    workingReplica.validatorExecution = await replayPreparedFrameForRelay(env, workingReplica, preparedFrame);
    workingReplica.proposal = cloneIsolatedProposedEntityFrame(preparedFrame);
    workingReplica.proposal.leader.relayCertificate =
      cloneIsolatedEntityLeaderCertificate(relayCertificate);
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
      view: relayCertificate.toView,
    });
  }

  const hasCertifiedLeaderTransition = Boolean(
    workingReplica.pendingLeaderCertificate &&
    workingReplica.pendingLeaderCertificate.targetHeight === workingReplica.state.height + 1 &&
    !workingReplica.pendingLeaderCertificate.preparedFrameHash,
  );
  if (
    !isSingleSigner &&
    localCanPropose &&
    (proposalTxs.length > 0 ||
      shouldRollFrozenBaseJPrefixRound ||
      (proposalSelection.currentAuthorityReady && (hasProposableAccountMempool || hasCertifiedLeaderTransition))) &&
    !workingReplica.proposal &&
    !workingReplica.lockedFrame
  ) {
    entityLog.debug('proposal.auto_start', {
      mempool: proposalTxs.length,
      txs: proposalTxs.map(tx => tx.type),
    });
    const leader = getReplicaProposalLeader(workingReplica);
    assertProposerJRangesMatchLocalHistory(env, workingReplica, proposalTxs);
    assertFrameJPrefix(env, workingReplica, {
      height: workingReplica.state.height + 1,
      parentFrameHash: getPrevFrameHash(workingReplica.state),
      leader: { proposerSignerId: workingReplica.signerId.toLowerCase(), view: leader.view },
      txs: proposalTxs,
      ...(proposalJPrefixCertificate ? { jPrefixCertificate: proposalJPrefixCertificate } : {}),
    });
    const {
      newState: newEntityState,
      outputs: proposalOutputs,
      jOutputs: proposalJOutputs,
      collectedHashes = [],
      consumptionNodeChanges,
      accountJClaimNodeChanges,
    } = await applyEntityFrame(env, workingReplica.state, proposalTxs, env.timestamp);

    // Outputs are stored on the proposal and emitted only after quorum hankos are
    // available. Re-applying at commit would duplicate side effects.

    const newTimestamp = env.timestamp;
    const newHeight = workingReplica.state.height + 1;

    // Build proposed new state (full state with account proposals — for commit)
    const committedLeaderState = {
      activeValidatorId: workingReplica.signerId.toLowerCase(),
      view: leader.view,
      changedAtHeight: workingReplica.pendingLeaderCertificate
        ? newHeight
        : (workingReplica.state.leaderState?.changedAtHeight ?? 0),
    };
    const proposedNewState = {
      ...newEntityState,
      entityId: workingReplica.state.entityId,
      height: newHeight,
      timestamp: newTimestamp,
      leaderState: committedLeaderState,
    };

    const prevFrameHash = getPrevFrameHash(workingReplica.state);
    const frameHash = await createEntityFrameHash(
      prevFrameHash,
      newHeight,
      newTimestamp,
      proposalTxs,
      proposedNewState,
      proposalJPrefixCertificate ?? undefined,
    );
    const stateRoot = computeCanonicalEntityConsensusStateHash(proposedNewState);
    const authorityRoot = computeEntityFrameAuthorityRoot(buildEntityFrameAuthority(proposedNewState));
    const outputHashes = buildCertifiedEntityOutputHashes(proposedNewState, env, newHeight, frameHash, proposalOutputs);
    const hashesToSign = buildEntityHashesToSign(workingReplica.state.entityId, newHeight, frameHash, [
      ...collectedHashes,
      ...outputHashes,
    ]);

    await assertEntityConfigBoardAuthority(
      env,
      workingReplica.state.entityId,
      workingReplica.state.config,
      proposedNewState,
    );
    const selfSigs = await Promise.all(hashesToSign.map(h => signFrame(env, workingReplica.signerId, h.hash)));

    const proposal: ProposedEntityFrame = {
      height: newHeight,
      parentFrameHash: prevFrameHash,
      stateRoot,
      authorityRoot,
      txs: [...proposalTxs],
      hash: frameHash,
      timestamp: newTimestamp,
      leader: {
        proposerSignerId: workingReplica.signerId.toLowerCase(),
        view: leader.view,
        ...(workingReplica.pendingLeaderCertificate ? { certificate: workingReplica.pendingLeaderCertificate } : {}),
      },
      ...(proposalJPrefixCertificate ? { jPrefixCertificate: structuredClone(proposalJPrefixCertificate) } : {}),
      hashesToSign,
      collectedSigs: new Map([[workingReplica.signerId, selfSigs]]),
    };
    workingReplica.proposal = proposal;
    workingReplica.validatorExecution = {
      frameHash,
      height: newHeight,
      state: proposedNewState,
      outputs: proposalOutputs,
      jOutputs: proposalJOutputs,
      hashesToSign,
      ...(consumptionNodeChanges ? { consumptionNodeChanges } : {}),
      ...(accountJClaimNodeChanges ? { accountJClaimNodeChanges } : {}),
    };

    entityLog.debug('proposal.created', {
      frame: shortHash(proposal.hash),
      txs: proposal.txs.length,
      hashes: hashesToSign.length,
    });

    workingReplica.state.config.validators.forEach(validatorId => {
      if (validatorId !== workingReplica.signerId) {
        entityOutbox.push({
          entityId: entityInput.entityId,
          signerId: validatorId,
          proposedFrame: proposal,
        });
      }
    });
  }

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
    ...(phaseContext.canonicalAppliedInput
      ? { canonicalAppliedInput: phaseContext.canonicalAppliedInput }
      : {}),
  };
};

type ApplyEntityTxsInOrderContext = {
  env: Env;
  entityTxs: EntityTx[];
  currentEntityState: EntityState;
  allOutputs: EntityInput[];
  allJOutputs: JInput[];
  collectedHashes: Array<{ hash: string; type: HashType; context: string }>;
  proposableAccounts: Set<string>;
  allSwapOffersCreated: SwapOfferEvent[];
  allSwapCancelRequests: SwapCancelRequestEvent[];
  allSwapOffersCancelled: SwapCancelEvent[];
  frameProfileTxTotals: Map<string, { count: number; elapsedMs: number }>;
  consumptionNewNodes: Map<string, ConsumptionNode>;
  consumptionReplacedNodeHashes: Set<string>;
  accountJClaimNewNodes: Map<string, AccountJClaimNode>;
  accountJClaimReplacedNodeHashes: Set<string>;
  accountJClaimNodeStore: AccountJClaimNodeStore;
  /** Set only after the enclosing SignedEntityCommand has been fully verified. */
  authorizedCommand?: true | undefined;
  /** Set only when a signed proposal has reached real weighted board quorum. */
  authorizedCollective?: true | undefined;
  /** Exact source-board Hanko lane for cross-Entity certified outputs. */
  authorizedCertifiedOutput?: true | undefined;
  /** Runtime-local proposer trust lane for cross-j sibling effects. */
  authorizedRuntimeOutput?: true | undefined;
};

const applyRuntimeOutput = async (
  context: ApplyEntityTxsInOrderContext,
  currentEntityState: EntityState,
  tx: Extract<EntityTx, { type: 'runtimeOutput' }>,
): Promise<EntityState> => {
  if (tx.data.protocol !== 'cross-j') throw new Error(`RUNTIME_OUTPUT_PROTOCOL_INVALID:${tx.data.protocol}`);
  assertRuntimeOutputAuthorization(
    tx.data.sourceEntityId,
    tx.data.targetEntityId,
    tx.data.entityTxs,
    currentEntityState,
  );
  return applyEntityTxsInOrder({
    ...context,
    entityTxs: tx.data.entityTxs,
    currentEntityState,
    authorizedRuntimeOutput: true,
  });
};

const applyCertifiedConsensusOutput = async (
  context: ApplyEntityTxsInOrderContext,
  currentEntityState: EntityState,
  tx: Extract<EntityTx, { type: 'consensusOutput' }>,
): Promise<EntityState> => {
  const { origin, targetEntityId, entityTxs, outputHash } = await verifyCertifiedEntityOutput(
    context.env,
    currentEntityState,
    tx,
  );

  const identity = buildConsumptionOutputIdentity(origin, targetEntityId, outputHash, tx.data.outputHanko);
  const consumption = applyConsumptionOutput(
    currentEntityState.consumptionAccumulator ?? createEmptyConsumptionAccumulator(),
    identity,
    tx.data.consumptionProof,
  );
  if (consumption.status === 'idempotent' || consumption.status === 'stale') return currentEntityState;
  if (consumption.status === 'gap') {
    throw new Error(
      `CONSENSUS_OUTPUT_SEQUENCE_GAP:source=${origin.sourceEntityId}:lane=${origin.lane}:` +
        `received=${origin.sequence}`,
    );
  }
  for (const { hash, node } of consumption.newNodes) {
    context.consumptionNewNodes.set(hash, node);
    context.consumptionReplacedNodeHashes.delete(hash);
  }
  for (const hash of consumption.replacedNodeHashes) {
    if (!context.consumptionNewNodes.delete(hash)) {
      context.consumptionReplacedNodeHashes.add(hash);
    }
  }
  if (consumption.status === 'quarantined') {
    if (consumption.newNodes.length > 0) {
      logError('FRAME_CONSENSUS', 'Certified output relationship quarantined after current-sequence equivocation', {
        sourceEntityId: origin.sourceEntityId,
        targetEntityId,
        lane: origin.lane,
        sequence: origin.sequence.toString(),
        acceptedRoot: currentEntityState.consumptionAccumulator?.root ?? 'empty',
        quarantineRoot: consumption.state.root,
      });
      return { ...currentEntityState, consumptionAccumulator: consumption.state };
    }
    throw new Error(
      `CONSENSUS_OUTPUT_RELATIONSHIP_QUARANTINED:${origin.sourceEntityId}:${targetEntityId}:${origin.lane}`,
    );
  }

  const applied = await applyEntityTxsInOrder({
    ...context,
    entityTxs,
    currentEntityState,
    // The exact nested transaction bytes were already bound to outputHash and
    // verified against the source Entity board Hanko above. Requiring a target
    // user's EntityCommand as well would let the target rewrite or block an
    // already-certified cross-Entity effect.
    authorizedCertifiedOutput: true,
  });
  return { ...applied, consumptionAccumulator: consumption.state };
};

async function applyEntityTxsInOrder(context: ApplyEntityTxsInOrderContext): Promise<EntityState> {
  const {
    env,
    entityTxs,
    allOutputs,
    allJOutputs,
    collectedHashes,
    proposableAccounts,
    allSwapOffersCreated,
    allSwapCancelRequests,
    allSwapOffersCancelled,
    frameProfileTxTotals,
  } = context;
  let currentEntityState = context.currentEntityState;
  const manualBroadcastInInput = entityTxs.some(tx => tx.type === 'j_broadcast');

  // Preserve WAL transaction order exactly during live processing and replay.
  // Reordering batched txs can change bilateral account state transitions
  // (e.g., openAccount + accountInput ACK in same frame).
  for (const entityTx of entityTxs) {
    if (entityTx.type === 'runtimeOutput') {
      currentEntityState = await applyRuntimeOutput(context, currentEntityState, entityTx);
      continue;
    }
    if (entityTx.type === 'consensusOutput') {
      currentEntityState = await applyCertifiedConsensusOutput(context, currentEntityState, entityTx);
      continue;
    }
    if (entityTx.type === 'entityCommand') {
      const command = assertSignedEntityCommand(env, currentEntityState, entityTx.data);
      if (getEntityCommandDisposition(currentEntityState, command) === 'retry') continue;
      const applied = await applyEntityTxsInOrder({
        ...context,
        entityTxs: command.txs,
        currentEntityState,
        authorizedCommand: true,
      });
      currentEntityState = advanceEntityCommandNonce(applied, command);
      continue;
    }
    if (!isEntityCommandForbiddenTx(entityTx)) {
      if (context.authorizedCommand && !isIndividualEntityCommandTx(entityTx)) {
        throw new Error(`ENTITY_COMMAND_COLLECTIVE_ACTION_REQUIRES_PROPOSAL:${entityTx.type}`);
      }
      if (context.authorizedCollective && !isCollectiveEntityActionTx(entityTx)) {
        throw new Error(`ENTITY_COLLECTIVE_ACTION_TX_FORBIDDEN:${entityTx.type}`);
      }
      if (
        !context.authorizedCommand &&
        !context.authorizedCollective &&
        !context.authorizedCertifiedOutput &&
        !context.authorizedRuntimeOutput
      ) {
        throw new Error(`ENTITY_COMMAND_REQUIRED:${entityTx.type}`);
      }
    }
    const txProfileStartMs = getPerfMs();
    const {
      newState,
      outputs,
      jOutputs,
      hashesToSign,
      mempoolOps,
      dirtyAccounts,
      swapOffersCreated,
      swapCancelRequests,
      swapOffersCancelled,
      accountJClaimNodeChanges,
      approvedEntityTxs,
      skippedError,
    } = await applyEntityTx(env, currentEntityState, entityTx, {
      mutableFrameState: true,
      manualBroadcastInInput,
      accountJClaimNodeStore: context.accountJClaimNodeStore,
    });
    if (skippedError) {
      throw new Error(`ENTITY_FRAME_TX_FAILED: type=${String(entityTx.type)} error=${skippedError}`);
    }
    currentEntityState = newState;
    if (accountJClaimNodeChanges) {
      for (const { hash, node } of accountJClaimNodeChanges.newNodes) {
        context.accountJClaimNewNodes.set(hash, node);
        context.accountJClaimReplacedNodeHashes.delete(hash);
      }
      for (const hash of accountJClaimNodeChanges.replacedNodeHashes) {
        if (!context.accountJClaimNewNodes.delete(hash)) context.accountJClaimReplacedNodeHashes.add(hash);
      }
    }
    if (approvedEntityTxs && approvedEntityTxs.length > 0) {
      currentEntityState = await applyEntityTxsInOrder({
        ...context,
        entityTxs: approvedEntityTxs,
        currentEntityState,
        authorizedCommand: undefined,
        authorizedCollective: true,
        authorizedCertifiedOutput: undefined,
        authorizedRuntimeOutput: undefined,
      });
    }
    for (const accountId of dirtyAccounts || []) {
      markStorageAccountDirty(env, currentEntityState.entityId, accountId);
    }

    allOutputs.push(...outputs);
    if (jOutputs) allJOutputs.push(...jOutputs);
    if (hashesToSign && hashesToSign.length > 0) {
      collectedHashes.push(...hashesToSign);
    }

    // Entity handlers return mempoolOps; this orchestrator is the only place
    // that mutates account.mempool during entity-frame application.
    if (mempoolOps && mempoolOps.length > 0) {
      for (const { accountId, tx } of mempoolOps) {
        const account = currentEntityState.accounts.get(accountId);
        if (tx.type === 'cross_swap_fill_ack' && !account?.swapOffers?.has(tx.data.offerId)) {
          const routed = buildCrossJurisdictionFillNoticeOutput(currentEntityState, accountId, tx);
          if (!routed) {
            if (ownsSourceHubRouteForFillAck(currentEntityState, tx)) {
              stashPendingCrossJurisdictionFillAck(
                env,
                currentEntityState,
                accountId,
                tx,
                account ? 'source_offer_not_committed' : 'source_account_not_committed',
              );
              continue;
            }
            throw new Error(
              `CROSS_J_FILL_ACK_ACCOUNT_OFFER_MISSING: account=${accountId} offer=${tx.data.offerId} ` +
                `entity=${currentEntityState.entityId}`,
            );
          }
          allOutputs.push(routed);
          entityLog.info('crossj.sibling_fill_notice_routed', {
            owner: shortId(routed.entityId, 8),
            account: shortId(accountId, 8),
            offer: shortOrder(tx.data.offerId, 8),
          });
          continue;
        }
        if (account) {
          if (!queueAccountMempoolTx(account, tx)) {
            continue;
          }
          proposableAccounts.add(accountId);
          markStorageAccountDirty(env, currentEntityState.entityId, accountId);
          markStorageEntityDirty(env, currentEntityState.entityId);

          if (tx.type === 'htlc_lock' && tx.data?.timelock && tx.data?.lockId) {
            if (currentEntityState.crontabState) {
              scheduleCrontabHook(currentEntityState.crontabState, {
                id: `htlc-timeout:${tx.data.lockId}`,
                triggerAt: Number(tx.data.timelock),
                type: 'htlc_timeout',
                data: { accountId, lockId: tx.data.lockId },
              });
              markStorageEntityDirty(env, currentEntityState.entityId);
            }
          }

          if (tx.type === 'htlc_resolve' && tx.data?.lockId) {
            if (currentEntityState.crontabState) {
              cancelCrontabHook(currentEntityState.crontabState, `htlc-timeout:${tx.data.lockId}`);
              markStorageEntityDirty(env, currentEntityState.entityId);
            }
          }
        } else if (tx.type === 'cross_swap_fill_ack') {
          throw new Error(
            `CROSS_J_FILL_ACK_ACCOUNT_MISSING: account=${accountId} offer=${tx.data.offerId} entity=${currentEntityState.entityId}`,
          );
        } else {
          entityLog.warn('mempool_op.account_missing', { account: shortId(accountId, 8), tx: tx.type });
        }
      }
    }

    if (swapOffersCreated) {
      for (const offer of swapOffersCreated) {
        // Every cross-j offer still passes through the canonical admission gate
        // in applyOrderbookMatching: non-owners are ignored and incomplete
        // source/target receipts remain pending. Do not filter by the outer
        // EntityTx type here. When the canonical source hub commits its Account
        // pull, the second receipt and swap_offer can become authoritative in
        // this accountInput itself; dropping that pure event leaves an admitted
        // route permanently absent from the shared book.
        allSwapOffersCreated.push(offer);
      }
    }
    if (swapCancelRequests) {
      for (const cancel of swapCancelRequests) {
        const offer = currentEntityState.accounts.get(cancel.accountId)?.swapOffers?.get(cancel.offerId);
        if (
          offer?.crossJurisdiction &&
          normalizeEntityRef(currentEntityState.entityId) !==
            normalizeEntityRef(offer.crossJurisdiction.source.counterpartyEntityId)
        ) {
          // Both Account replicas observe the committed request, but only the
          // source hub owns the order lifecycle. The source user must not run a
          // local orderbook fallback or send a diagonal Entity message.
          continue;
        }
        allSwapCancelRequests.push(cancel);
      }
    }
    if (swapOffersCancelled) allSwapOffersCancelled.push(...swapOffersCancelled);

    if (entityTx.type === 'accountInput' && entityTx.data) {
      const fromEntity = entityTx.data.fromEntityId;
      const accountMachine = currentEntityState.accounts.get(fromEntity);

      if (accountMachine) {
        if (accountHasProposableMempool(accountMachine, currentEntityState)) {
          proposableAccounts.add(fromEntity);
        }
      }
    } else if (entityTx.type === 'directPayment' && entityTx.data) {
      for (const [counterpartyId, accountMachine] of currentEntityState.accounts) {
        if (accountHasProposableMempool(accountMachine, currentEntityState)) {
          proposableAccounts.add(counterpartyId);
        }
      }
    } else if (entityTx.type === 'openAccount' && entityTx.data) {
      const targetEntity = entityTx.data.targetEntityId;
      const accountMachine = currentEntityState.accounts.get(targetEntity);
      if (accountMachine) {
        if (accountHasProposableMempool(accountMachine, currentEntityState)) {
          proposableAccounts.add(targetEntity);
        }
      }
    } else if (entityTx.type === 'extendCredit' && entityTx.data) {
      const counterpartyId = entityTx.data.counterpartyEntityId;
      const accountMachine = currentEntityState.accounts.get(counterpartyId);
      if (accountMachine && accountHasProposableMempool(accountMachine, currentEntityState)) {
        proposableAccounts.add(counterpartyId);
      }
    }
    drainPendingCrossJurisdictionFillAcks(env, currentEntityState, proposableAccounts);
    drainCommittedCrossJurisdictionCancelAcks(env, currentEntityState, proposableAccounts);
    const txElapsedMs = Math.round(getPerfMs() - txProfileStartMs);
    const txProfile = frameProfileTxTotals.get(entityTx.type) ?? { count: 0, elapsedMs: 0 };
    txProfile.count += 1;
    txProfile.elapsedMs += txElapsedMs;
    frameProfileTxTotals.set(entityTx.type, txProfile);
  }

  return currentEntityState;
}

type ProposePendingAccountFramesContext = {
  env: Env;
  currentEntityState: EntityState;
  proposableAccounts: Set<string>;
  allOutputs: EntityInput[];
  collectedHashes: Array<{ hash: string; type: HashType; context: string }>;
  accountJClaimNodeStore: AccountJClaimNodeStore;
};

const certifiedAccountOutputSignerHint = (
  targetEntityId: string,
  input: AccountInput,
): string | null => {
  const proposal = accountInputProposal(input);
  if (!proposal) return null;
  const target = targetEntityId.toLowerCase();
  const signerIds = new Set<string>();
  for (const tx of proposal.frame.accountTxs) {
    if (tx.type !== 'htlc_lock') continue;
    const encryptedLayer = encryptedHtlcLayer(tx.data.envelope);
    if (!encryptedLayer) continue;
    const expectedContextHash = computeHtlcEnvelopeContextHash({
      entityId: target,
      lockId: tx.data.lockId,
      hashlock: tx.data.hashlock,
      tokenId: tx.data.tokenId,
      amount: tx.data.amount,
      timelock: tx.data.timelock,
      revealBeforeHeight: tx.data.revealBeforeHeight,
    });
    const canonicalLayer = validateMultiRecipientCiphertext(
      encryptedLayer,
      target,
      expectedContextHash,
    );
    const signerId = String(canonicalLayer.recipients[0]?.signerId || '').trim().toLowerCase();
    if (!signerId) throw new Error(`ACCOUNT_OUTPUT_CERTIFIED_SIGNER_MISSING:${tx.data.lockId}`);
    signerIds.add(signerId);
  }
  if (signerIds.size > 1) {
    throw new Error(
      `ACCOUNT_OUTPUT_CERTIFIED_SIGNER_CONFLICT:${target}:${[...signerIds].sort().join(',')}`,
    );
  }
  return signerIds.values().next().value ?? null;
};

function materializeDeferredSettlementApprovals(
  env: Env,
  state: EntityState,
  proposableAccounts: Set<string>,
  collectedHashes: Array<{ hash: string; type: HashType; context: string }>,
): void {
  const deferred = state.deferredAccountProposals;
  if (!deferred || deferred.size === 0) return;
  for (const [accountId, approvedHash] of [...deferred.entries()].sort(([left], [right]) => compareStableText(left, right))) {
    const account = state.accounts.get(accountId);
    if (!account) throw new Error(`SETTLEMENT_DEFERRED_ACCOUNT_MISSING:${accountId}`);
    if (account.pendingFrame || hasPendingSettlementTransition(account)) continue;
    const workspace = account.settlementWorkspace;
    const currentHash = workspace ? assertCanonicalSettlementWorkspace(account, workspace) : undefined;
    if (!workspace || currentHash !== approvedHash) {
      deferred.delete(accountId);
      entityLog.warn('settlement.approval_invalidated', {
        account: shortId(accountId),
        approvedHash: shortHash(approvedHash),
        currentHash: currentHash ? shortHash(currentHash) : 'missing',
      });
      addMessages(state, [`⚠️ Settlement approval expired because the workspace changed`]);
      continue;
    }
    const peerSealPinsAccountState = Boolean(
      workspace.settlementHash ||
      workspace.leftHanko ||
      workspace.rightHanko ||
      workspace.postSettlementDisputeProof,
    );
    // An unsigned workspace must wait for ordinary Account work to drain: that
    // work can change the post-settlement proof we are about to sign. Once a
    // peer seal pins the proof, however, ordinary financial txs are frozen and
    // cannot drain. Waiting for an empty mempool then deadlocks the only exact
    // counter-seal that can finalize the settlement. Keep those txs queued;
    // proposeAccountFrame skips them and applies the counter-seal unchanged.
    if (account.mempool.length > 0 && !peerSealPinsAccountState) continue;
    const draft = buildSettlementSealDraft(account, state, accountId, env);
    appendAccountMempoolTx(account, draft.tx, `entityConsensus:settlementSeal:${accountId}`);
    collectedHashes.push(...draft.hashesToSign);
    proposableAccounts.add(accountId);
    deferred.delete(accountId);
  }
}

async function proposePendingAccountFrames(context: ProposePendingAccountFramesContext): Promise<number> {
  const { env, currentEntityState, proposableAccounts, allOutputs, collectedHashes, accountJClaimNodeStore } = context;
  const accountsToProposeFrames = Array.from(proposableAccounts)
    .filter(accountId => {
      const accountMachine = currentEntityState.accounts.get(accountId);
      if (!accountMachine) {
        return false;
      }
      return accountHasProposableMempool(accountMachine, currentEntityState);
    })
    .sort();

  for (const accountKey of accountsToProposeFrames) {
    const accountMachine = currentEntityState.accounts.get(accountKey);
    const { counterparty: cpId } = accountMachine
      ? getAccountPerspective(accountMachine, currentEntityState.entityId)
      : { counterparty: 'unknown' };
    if (!accountMachine) continue;

    const proposal = await proposeAccountFrame(
      env,
      accountMachine,
      currentEntityState.timestamp,
      currentEntityState.lastFinalizedJHeight,
      accountJClaimNodeStore,
    );
    if (proposal.swapOffersCancelled && proposal.swapOffersCancelled.length > 0) {
      const normalizedCancels = proposal.swapOffersCancelled.map(({ offerId }) => ({
        accountId: accountKey,
        offerId,
      }));
      applyCommittedSwapCancelsToOrderbook(env, currentEntityState, normalizedCancels);
    }
    if (proposal.hashesToSign) {
      collectedHashes.push(...proposal.hashesToSign);
    }

    if (proposal.failedHtlcLocks && proposal.failedHtlcLocks.length > 0) {
      for (const { hashlock, reason } of proposal.failedHtlcLocks) {
        const route = currentEntityState.htlcRoutes.get(hashlock);
        if (route) {
          // Always clean local bookkeeping for failed proposals.
          if (route.outboundLockId) {
            currentEntityState.lockBook.delete(route.outboundLockId);
          }

          if (route.inboundEntity && route.inboundLockId) {
            const inboundAccount = currentEntityState.accounts.get(route.inboundEntity);
            if (inboundAccount) {
              appendAccountMempoolTx(
                inboundAccount,
                {
                  type: 'htlc_resolve',
                  data: {
                    lockId: route.inboundLockId,
                    outcome: 'error' as const,
                    reason: `forward_failed:${reason}`,
                  },
                },
                `entityConsensus:failedHtlc:${route.inboundEntity}`,
              );
              proposableAccounts.add(route.inboundEntity);
            }
          }

          terminateHtlcRoute(currentEntityState, hashlock, currentEntityState.timestamp);
        }
      }
    }

    if (proposal.success && proposal.accountInput) {
      const encryptedTargetSignerId = certifiedAccountOutputSignerHint(
        proposal.accountInput.toEntityId,
        proposal.accountInput,
      );
      const certifiedTargetSignerId = await resolveCertifiedAccountCounterpartyProposer(
        env,
        accountMachine,
        proposal.accountInput.toEntityId,
      );
      if (
        encryptedTargetSignerId &&
        certifiedTargetSignerId &&
        encryptedTargetSignerId !== certifiedTargetSignerId
      ) {
        throw new Error(
          `ACCOUNT_OUTPUT_SIGNER_HINT_CONFLICT:${proposal.accountInput.toEntityId}:` +
          `${encryptedTargetSignerId}:${certifiedTargetSignerId}`,
        );
      }
      const targetSignerId = encryptedTargetSignerId ?? certifiedTargetSignerId ?? resolveEntityProposerId(
          env,
          proposal.accountInput.toEntityId,
          `account proposal output ${currentEntityState.entityId}->${proposal.accountInput.toEntityId}`,
        );
      // Persist validator-local delivery metadata beside the cached input so a
      // post-checkpoint resend does not require gossip to be online first.
      // The field is intentionally excluded from Entity consensus roots.
      accountMachine.pendingAccountInputSignerId = targetSignerId;
      const outputEntityInput: EntityInput = {
        entityId: proposal.accountInput.toEntityId,
        signerId: targetSignerId,
        entityTxs: [
          {
            type: 'accountInput' as const,
            data: proposal.accountInput,
          },
        ],
      };
      allOutputs.push(outputEntityInput);

      addMessages(currentEntityState, proposal.events);
      emitScopedEvents(
        env,
        'account',
        `E/A/${currentEntityState.entityId.slice(-4)}:${cpId.slice(-4)}/propose`,
        proposal.events,
        {
          entityId: currentEntityState.entityId,
          counterpartyId: cpId,
          frameHeight: accountInputReferenceHeight(proposal.accountInput),
          accountKey,
        },
        currentEntityState.entityId,
      );
    }
  }

  return accountsToProposeFrames.length;
}

type ApplyOrderbookMatchingContext = {
  env: Env;
  currentEntityState: EntityState;
  allSwapOffersCreated: SwapOfferEvent[];
  allOutputs: EntityInput[];
  proposableAccounts: Set<string>;
};

type OrderbookFrameStats = {
  hasPersistedCrossJurisdictionBook: boolean;
  orderbookMatched: boolean;
  orderbookMempoolOps: number;
  orderbookBookUpdates: number;
  orderbookCrossFills: number;
};

const emptyOrderbookFrameStats = (): OrderbookFrameStats => ({
  hasPersistedCrossJurisdictionBook: false,
  orderbookMatched: false,
  orderbookMempoolOps: 0,
  orderbookBookUpdates: 0,
  orderbookCrossFills: 0,
});

function applyOrderbookMatching(context: ApplyOrderbookMatchingContext): OrderbookFrameStats {
  const { env, currentEntityState, allSwapOffersCreated, allOutputs, proposableAccounts } = context;
  const stats = emptyOrderbookFrameStats();
  stats.hasPersistedCrossJurisdictionBook = Boolean(
    currentEntityState.orderbookExt &&
    Array.from(currentEntityState.orderbookExt.books?.keys?.() || []).some(pairId =>
      String(pairId).startsWith('cross:'),
    ),
  );
  if (
    (allSwapOffersCreated.length === 0 && !stats.hasPersistedCrossJurisdictionBook) ||
    !currentEntityState.orderbookExt
  ) {
    return stats;
  }

  entityLog.debug('orderbook.matching', {
    offers: allSwapOffersCreated.length,
    hasPersistedCrossJurisdictionBook: stats.hasPersistedCrossJurisdictionBook,
  });

  const enrichedOffers = allSwapOffersCreated.map(offer => {
    // The hub's account map is keyed by counterparty. The maker side can be
    // either left or right, so derive accountId from the side opposite hub.
    const hubId = currentEntityState.entityId;
    const hubEntity = normalizeEntityRef(hubId);
    const fromEntity = normalizeEntityRef(offer.fromEntity);
    const toEntity = normalizeEntityRef(offer.toEntity);
    const counterparty = fromEntity === hubEntity ? toEntity : fromEntity;
    return normalizeSwapOfferForOrderbook(offer, counterparty);
  });
  const seenOfferKeys = new Set<string>();
  const offersToMatch: WorkingOrderbookOffer[] = [];
  for (const offer of enrichedOffers) {
    const key = swapKey(offer.accountId, offer.offerId);
    if (seenOfferKeys.has(key)) continue;
    seenOfferKeys.add(key);
    if (
      offer.crossJurisdiction &&
      crossJurisdictionBookOwnerRef(offer.crossJurisdiction) !== normalizeEntityRef(currentEntityState.entityId)
    ) {
      entityLog.debug('crossj.orderbook.skip_non_owner', {
        offer: shortOrder(offer.offerId, 8),
        owner: shortId(crossJurisdictionBookOwnerRef(offer.crossJurisdiction), 8),
        current: shortId(currentEntityState.entityId, 8),
      });
      continue;
    }
    const admittedOffer = admitOrderbookOfferForMatching(env, currentEntityState, offer);
    if (admittedOffer) offersToMatch.push(admittedOffer);
  }
  entityLog.debug('orderbook.offers_enriched', {
    local: enrichedOffers.length,
    admitted: offersToMatch.length,
  });

  const matchResult = processOrderbookSwaps(currentEntityState, offersToMatch);
  stats.orderbookMatched = true;
  stats.orderbookMempoolOps = matchResult.mempoolOps.length;
  stats.orderbookBookUpdates = matchResult.bookUpdates.length;
  stats.orderbookCrossFills = matchResult.crossJurisdictionFills.length;

  // Orderbook matching returns pure mempoolOps/book updates. Applying the
  // returned account txs here is still orchestrator-owned mutation of the
  // cloned working state, not handler-side in-place state injection.
  for (const { accountId, tx } of matchResult.mempoolOps) {
    const account = currentEntityState.accounts.get(accountId);

    if (tx.type === 'swap_resolve') {
      const localOwnsOffer = Boolean(account?.swapOffers?.has(tx.data.offerId));
      const localOffer = account?.swapOffers?.get(tx.data.offerId);
      if (localOffer?.crossJurisdiction) {
        entityLog.warn('crossj.block_plain_swap_resolve', {
          offer: shortOrder(tx.data.offerId, 8),
          account: shortId(accountId, 8),
        });
        continue;
      }
      if (account && localOwnsOffer) {
        if (!queueAccountMempoolTx(account, tx)) {
          continue;
        }
        proposableAccounts.add(accountId);
        markStorageAccountDirty(env, currentEntityState.entityId, accountId);
        markStorageEntityDirty(env, currentEntityState.entityId);
        currentEntityState.pendingSwapFillRatios ||= new Map();
        const key = swapKey(accountId, tx.data.offerId);
        currentEntityState.pendingSwapFillRatios.set(key, tx.data.fillRatio);
        entityLog.debug('orderbook.account_tx_queued', { account: shortId(accountId, 8), tx: tx.type });
      } else {
        throw new Error(
          `ORDERBOOK_SWAP_OWNER_NOT_LOCAL: account=${accountId} offer=${tx.data.offerId} ` +
            `entity=${currentEntityState.entityId}`,
        );
      }
      continue;
    }

    if (tx.type === 'cross_swap_fill_ack') {
      const localOwnsOffer = Boolean(account?.swapOffers?.has(tx.data.offerId));
      if (account && localOwnsOffer) {
        if (!queueAccountMempoolTx(account, tx)) {
          continue;
        }
        proposableAccounts.add(accountId);
        markStorageAccountDirty(env, currentEntityState.entityId, accountId);
        markStorageEntityDirty(env, currentEntityState.entityId);
        entityLog.debug('crossj.local_fill_ack_queued', {
          account: shortId(accountId, 8),
          offer: shortOrder(tx.data.offerId, 8),
          ratio: tx.data.cumulativeFillRatio,
          cancel: tx.data.cancelRemainder,
        });
        entityLog.debug('orderbook.account_tx_queued', { account: shortId(accountId, 8), tx: tx.type });
        continue;
      }

      const routed = buildCrossJurisdictionFillNoticeOutput(currentEntityState, accountId, tx);
      if (!routed) {
        if (ownsSourceHubRouteForFillAck(currentEntityState, tx)) {
          stashPendingCrossJurisdictionFillAck(
            env,
            currentEntityState,
            accountId,
            tx,
            account ? 'source_offer_not_committed' : 'source_account_not_committed',
          );
          continue;
        }
        throw new Error(
          `CROSS_J_FILL_ACK_OWNER_MISSING: account=${accountId} offer=${tx.data.offerId} current=${currentEntityState.entityId}`,
        );
      }
      allOutputs.push(routed);
      entityLog.info('crossj.sibling_fill_notice_routed', {
        owner: shortId(routed.entityId, 8),
        account: shortId(accountId, 8),
        offer: shortOrder(tx.data.offerId, 8),
      });
      continue;
    }

    if (account) {
      if (!queueAccountMempoolTx(account, tx)) {
        continue;
      }
      proposableAccounts.add(accountId);
      markStorageAccountDirty(env, currentEntityState.entityId, accountId);
      markStorageEntityDirty(env, currentEntityState.entityId);
      entityLog.debug('orderbook.account_tx_queued', { account: shortId(accountId, 8), tx: tx.type });
    }
  }

  if (matchResult.debugProjectionRejects.length > 0) {
    const detail = matchResult.debugProjectionRejects
      .map(({ accountId, offerId, reason }) => `${accountId.slice(-8)}:${offerId.slice(-8)}:${reason}`)
      .join(', ');
    throw new Error(`ORDERBOOK_LIVE_PROJECTION_REJECT: ${detail}`);
  }

  if (matchResult.crossJurisdictionFills.length > 0) {
    entityLog.info('crossj.firm_fills_recorded', { count: matchResult.crossJurisdictionFills.length });
    for (const fill of matchResult.crossJurisdictionFills) {
      // Partial cross-j fills keep the original book row alive and matchable.
      // Only a terminal fill/cancel removes the row and moves admission into
      // resolving so the clear flow can claim/release the hash-ledger pulls.
      if (fill.cancelRemainder) {
        markCrossJurisdictionBookAdmissionResolving(
          currentEntityState,
          fill.route,
          deterministicEntityTimestamp(currentEntityState, env),
        );
      }
      if (
        fill.priceImprovementMode !== 'target_bonus' ||
        fill.priceImprovementAmount <= 0n ||
        fill.priceImprovementTokenId === null
      ) {
        continue;
      }
      const targetHubEntityId = normalizeEntityRef(fill.route.target.entityId);
      const targetSigner = String(fill.route.targetHubSignerId || '');
      if (!targetHubEntityId || !normalizeEntityRef(targetSigner)) {
        // target_bonus is owed value from the same firm fill, not an optional
        // notification. If the target hub route is unavailable, committing the
        // ACK/book progress would settle less than the matched economics.
        throw new Error(
          `CROSS_J_TARGET_BONUS_UNROUTABLE: offer=${shortOrder(fill.offerId, 8)} ` +
            `targetHub=${shortId(fill.route.target.entityId, 8)}`,
        );
      }
      allOutputs.push({
        entityId: targetHubEntityId,
        signerId: targetSigner,
        entityTxs: [
          {
            type: 'directPayment',
            data: {
              targetEntityId: fill.route.target.counterpartyEntityId,
              tokenId: fill.priceImprovementTokenId,
              amount: fill.priceImprovementAmount,
              route: [fill.route.target.entityId, fill.route.target.counterpartyEntityId],
              description: `cross-j-target-bonus:${fill.offerId}`,
            },
          },
        ],
      });
    }
  }

  const ext = currentEntityState.orderbookExt as OrderbookExtState;
  for (const { pairId, book } of matchResult.bookUpdates) {
    replaceOrderbookPair(ext, pairId, book);
    recordOrderbookPairUpdate(env, {
      entityId: currentEntityState.entityId,
      pairId,
      book,
    });
  }

  return stats;
}

type ApplySwapCancelRequestsContext = {
  env: Env;
  currentEntityState: EntityState;
  allSwapCancelRequests: SwapCancelRequestEvent[];
  proposableAccounts: Set<string>;
  allOutputs: EntityInput[];
};

function applySwapCancelRequests(context: ApplySwapCancelRequestsContext): void {
  const { env, currentEntityState, allSwapCancelRequests, proposableAccounts, allOutputs } = context;
  if (allSwapCancelRequests.length === 0) return;

  const routedCancels = routeRemoteCrossJurisdictionBookCancels(
    env,
    currentEntityState,
    allSwapCancelRequests,
  );
  allOutputs.push(...routedCancels.outputs);
  for (const { accountId, tx } of routedCancels.mempoolOps) {
    const account = currentEntityState.accounts.get(accountId);
    if (!account) {
      throw new Error(
        `CROSS_J_CANCEL_ACK_ACCOUNT_MISSING:account=${accountId}:offer=${tx.data.offerId}`,
      );
    }
    if (!queueAccountMempoolTx(account, tx)) continue;
    proposableAccounts.add(accountId);
    markStorageAccountDirty(env, currentEntityState.entityId, accountId);
    markStorageEntityDirty(env, currentEntityState.entityId);
  }

  const localBookCancels = routedCancels.localBookCancels;
  if (localBookCancels.length === 0) return;

  if (currentEntityState.orderbookExt) {
    const cancelResult = processOrderbookCancels(currentEntityState, localBookCancels);

    for (const { accountId, tx } of cancelResult.mempoolOps) {
      const account = currentEntityState.accounts.get(accountId);
      if (!account) continue;
      if (!queueAccountMempoolTx(account, tx)) {
        continue;
      }
      proposableAccounts.add(accountId);
      markStorageAccountDirty(env, currentEntityState.entityId, accountId);
      markStorageEntityDirty(env, currentEntityState.entityId);
    }

    const ext = currentEntityState.orderbookExt as OrderbookExtState;
    for (const { pairId, book } of cancelResult.bookUpdates) {
      replaceOrderbookPair(ext, pairId, book);
      recordOrderbookPairUpdate(env, {
        entityId: currentEntityState.entityId,
        pairId,
        book,
      });
    }
    return;
  }

  // Fallback: counterparty resolves cancel directly when no orderbook extension is configured.
  for (const { accountId, offerId } of localBookCancels) {
    const account = currentEntityState.accounts.get(accountId);
    if (!account?.swapOffers?.has(offerId)) continue;
    const offer = account.swapOffers.get(offerId);
    if (offer?.crossJurisdiction) {
      throw new Error(
        `CROSS_J_ORDERBOOK_EXT_REQUIRED: cancel for ${offerId.slice(-8)} cannot use fallback swap_resolve`,
      );
    }
    // Fallback cancel resolution is synthesized by the orchestrator itself.
    // It must land in the same working-state mempool so the later account
    // proposal step sees it in this frame.
    if (
      !queueAccountMempoolTx(account, {
        type: 'swap_resolve',
        data: { offerId, fillRatio: 0, cancelRemainder: true },
      })
    ) {
      continue;
    }
    proposableAccounts.add(accountId);
  }
}

export const applyEntityFrame = async (
  env: Env,
  entityState: EntityState,
  entityTxs: EntityTx[],
  // DETERMINISM: Validators pass proposedFrame.timestamp to match proposer's lockIds/timelocks.
  // Proposers pass env.timestamp (their local time when creating the frame).
  frameTimestamp?: number,
): Promise<{
  newState: EntityState;
  // State snapshot BEFORE account proposals (deterministic across proposer + validators)
  // Proposer must hash from this state to match validator verification
  deterministicState: EntityState;
  outputs: EntityInput[];
  jOutputs: JInput[];
  // Hashes emitted during frame processing that need entity-quorum signing
  collectedHashes?: Array<{
    hash: string;
    type: HashType;
    context: string;
  }>;
  consumptionNodeChanges?: ConsumptionNodeChanges;
  accountJClaimNodeChanges?: AccountJClaimNodeChanges;
}> => {
  assertEntityFrameTxByteBudget(entityTxs);
  assertEntityFrameJRangeBudget(entityTxs);
  assertScheduledWakeFrameOrder(entityTxs);
  const authorityTransitionOnly = await isSelfBoardAuthorityTransitionFrame(env, entityState, entityTxs);
  const frameProfileStartMs = getPerfMs();
  const frameProfileMarks: Record<string, number> = {};
  const frameProfileTxTotals = new Map<string, { count: number; elapsedMs: number }>();
  const markFrameProfile = (label: string): void => {
    frameProfileMarks[label] = Math.round(getPerfMs() - frameProfileStartMs);
  };
  entityLog.debug('frame.apply', { txs: entityTxs.map(tx => tx.type) });
  if (shouldLogFullPayloads()) {
    entityTxs.forEach((tx, index) => {
      entityLog.trace('frame.tx_payload', { index, type: tx.type, data: tx.data });
    });
  }

  // Work on a clone so failed frame construction cannot leak mutations.
  const authorityNormalizedState = normalizeEntityProposalBoard(
    env,
    normalizeEntityCommandNonceBoard(env, entityState),
  );
  let currentEntityState = cloneEntityState(authorityNormalizedState);
  // Legacy/manual states may omit the scheduler. Its deterministic default is
  // consensus state, so initialize it only inside the proposed frame replay.
  // Mutating one replica before a frame commits creates a same-height fork.
  if (!currentEntityState.crontabState) currentEntityState.crontabState = initCrontab();
  markFrameProfile('clone');

  // Validators receive the proposer's frame timestamp; proposers use env.timestamp.
  // HTLC timelocks and lockIds must see this before handlers run.
  currentEntityState.timestamp = frameTimestamp ?? env.timestamp;
  const allOutputs: EntityInput[] = [];
  const allJOutputs: JInput[] = [];
  const collectedHashes: Array<{
    hash: string;
    type: HashType;
    context: string;
  }> = [];
  const consumptionNewNodes = new Map<string, ConsumptionNode>();
  const consumptionReplacedNodeHashes = new Set<string>();
  const accountJClaimNewNodes = new Map<string, AccountJClaimNode>();
  const accountJClaimReplacedNodeHashes = new Set<string>();
  const committedAccountJClaimNodes = getAccountJClaimNodeStore(env);
  const accountJClaimNodeStore: AccountJClaimNodeStore = {
    get: hash => accountJClaimNewNodes.get(hash) ?? committedAccountJClaimNodes.get(hash),
  };

  const proposableAccounts = new Set<string>();
  if (!authorityTransitionOnly) {
    drainPendingCrossJurisdictionFillAcks(env, currentEntityState, proposableAccounts);
    drainCommittedCrossJurisdictionCancelAcks(env, currentEntityState, proposableAccounts);
    for (const [accountId, accountMachine] of currentEntityState.accounts) {
      if (accountHasProposableMempool(accountMachine, currentEntityState)) {
        proposableAccounts.add(accountId);
      }
    }
  }

  const allSwapOffersCreated: SwapOfferEvent[] = [];
  const allSwapCancelRequests: SwapCancelRequestEvent[] = [];
  const allSwapOffersCancelled: SwapCancelEvent[] = [];

  currentEntityState = await applyEntityTxsInOrder({
    env,
    entityTxs,
    currentEntityState,
    allOutputs,
    allJOutputs,
    collectedHashes,
    proposableAccounts,
    allSwapOffersCreated,
    allSwapCancelRequests,
    allSwapOffersCancelled,
    frameProfileTxTotals,
    consumptionNewNodes,
    consumptionReplacedNodeHashes,
    accountJClaimNewNodes,
    accountJClaimReplacedNodeHashes,
    accountJClaimNodeStore,
  });
  markFrameProfile('entityTxLoop');

  if (authorityTransitionOnly) {
    currentEntityState = assignCertifiedOutputIdentities(currentEntityState, allOutputs);
    entityLog.info('frame.board_authority_transition_only', {
      entity: shortId(currentEntityState.entityId),
      txs: entityTxs.length,
      finalizedJHeight: currentEntityState.lastFinalizedJHeight,
    });
    return {
      newState: currentEntityState,
      deterministicState: cloneEntityState(currentEntityState),
      outputs: allOutputs,
      jOutputs: allJOutputs,
      collectedHashes,
      ...(consumptionNewNodes.size > 0 || consumptionReplacedNodeHashes.size > 0
        ? {
            consumptionNodeChanges: {
              newNodes: Array.from(consumptionNewNodes, ([hash, node]) => ({ hash, node })),
              replacedNodeHashes: Array.from(consumptionReplacedNodeHashes).sort(),
            },
          }
        : {}),
      ...(accountJClaimNewNodes.size > 0 || accountJClaimReplacedNodeHashes.size > 0
        ? {
            accountJClaimNodeChanges: {
              newNodes: Array.from(accountJClaimNewNodes, ([hash, node]) => ({ hash, node })),
              replacedNodeHashes: Array.from(accountJClaimReplacedNodeHashes).sort(),
            },
          }
        : {}),
    };
  }

  // === APPLY AGGREGATED PURE EVENTS ===

  // 1. MempoolOps now applied inline (see above in the loop) to fix simultaneous payment bug
  // This section removed - mempoolOps are applied immediately after each applyEntityTx

  // Committed account-level cancels must be reflected in the persisted book
  // before the next matching pass. Otherwise a restored book can still expose
  // an order that the account frame has already removed.
  if (allSwapOffersCancelled.length > 0) {
    applyCommittedSwapCancelsToOrderbook(env, currentEntityState, allSwapOffersCancelled);
  }

  // A committed cancel has priority over every offer created in the same
  // Entity frame. Matching first permits a taker to fill liquidity after the
  // maker's bilateral Account has already committed its cancellation.
  applySwapCancelRequests({
    env,
    currentEntityState,
    allSwapCancelRequests,
    proposableAccounts,
    allOutputs,
  });
  markFrameProfile('cancels');

  const orderbookStats = applyOrderbookMatching({
    env,
    currentEntityState,
    allSwapOffersCreated,
    allOutputs,
    proposableAccounts,
  });
  markFrameProfile('orderbook');

  // Hash before account proposals so proposer and validators commit to the same
  // deterministic entity state.
  drainPendingCrossJurisdictionFillAcks(env, currentEntityState, proposableAccounts);
  drainCommittedCrossJurisdictionCancelAcks(env, currentEntityState, proposableAccounts);
  materializeDeferredSettlementApprovals(
    env,
    currentEntityState,
    proposableAccounts,
    collectedHashes,
  );
  const deterministicState = cloneEntityState(currentEntityState);
  markFrameProfile('deterministicClone');

  const accountsToProposeFramesCount = await proposePendingAccountFrames({
    env,
    currentEntityState,
    proposableAccounts,
    allOutputs,
    collectedHashes,
    accountJClaimNodeStore,
  });
  markFrameProfile('accountProposals');
  currentEntityState = assignCertifiedOutputIdentities(currentEntityState, allOutputs);

  const prunedOriginatedHtlcRoutes = pruneSettledOriginatedHtlcRoutes(currentEntityState, currentEntityState.timestamp);
  if (prunedOriginatedHtlcRoutes > 0) {
    markStorageEntityDirty(env, currentEntityState.entityId);
  }

  const frameElapsedMs = Math.round(getPerfMs() - frameProfileStartMs);
  if (ENTITY_FRAME_PROFILE || frameElapsedMs >= ENTITY_FRAME_SLOW_MS) {
    entityLog.warn('frame.profile', {
      entity: String(currentEntityState.entityId || '').slice(-8),
      elapsedMs: frameElapsedMs,
      txs: entityTxs.length,
      txTypes: Array.from(new Set(entityTxs.map(tx => tx.type))).slice(0, 16),
      accountsToPropose: accountsToProposeFramesCount,
      outputs: allOutputs.length,
      jOutputs: allJOutputs.length,
      collectedHashes: collectedHashes.length,
      swapOffersCreated: allSwapOffersCreated.length,
      swapCancels: allSwapCancelRequests.length + allSwapOffersCancelled.length,
      hasOrderbookExt: Boolean(currentEntityState.orderbookExt),
      hasPersistedCrossJurisdictionBook: orderbookStats.hasPersistedCrossJurisdictionBook,
      orderbookMatched: orderbookStats.orderbookMatched,
      orderbookMempoolOps: orderbookStats.orderbookMempoolOps,
      orderbookBookUpdates: orderbookStats.orderbookBookUpdates,
      orderbookCrossFills: orderbookStats.orderbookCrossFills,
      prunedOriginatedHtlcRoutes,
      marks: frameProfileMarks,
      txTypeTotals: Array.from(frameProfileTxTotals.entries())
        .map(([type, value]) => ({ type, ...value }))
        .sort((left, right) => right.elapsedMs - left.elapsedMs)
        .slice(0, 16),
    });
  }

  return {
    newState: currentEntityState,
    deterministicState,
    outputs: allOutputs,
    jOutputs: allJOutputs,
    collectedHashes,
    ...(consumptionNewNodes.size > 0 || consumptionReplacedNodeHashes.size > 0
      ? {
          consumptionNodeChanges: {
            newNodes: Array.from(consumptionNewNodes, ([hash, node]) => ({ hash, node })),
            replacedNodeHashes: Array.from(consumptionReplacedNodeHashes).sort(),
          },
        }
      : {}),
    ...(accountJClaimNewNodes.size > 0 || accountJClaimReplacedNodeHashes.size > 0
      ? {
          accountJClaimNodeChanges: {
            newNodes: Array.from(accountJClaimNewNodes, ([hash, node]) => ({ hash, node })),
            replacedNodeHashes: Array.from(accountJClaimReplacedNodeHashes).sort(),
          },
        }
      : {}),
  };
};

// === HELPER FUNCTIONS ===

/**
 * Calculate quorum power based on validator shares
 */
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
  return `mempool=${replica.mempool.length}, messages=${replica.state.messages.length}, proposal=${hasProposal}`;
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
