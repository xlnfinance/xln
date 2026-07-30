import type { EntityReplica } from './types';
import {
  cloneIsolatedEntityInput,
  cloneIsolatedEntityLeaderCertificate,
  cloneIsolatedEntityLeaderTimeoutVote,
  cloneIsolatedProposedEntityFrame,
} from './input-clone';
import { validateEntityReplica } from './replica-validation';
import {
  cloneEntityState,
  cloneTrustedEntityState,
} from './state-clone';

type CloneState = typeof cloneEntityState;

const cloneEntityCandidate = (
  candidate: NonNullable<EntityReplica['candidate']>,
  cloneState: CloneState,
): NonNullable<EntityReplica['candidate']> => ({
  frameHash: candidate.frameHash,
  height: candidate.height,
  state: cloneState(candidate.state),
  outputs: candidate.outputs.map(cloneIsolatedEntityInput),
  jOutputs: candidate.jOutputs.map(output => structuredClone(output)),
  hashesToSign: candidate.hashesToSign.map(hash => ({ ...hash })),
  candidateEffects: structuredClone(candidate.candidateEffects),
  storageChanges: candidate.storageChanges.map(change => ({ ...change })),
  ...(candidate.consumptionNodeChanges
    ? {
        consumptionNodeChanges: structuredClone(
          candidate.consumptionNodeChanges,
        ),
      }
    : {}),
  ...(candidate.accountJClaimNodeChanges
    ? {
        accountJClaimNodeChanges: structuredClone(
          candidate.accountJClaimNodeChanges,
        ),
      }
    : {}),
});

const cloneJHistory = (
  history: NonNullable<EntityReplica['jHistory']>,
): NonNullable<EntityReplica['jHistory']> => ({
  jurisdictionRef: history.jurisdictionRef,
  scannedThroughHeight: history.scannedThroughHeight,
  contiguousThroughHeight: history.contiguousThroughHeight,
  tipBlockHash: history.tipBlockHash,
  eventBlocks: new Map(
    Array.from(history.eventBlocks.entries()).map(([height, block]) => [
      height,
      structuredClone(block),
    ]),
  ),
  blockHashes: new Map(history.blockHashes),
});

const cloneEntityReplicaWithPolicy = (
  replica: EntityReplica,
  forSnapshot: boolean,
  validateClone: boolean,
  shareFrameState = false,
): EntityReplica => {
  const cloneState = validateClone
    ? cloneEntityState
    : cloneTrustedEntityState;
  const cloned = {
    entityId: replica.entityId,
    signerId: replica.signerId,
    entityEncPubKey: replica.entityEncPubKey,
    state: shareFrameState
      ? replica.state
      : cloneState(replica.state, forSnapshot),
    mempool: Array.isArray(replica.mempool) ? [...replica.mempool] : [],
    ...(replica.proposal && {
      proposal: cloneIsolatedProposedEntityFrame(replica.proposal),
    }),
    ...(replica.lockedFrame && {
      lockedFrame: cloneIsolatedProposedEntityFrame(replica.lockedFrame),
    }),
    isProposer: replica.isProposer,
    ...(replica.position && { position: { ...replica.position } }),
    ...(replica.candidate && {
      candidate: shareFrameState
        ? replica.candidate
        : cloneEntityCandidate(replica.candidate, cloneState),
    }),
    ...(replica.certifiedFrameLineage && {
      certifiedFrameLineage: structuredClone(replica.certifiedFrameLineage),
    }),
    ...(replica.certifiedFrameAnchor && {
      certifiedFrameAnchor: structuredClone(replica.certifiedFrameAnchor),
    }),
    ...(replica.hankoWitness && {
      hankoWitness: new Map(
        Array.from(replica.hankoWitness.entries()).map(([hash, entry]) => [
          hash,
          { ...entry },
        ]),
      ),
    }),
    ...(replica.leaderVotes && {
      leaderVotes: new Map(
        Array.from(replica.leaderVotes.entries()).map(([key, vote]) => [
          key,
          cloneIsolatedEntityLeaderTimeoutVote(vote),
        ]),
      ),
    }),
    ...(replica.pendingLeaderCertificate && {
      pendingLeaderCertificate: cloneIsolatedEntityLeaderCertificate(
        replica.pendingLeaderCertificate,
      ),
    }),
    ...(replica.lastConsensusProgressAt !== undefined && {
      lastConsensusProgressAt: replica.lastConsensusProgressAt,
    }),
    ...(replica.jHistory && {
      jHistory: cloneJHistory(replica.jHistory),
    }),
    ...(replica.jPrefixRound && {
      jPrefixRound: structuredClone(replica.jPrefixRound),
    }),
    ...(replica.jSubmitState && {
      jSubmitState: structuredClone(replica.jSubmitState),
    }),
    ...(replica.entityProviderActionSubmitState && {
      entityProviderActionSubmitState: structuredClone(
        replica.entityProviderActionSubmitState,
      ),
    }),
    ...(replica.htlcNotes && {
      htlcNotes: new Map(replica.htlcNotes),
    }),
  } as EntityReplica;

  if (validateClone) {
    return validateEntityReplica(cloned, 'cloneEntityReplica');
  }
  if (cloned.entityId !== cloned.state.entityId) {
    throw new Error('TRUSTED_ENTITY_REPLICA_CLONE_ID_MISMATCH');
  }
  return cloned;
};

export const cloneEntityReplica = (
  replica: EntityReplica,
  forSnapshot = false,
): EntityReplica => cloneEntityReplicaWithPolicy(replica, forSnapshot, true);

/**
 * Fork the small consensus envelope without copying Entity frame State.
 *
 * Certified State is read-only until an accepted frame replaces the `state`
 * reference. A pending candidate is also shared intentionally: every expected
 * rejection is checked before commit finalization mutates its Hanko witnesses.
 * Any exception after that mutation is a programming fault, so the owning
 * Runtime halts and reloads WAL truth instead of attempting partial rollback.
 */
export const forkEntityReplicaForInput = (
  replica: EntityReplica,
): EntityReplica => cloneEntityReplicaWithPolicy(
  replica,
  false,
  false,
  true,
);
