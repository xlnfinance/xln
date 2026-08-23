import { LIMITS } from '../../config/constants';
import { log } from '../../support/diagnostics';
import { safeStringify } from '../../protocol/serialization';
import type { EntityTx } from '../../types/entity-tx';
import type { ConsensusConfig, EntityInput, EntityReplica, EntityState } from '../types';
import { validateProposedEntityFrame } from './frame/validation';
import { getEntityInputPhaseCombinationError } from './input/phase-views';

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
    log.error('❌ J-prefix attestations must be a non-empty Map');
    return false;
  }
  if (input.jPrefixAttestations.size > LIMITS.MAX_VALIDATORS) {
    log.error(`❌ Too many J-prefix attestations: ${input.jPrefixAttestations.size}`);
    return false;
  }
  for (const [signerId, attestation] of input.jPrefixAttestations) {
    if (typeof signerId === 'string' && attestation && typeof attestation === 'object') continue;
    log.error('❌ Invalid J-prefix attestation entry');
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
    log.error('❌ Frame txs must be array');
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
    log.error('❌ Invalid frame leader metadata');
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
  if (!valid) log.error('❌ Invalid leader timeout vote');
  return valid;
};

/** Reject malformed transport data before it can enter the Entity mempool. */
export const isEntityInputWellFormed = (input: EntityInput): boolean => {
  try {
    if (!input.entityId || typeof input.entityId !== 'string') {
      log.error(`❌ Invalid entityId: ${input.entityId}`);
      return false;
    }
    const phaseError = getEntityInputPhaseCombinationError(input);
    if (phaseError) {
      log.error(`❌ Invalid EntityInput phase combination: ${phaseError}`);
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

export const validateVotingPower = (power: bigint): boolean => {
  try {
    if (power < 0n) {
      log.error(`❌ Negative voting power: ${power}`);
      return false;
    }
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
