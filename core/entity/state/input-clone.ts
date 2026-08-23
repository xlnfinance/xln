import type { EntityOutput, EntityLeaderCertificate, EntityLeaderTimeoutVote, EntityFrame } from '../types';
import type { EntityTx } from '../../types/entity-tx';
import type {
  JPrefixAttestation,
  JPrefixCertificate,
  JPrefixClaim,
  JPrefixRound,
} from '../../types/jurisdiction-events';
import { cloneIsolatedProtocolValue } from '../../protocol/state/isolated-value-clone';

export const cloneIsolatedEntityTxs = (txs: readonly EntityTx[]): EntityTx[] =>
  txs.map(tx => cloneIsolatedProtocolValue(tx, 'ENTITY_TX_CLONE'));

const cloneJPrefixClaim = <T extends JPrefixClaim>(claim: T): T => ({
  ...claim,
  blocks: claim.blocks.map(block => ({
    ...block,
    events: block.events.map(event => structuredClone(event)),
    ...(block.disputeFinalizationEvidence
      ? {
          disputeFinalizationEvidence: block.disputeFinalizationEvidence.map(evidence => structuredClone(evidence)),
        }
      : {}),
  })),
});

const cloneJPrefixAttestation = (attestation: JPrefixAttestation): JPrefixAttestation => ({
  ...cloneJPrefixClaim(attestation),
  headers: attestation.headers.map(header => ({ ...header })),
});

const cloneJPrefixCertificate = (certificate: JPrefixCertificate): JPrefixCertificate => ({
  ...certificate,
  selected: cloneJPrefixClaim(certificate.selected),
  attestations: new Map(
    Array.from(certificate.attestations, ([signerId, attestation]) => [signerId, cloneJPrefixAttestation(attestation)]),
  ),
});

const cloneLeaderVote = (vote: EntityLeaderTimeoutVote, activeFrames: Set<object>): EntityLeaderTimeoutVote => ({
  ...vote,
  ...(vote.preparedFrame ? { preparedFrame: cloneProposedEntityFrame(vote.preparedFrame, activeFrames) } : {}),
});

const cloneLeaderCertificate = (
  certificate: EntityLeaderCertificate,
  activeFrames: Set<object>,
): EntityLeaderCertificate => ({
  ...certificate,
  votes: new Map(certificate.votes),
  ...(certificate.preparedVotes
    ? {
        preparedVotes: new Map(
          Array.from(certificate.preparedVotes, ([signerId, vote]) => [signerId, cloneLeaderVote(vote, activeFrames)]),
        ),
      }
    : {}),
});

const cloneProposedEntityFrame = (frame: EntityFrame, activeFrames: Set<object>): EntityFrame => {
  if (activeFrames.has(frame)) throw new Error('RUNTIME_INPUT_PREPARED_FRAME_CYCLE');
  activeFrames.add(frame);
  try {
    return {
      height: frame.height,
      parentFrameHash: frame.parentFrameHash,
      stateRoot: frame.stateRoot,
      authorityRoot: frame.authorityRoot,
      timestamp: frame.timestamp,
      entityContext: structuredClone(frame.entityContext),
      txs: cloneIsolatedEntityTxs(frame.txs),
      events: structuredClone(frame.events),
      hash: frame.hash,
      leader: {
        proposerSignerId: frame.leader.proposerSignerId,
        view: frame.leader.view,
        ...(frame.leader.certificate
          ? { certificate: cloneLeaderCertificate(frame.leader.certificate, activeFrames) }
          : {}),
        ...(frame.leader.relayCertificate
          ? { relayCertificate: cloneLeaderCertificate(frame.leader.relayCertificate, activeFrames) }
          : {}),
      },
      ...(frame.jPrefixCertificate ? { jPrefixCertificate: cloneJPrefixCertificate(frame.jPrefixCertificate) } : {}),
      hashesToSign: frame.hashesToSign.map(hashToSign => ({ ...hashToSign })),
      ...(frame.collectedSigs
        ? {
            collectedSigs: new Map(
              Array.from(frame.collectedSigs, ([signerId, signatures]) => [signerId, [...signatures]]),
            ),
          }
        : {}),
      ...(frame.hankos ? { hankos: [...frame.hankos] } : {}),
    };
  } finally {
    activeFrames.delete(frame);
  }
};

export const copyJPrefixRound = (round: JPrefixRound): JPrefixRound => ({
  targetEntityHeight: round.targetEntityHeight,
  parentFrameHash: round.parentFrameHash,
  jurisdictionRef: round.jurisdictionRef,
  baseHeight: round.baseHeight,
  attestations: new Map(
    Array.from(round.attestations, ([signerId, attestation]) => [signerId, cloneJPrefixAttestation(attestation)]),
  ),
  ...(round.certificate ? { certificate: cloneJPrefixCertificate(round.certificate) } : {}),
});

export const cloneIsolatedProposedEntityFrame = (frame: EntityFrame): EntityFrame =>
  cloneProposedEntityFrame(frame, new Set());

export const cloneIsolatedEntityLeaderTimeoutVote = (vote: EntityLeaderTimeoutVote): EntityLeaderTimeoutVote =>
  cloneLeaderVote(vote, new Set());

export const cloneIsolatedEntityLeaderCertificate = (certificate: EntityLeaderCertificate): EntityLeaderCertificate =>
  cloneLeaderCertificate(certificate, new Set());

/**
 * Clone an EntityInput/EntityOutput. Bun 1.3.x corrupted repeated object
 * references within a single structuredClone call (oven-sh/bun#32791,
 * #32796); the per-field isolation below was a workaround. Bun 1.4.0
 * fixes the reference pool sync, so a single structuredClone is safe.
 * Shape validation is retained as fail-fast protocol safety.
 */
export const cloneIsolatedEntityInput = <T extends EntityOutput>(input: T): T => {
  // Pre-clone shape validation.
  const entries = Object.entries(input);
  for (const [key, value] of entries) {
    if (key === 'entityTxs' && !Array.isArray(value)) {
      throw new Error('RUNTIME_INPUT_ENTITY_TXS_INVALID');
    }
    if (key === 'hashPrecommitFrame' && (!value || typeof value !== 'object')) {
      throw new Error('RUNTIME_INPUT_HASH_PRECOMMIT_FRAME_INVALID');
    }
    if (key === 'hashPrecommits' && !(value instanceof Map)) {
      throw new Error('RUNTIME_INPUT_HASH_PRECOMMITS_INVALID');
    }
    if (key === 'jPrefixAttestations' && !(value instanceof Map)) {
      throw new Error('RUNTIME_INPUT_J_PREFIX_ATTESTATIONS_INVALID');
    }
  }
  const cloned = structuredClone(input) as T;
  // Post-clone shape check: structuredClone must preserve array length.
  if (
    input.entityTxs !== undefined &&
    (!Array.isArray(cloned.entityTxs) || cloned.entityTxs.length !== input.entityTxs.length)
  ) {
    throw new Error('RUNTIME_INPUT_ENTITY_TX_CLONE_SHAPE_MISMATCH');
  }
  return cloned;
};
