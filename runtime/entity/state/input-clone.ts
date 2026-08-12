import type { EntityInput, EntityOutput, EntityLeaderCertificate, EntityLeaderTimeoutVote, EntityFrame } from '../types';
import type { EntityTx } from '../../types/entity-tx';
import type { JPrefixAttestation, JPrefixCertificate, JPrefixClaim } from '../../types/jurisdiction-events';

export const cloneIsolatedEntityTxs = (txs: readonly EntityTx[]): EntityTx[] =>
  txs.map(tx => structuredClone(tx));

const cloneJPrefixClaim = <T extends JPrefixClaim>(claim: T): T => ({
  ...claim,
  blocks: claim.blocks.map(block => ({
    ...block,
    events: block.events.map(event => structuredClone(event)),
    ...(block.disputeFinalizationEvidence
      ? {
          disputeFinalizationEvidence: block.disputeFinalizationEvidence
            .map(evidence => structuredClone(evidence)),
        }
      : {}),
  })),
});

const cloneJPrefixAttestation = (attestation: JPrefixAttestation): JPrefixAttestation =>
  ({
    ...cloneJPrefixClaim(attestation),
    headers: attestation.headers.map(header => ({ ...header })),
  });

const cloneJPrefixCertificate = (certificate: JPrefixCertificate): JPrefixCertificate => ({
  ...certificate,
  selected: cloneJPrefixClaim(certificate.selected),
  attestations: new Map(Array.from(certificate.attestations, ([signerId, attestation]) => [
    signerId,
    cloneJPrefixAttestation(attestation),
  ])),
});

const cloneLeaderVote = (
  vote: EntityLeaderTimeoutVote,
  activeFrames: Set<object>,
): EntityLeaderTimeoutVote => ({
  ...vote,
  ...(vote.preparedFrame
    ? { preparedFrame: cloneProposedEntityFrame(vote.preparedFrame, activeFrames) }
    : {}),
});

const cloneLeaderCertificate = (
  certificate: EntityLeaderCertificate,
  activeFrames: Set<object>,
): EntityLeaderCertificate => ({
  ...certificate,
  votes: new Map(certificate.votes),
  ...(certificate.preparedVotes
    ? {
        preparedVotes: new Map(Array.from(certificate.preparedVotes, ([signerId, vote]) => [
          signerId,
          cloneLeaderVote(vote, activeFrames),
        ])),
      }
    : {}),
});

const cloneProposedEntityFrame = (
  frame: EntityFrame,
  activeFrames: Set<object>,
): EntityFrame => {
  if (activeFrames.has(frame)) throw new Error('RUNTIME_INPUT_PREPARED_FRAME_CYCLE');
  activeFrames.add(frame);
  try {
    return {
      height: frame.height,
      parentFrameHash: frame.parentFrameHash,
      stateRoot: frame.stateRoot,
      authorityRoot: frame.authorityRoot,
      timestamp: frame.timestamp,
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
      ...(frame.jPrefixCertificate
        ? { jPrefixCertificate: cloneJPrefixCertificate(frame.jPrefixCertificate) }
        : {}),
      hashesToSign: frame.hashesToSign.map(hashToSign => ({ ...hashToSign })),
      ...(frame.collectedSigs
        ? {
            collectedSigs: new Map(Array.from(frame.collectedSigs, ([signerId, signatures]) => [
              signerId,
              [...signatures],
            ])),
          }
        : {}),
      ...(frame.hankos ? { hankos: [...frame.hankos] } : {}),
    };
  } finally {
    activeFrames.delete(frame);
  }
};

export const cloneIsolatedProposedEntityFrame = (
  frame: EntityFrame,
): EntityFrame => cloneProposedEntityFrame(frame, new Set());

export const cloneIsolatedEntityLeaderTimeoutVote = (
  vote: EntityLeaderTimeoutVote,
): EntityLeaderTimeoutVote => cloneLeaderVote(vote, new Set());

export const cloneIsolatedEntityLeaderCertificate = (
  certificate: EntityLeaderCertificate,
): EntityLeaderCertificate => cloneLeaderCertificate(certificate, new Set());

/**
 * Bun 1.3.x can corrupt a later repeated reference when one structuredClone
 * spans several protocol values. Runtime inputs never assign meaning to JS
 * object identity, so isolate every EntityInput field and every EntityTx.
 */
export const cloneIsolatedEntityInput = <T extends EntityOutput>(input: T): T => {
  const cloned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === 'entityTxs') {
      if (!Array.isArray(value)) throw new Error('RUNTIME_INPUT_ENTITY_TXS_INVALID');
      cloned[key] = cloneIsolatedEntityTxs(value as EntityTx[]);
      continue;
    }
    if (key === 'proposedFrame') {
      cloned[key] = cloneIsolatedProposedEntityFrame(value as EntityFrame);
      continue;
    }
    if (key === 'hashPrecommitFrame') {
      if (!value || typeof value !== 'object') {
        throw new Error('RUNTIME_INPUT_HASH_PRECOMMIT_FRAME_INVALID');
      }
      cloned[key] = { ...(value as EntityInput['hashPrecommitFrame']) };
      continue;
    }
    if (key === 'hashPrecommits') {
      if (!(value instanceof Map)) throw new Error('RUNTIME_INPUT_HASH_PRECOMMITS_INVALID');
      cloned[key] = new Map(Array.from(value, ([signerId, signatures]) => [
        signerId,
        [...(signatures as string[])],
      ]));
      continue;
    }
    if (key === 'jPrefixAttestations') {
      if (!(value instanceof Map)) throw new Error('RUNTIME_INPUT_J_PREFIX_ATTESTATIONS_INVALID');
      cloned[key] = new Map(Array.from(value, ([signerId, attestation]) => [
        signerId,
        cloneJPrefixAttestation(attestation as JPrefixAttestation),
      ]));
      continue;
    }
    if (key === 'leaderTimeoutVote') {
      cloned[key] = cloneIsolatedEntityLeaderTimeoutVote(value as EntityLeaderTimeoutVote);
      continue;
    }
    cloned[key] = structuredClone(value);
  }
  const entityTxs = cloned['entityTxs'];
  if (
    input.entityTxs !== undefined &&
    (!Array.isArray(entityTxs) || entityTxs.length !== input.entityTxs.length)
  ) {
    throw new Error('RUNTIME_INPUT_ENTITY_TX_CLONE_SHAPE_MISMATCH');
  }
  return cloned as T;
};
