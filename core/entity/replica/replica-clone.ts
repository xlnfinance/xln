import type { EntityReplica } from '../types';
import {
  cloneIsolatedEntityLeaderCertificate,
  cloneIsolatedEntityLeaderTimeoutVote,
  cloneIsolatedProposedEntityFrame,
} from '../state/input-clone';
import {
  copyCertifiedEntityLineageAnchor,
  copyEntityProviderActionSubmitState,
  copyJPrefixRound,
  copyJSubmitState,
} from './envelope-copy';

const copyValidatorJHistory = (
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

/**
 * Fork only the bounded validator-private envelope for one input attempt.
 *
 * The certified Entity State and prepared frame candidate are immutable shared
 * roots. Copying either graph here would make ingress O(total Accounts/Book)
 * and would destroy Patricia node identity needed by O(dirty) persistence.
 */
export const forkEntityReplicaForInput = (
  replica: EntityReplica,
): EntityReplica => {
  const forked: EntityReplica = {
    entityId: replica.entityId,
    signerId: replica.signerId,
    state: replica.state,
    mempool: Array.isArray(replica.mempool) ? [...replica.mempool] : [],
    ...(replica.proposal && {
      proposal: cloneIsolatedProposedEntityFrame(replica.proposal),
    }),
    ...(replica.lockedFrame && {
      lockedFrame: cloneIsolatedProposedEntityFrame(replica.lockedFrame),
    }),
    isProposer: replica.isProposer,
    ...(replica.position && { position: { ...replica.position } }),
    ...(replica.candidate && { candidate: replica.candidate }),
    ...(replica.certifiedFrameHead && {
      certifiedFrameHead: replica.certifiedFrameHead,
    }),
    ...(replica.certifiedFrameAnchor && {
      certifiedFrameAnchor: copyCertifiedEntityLineageAnchor(replica.certifiedFrameAnchor),
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
      jHistory: copyValidatorJHistory(replica.jHistory),
    }),
    ...(replica.jPrefixRound && {
      jPrefixRound: copyJPrefixRound(replica.jPrefixRound),
    }),
    ...(replica.jSubmitState && {
      jSubmitState: copyJSubmitState(replica.jSubmitState),
    }),
    ...(replica.entityProviderActionSubmitState && {
      entityProviderActionSubmitState: copyEntityProviderActionSubmitState(
        replica.entityProviderActionSubmitState,
      ),
    }),
    ...(replica.htlcNotes && {
      htlcNotes: new Map(replica.htlcNotes),
    }),
  };

  if (forked.entityId !== forked.state.entityId) {
    throw new Error('ENTITY_REPLICA_FORK_ID_MISMATCH');
  }
  return forked;
};
