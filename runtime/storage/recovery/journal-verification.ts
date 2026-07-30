import { getCachedSignerPrivateKey } from '../../account/crypto';
import { safeStringify } from '../../protocol/serialization';
import type { RuntimeInputApplyResult } from '../../runtime/frame/apply';
import type { RuntimeReplica } from '../../runtime/types';
import { computeStoragePostStateHash } from '..';
import { computeCanonicalStateHashFromEnv } from '../canonical-hash';
import {
  applyCertifiedEntityLineagePlan,
  buildRuntimeCheckpointLineagePlan,
} from '../entity-lineage';
import {
  buildStorageLiveReplicaMetaCommitment,
  buildStorageReplicaMetaCommitmentFromCheckpointPlan,
  inspectStorageReplicaMetaEntries,
  summarizeStorageReplicaMetaEntries,
  summarizeStorageReplicaMetaFields,
  summarizeStorageReplicaMetaHeads,
} from '../replicas';
import type { PersistedFrameJournal } from '../types';
import {
  buildDurableRuntimeMachineSnapshot,
  buildReplayVerifiableRuntimeMachineSnapshot,
} from '../wal/snapshot';
import {
  assertRecoveryRuntimeMachineMatches,
  listRecoveryRuntimeMachineMismatchFields,
} from './machine';

export const verifyRecoveryJournalFrame = (
  env: RuntimeReplica,
  frame: PersistedFrameJournal,
  height: number,
  result: RuntimeInputApplyResult,
): void => {
  if (frame.runtimeMachine) {
    assertRecoveryRuntimeMachineMatches(env, frame.runtimeMachine, height);
  }
  const lineage = frame.replicaMetaCheckpoint
    ? buildRuntimeCheckpointLineagePlan(env)
    : null;
  const commitment = lineage
    ? buildStorageReplicaMetaCommitmentFromCheckpointPlan(env, lineage, {
        omitIntermediateSingleSignerState:
          frame.replicaMetaStateMode === 'shared-entity-state',
      })
    : buildStorageLiveReplicaMetaCommitment(env);
  if (commitment.digest !== frame.replicaMetaDigest) {
    const inputs = frame.runtimeInput.entityInputs.map(input => ({
      entityId: input.entityId,
      signerId: input.signerId,
      entityTxs: input.entityTxs?.map(tx => tx.type) ?? [],
      proposalHeight: input.proposedFrame?.height ?? null,
      hashPrecommits: input.hashPrecommits?.size ?? 0,
      hasSignerKey:
        input.signerId
          ? getCachedSignerPrivateKey(env, input.signerId) !== null
          : false,
    }));
    throw new Error(
      `RECOVERY_JOURNAL_REPLICA_META_DIGEST_MISMATCH:height=${height}:` +
      `expected=${frame.replicaMetaDigest}:actual=${commitment.digest}:` +
      `actualEntries=${safeStringify(summarizeStorageReplicaMetaEntries(commitment.entries))}:` +
      `actualFields=${safeStringify(summarizeStorageReplicaMetaFields(commitment.entries))}:` +
      `actualHeads=${safeStringify(summarizeStorageReplicaMetaHeads(commitment.entries))}:` +
      `runtimeInput=${safeStringify(inputs)}:` +
      `appliedInput=${safeStringify(result.appliedRuntimeInput)}:` +
      `entityOutbox=${safeStringify(result.entityOutbox)}:` +
      `actualMeta=${safeStringify(inspectStorageReplicaMetaEntries(commitment.entries)).slice(0, 8_000)}`,
    );
  }
  const postStateHash = computeStoragePostStateHash({
    height,
    timestamp: env.timestamp,
    replicaMetaDigest: commitment.digest,
    runtimeMachine: buildReplayVerifiableRuntimeMachineSnapshot(env, {
      pendingNetworkOutputs: env.pendingNetworkOutputs ?? [],
      excludePersistedHistoryRecords: true,
    }),
  });
  if (postStateHash !== frame.postStateHash) {
    throw new Error(
      `RECOVERY_JOURNAL_POST_STATE_HASH_MISMATCH:height=${height}:` +
      `expected=${frame.postStateHash}:actual=${postStateHash}`,
    );
  }
  if (frame.runtimeStateHash) {
    const stateHash = computeCanonicalStateHashFromEnv(env);
    if (stateHash !== frame.runtimeStateHash) {
      const actualMachine = buildDurableRuntimeMachineSnapshot(env);
      const fields = frame.runtimeMachine
        ? listRecoveryRuntimeMachineMismatchFields(
            frame.runtimeMachine,
            actualMachine,
          )
        : ['runtimeMachine'];
      throw new Error(
        `RECOVERY_JOURNAL_STATE_HASH_MISMATCH:height=${height}:` +
        `expected=${frame.runtimeStateHash}:actual=${stateHash}:` +
        `runtimeMachineDiff=${fields.join(',') || 'none'}`,
      );
    }
  }
  if (lineage) applyCertifiedEntityLineagePlan(env, lineage);
};
