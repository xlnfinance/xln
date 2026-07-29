import type { EntityReplica } from '../types';
import {
  cloneIsolatedEntityInput,
  cloneIsolatedEntityLeaderCertificate,
  cloneIsolatedEntityLeaderTimeoutVote,
  cloneIsolatedProposedEntityFrame,
} from '../protocol/runtime-input-clone';
import { validateEntityReplica } from './replica-validation';
import {
  cloneEntityState,
  cloneTrustedEntityState,
} from './state-clone';

type CloneState = typeof cloneEntityState;

const cloneValidatorExecution = (
  execution: NonNullable<EntityReplica['validatorExecution']>,
  cloneState: CloneState,
): NonNullable<EntityReplica['validatorExecution']> => ({
  frameHash: execution.frameHash,
  height: execution.height,
  state: cloneState(execution.state),
  outputs: execution.outputs.map(cloneIsolatedEntityInput),
  jOutputs: execution.jOutputs.map(output => structuredClone(output)),
  hashesToSign: execution.hashesToSign.map(hash => ({ ...hash })),
  candidateEffects: structuredClone(execution.candidateEffects),
  storageChanges: execution.storageChanges.map(change => ({ ...change })),
  ...(execution.consumptionNodeChanges
    ? {
        consumptionNodeChanges: structuredClone(
          execution.consumptionNodeChanges,
        ),
      }
    : {}),
  ...(execution.accountJClaimNodeChanges
    ? {
        accountJClaimNodeChanges: structuredClone(
          execution.accountJClaimNodeChanges,
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
): EntityReplica => {
  const cloneState = validateClone
    ? cloneEntityState
    : cloneTrustedEntityState;
  const cloned = {
    entityId: replica.entityId,
    signerId: replica.signerId,
    entityEncPubKey: replica.entityEncPubKey,
    entityEncPrivKey: replica.entityEncPrivKey,
    state: cloneState(replica.state, forSnapshot),
    mempool: Array.isArray(replica.mempool) ? [...replica.mempool] : [],
    ...(replica.proposal && {
      proposal: cloneIsolatedProposedEntityFrame(replica.proposal),
    }),
    ...(replica.lockedFrame && {
      lockedFrame: cloneIsolatedProposedEntityFrame(replica.lockedFrame),
    }),
    isProposer: replica.isProposer,
    ...(replica.position && { position: { ...replica.position } }),
    ...(replica.validatorExecution && {
      validatorExecution: cloneValidatorExecution(
        replica.validatorExecution,
        cloneState,
      ),
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

export const cloneTrustedEntityReplica = (
  replica: EntityReplica,
  forSnapshot = false,
): EntityReplica => cloneEntityReplicaWithPolicy(replica, forSnapshot, false);
