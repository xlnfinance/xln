import type { EntityReplica } from '../types';
import {
  cloneIsolatedEntityLeaderCertificate,
  cloneIsolatedEntityLeaderTimeoutVote,
  cloneIsolatedProposedEntityFrame,
} from '../state/input-clone';
import {
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
  shareMempool = false,
): EntityReplica => {
  const forked: EntityReplica = {
    entityId: replica.entityId,
    signerId: replica.signerId,
    state: replica.state,
    // Plain AccountInput admission never mutates the inherited array: it
    // installs a new appended array before returning. Sharing that immutable
    // prefix avoids copying 1+2+...+N Hub transactions in one Runtime frame.
    // Every other lane keeps the fully isolated copy.
    mempool: Array.isArray(replica.mempool)
      ? (shareMempool ? replica.mempool : [...replica.mempool])
      : [],
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
  };

  if (forked.entityId !== forked.state.entityId) {
    throw new Error('ENTITY_REPLICA_FORK_ID_MISMATCH');
  }
  return forked;
};
