/**
 * Verifies quorum evidence carried across Entity leader changes.
 *
 * A prepared frame is reusable only when its body, signer bundles, parent,
 * leader certificate, and canonical hash all agree. View change may abandon
 * valid sub-quorum votes, but it must never reinterpret or merge conflicting
 * prepared frames.
 */
import { verifyAccountSignature } from '../../../account/crypto';
import { log } from '../../../support/diagnostics';
import { canonicalConsensusValuesEqual } from '../../../protocol/serialization/binary-codec';
import { compareStableText } from '../../../protocol/serialization';
import type { ConsensusConfig, EntityCandidate, EntityLeaderCertificate, EntityLeaderTimeoutVote, EntityReplica, EntityState, HashToSign, EntityFrame } from '../../types';
import type { EntityRuntimeContext } from '../../runtime-context';
import { entityLog } from '../entity-log';
import { createEntityFrameHashFromStateRoot } from '../frame';
import {
  assertEntityLeaderVoteMatchesState,
  getEntityLeaderState,
  hashEntityLeaderVoteBody,
  leaderVoteCollectionKey,
  type EntityLeaderStateView,
} from './index';
import { calculateQuorumPower } from '../replica-validation';
import { bindEntityCandidateToFrame } from '../candidate-views';

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
  hashesToSign: HashToSign[],
  sigs: string[],
  context: string,
): boolean => {
  if (hashesToSign.length === 0) {
    throw new Error(`${context}:EMPTY_HASH_MANIFEST`);
  }
  if (sigs.length !== hashesToSign.length) {
    log.error(
      `❌ ${context}: signature count mismatch from ${signerId}: got ${sigs.length}, expected ${hashesToSign.length}`,
    );
    return false;
  }
  for (let i = 0; i < hashesToSign.length; i++) {
    const hashInfo = hashesToSign[i];
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
  frame: EntityFrame,
  context: string,
): boolean => {
  const hashes = frame.hashesToSign;
  if (!hashes?.length || hashes[0]?.type !== 'entityFrame' || hashes[0]?.hash !== frame.hash) {
    throw new Error(`${context}_MANIFEST_INVALID:${frame.hash}`);
  }
  const signatures = normalizePrecommitBundles(state.config, frame.collectedSigs ?? new Map(), context);
  for (const [signerId, bundle] of signatures) {
    if (!verifyHashPrecommitSignatures(env, signerId, hashes, bundle, context)) {
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
  frame: EntityFrame,
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
  frame: EntityFrame;
  signatures: Map<string, string[]>;
};

const validatePreparedFrameEvidence = (
  env: EntityRuntimeContext,
  state: EntityLeaderStateView,
  certificate: EntityLeaderCertificate,
  evidence: EntityFrame,
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
    evidence.entityContext,
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
  evidence: EntityFrame,
  signatures: Map<string, string[]>,
): void => {
  const group = groups.get(evidence.hash) ?? {
    frame: structuredClone(evidence),
    signatures: new Map<string, string[]>(),
  };
  const { collectedSigs: _groupSignatures, ...groupBody } = group.frame;
  const { collectedSigs: _evidenceSignatures, ...evidenceBody } = evidence;
  if (!canonicalConsensusValuesEqual(groupBody, evidenceBody)) {
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
): EntityFrame | null => {
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
  frame: EntityFrame,
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
  frame: EntityFrame,
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
  frame: EntityFrame,
): EntityCandidate | undefined => {
  const execution = replica.candidate;
  if (!execution) return undefined;
  return bindEntityCandidateToFrame(execution, frame).candidate;
};
