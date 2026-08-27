import { getCachedSignerPrivateKey } from '../../../account/crypto';
import { safeStringify } from '../../../protocol/serialization';
import type { RuntimeInputApplyResult } from '../../../runtime/frame/apply';
import type { RuntimeReplica , RoutedEntityInput } from '../../../runtime/types';
import { computeStoragePostStateHash } from '../..';
import { computeRuntimePostStateComponentDigests } from '../../hashes';
import { computeCanonicalStateHashFromEnv } from '../../canonical-hash';
import {
  applyCertifiedEntityHeadPlan,
  buildRuntimeCheckpointHeadPlan,
} from '../../replica/entity-head';
import {
  buildStorageLiveReplicaMetaCommitment,
  buildStorageReplicaMetaCommitmentFromCheckpointPlan,
  inspectStorageReplicaMetaEntries,
  summarizeStorageReplicaMetaEntries,
  summarizeStorageReplicaMetaFields,
  summarizeStorageReplicaMetaHeads,
} from '../../replica/replicas';
import type { PersistedFrameJournal } from '../../types';
import {
  buildStorageRuntimeMachineSnapshot,
  buildReplayVerifiableRuntimePostStateView,
} from '../../wal/snapshot';
import {
  assertRecoveryRuntimeMachineMatches,
  listRecoveryRuntimeMachineMismatchFields,
} from '../machine';
import { encodeCanonicalConsensusBytes } from '../../../protocol/serialization/binary-codec';
import { keccakBytesHash } from '../../../protocol/crypto/keccak-text';
import {
  prepareRuntimeOutputRows,
  type RuntimeOutputCommitment,
} from '../../wal/outbox-payload';
import { timePerfPhase } from '../../../support/performance/profile';

export const assertRecoveryOutboxMatches = (
  expectedOutputs: readonly RoutedEntityInput[],
  actualOutputs: readonly RoutedEntityInput[],
  expectedCommitment: RuntimeOutputCommitment,
  height: number,
): void => {
  const persisted = prepareRuntimeOutputRows(height, expectedOutputs).commitment;
  const actual = prepareRuntimeOutputRows(height, actualOutputs).commitment;
  if (
    persisted.count === expectedCommitment.count &&
    persisted.digest === expectedCommitment.digest &&
    actual.count === expectedCommitment.count &&
    actual.digest === expectedCommitment.digest
  ) return;
  throw new Error(
    `RECOVERY_JOURNAL_OUTBOX_HASH_MISMATCH:height=${height}:` +
    safeStringify({
      expectedCommitment,
      persisted,
      actual,
      expectedOutputs,
      actualOutputs,
    }),
  );
};

export const verifyRecoveryJournalFrame = (
  env: RuntimeReplica,
  frame: PersistedFrameJournal,
  height: number,
  result: RuntimeInputApplyResult,
): void => {
  // Frames written before contexts were keyed by certified height carry one
  // bare `replicaId` key per replica; compare them under the current key shape.
  const expectedEntityContexts = timePerfPhase('recovery.verify.entityContexts.expected', () =>
    keccakBytesHash(encodeCanonicalConsensusBytes(new Map(
      [...(frame.entityContexts ?? new Map())].map(([key, context]) => [
        key.split(':').length === 2 ? `${key}:${context.height}` : key,
        context,
      ]),
    ))));
  const actualEntityContexts = timePerfPhase('recovery.verify.entityContexts.actual', () =>
    keccakBytesHash(encodeCanonicalConsensusBytes(result.entityContexts)));
  if (actualEntityContexts !== expectedEntityContexts) {
    throw new Error(
      `RECOVERY_JOURNAL_ENTITY_CONTEXTS_MISMATCH:height=${height}:` +
      `expectedDigest=${expectedEntityContexts}:actualDigest=${actualEntityContexts}:` +
      `actual=${safeStringify(result.entityContexts)}`,
    );
  }
  const expectedRuntimeMachine = frame.runtimeMachine;
  if (expectedRuntimeMachine) {
    timePerfPhase('recovery.verify.runtimeMachine', () =>
      assertRecoveryRuntimeMachineMatches(env, expectedRuntimeMachine, height));
  }
  const lineage = timePerfPhase('recovery.verify.lineage', () => frame.materializedState === true
    ? buildRuntimeCheckpointHeadPlan(env)
    : null);
  const commitment = timePerfPhase('recovery.verify.replicaMeta', () => lineage
    ? buildStorageReplicaMetaCommitmentFromCheckpointPlan(env, lineage)
    : buildStorageLiveReplicaMetaCommitment(env));
  const debugHeight = typeof process === 'undefined'
    ? Number.NaN
    : Number(process.env['XLN_STORAGE_DEBUG_REPLICA_META_HEIGHT']);
  if (debugHeight === height) {
    console.error(`RECOVERY_REPLICA_META_DEBUG:${height}:${safeStringify({
      digest: commitment.digest,
      entries: inspectStorageReplicaMetaEntries(commitment.entries),
      certifiedHeads: [...env.state.eReplicas].map(([key, replica]) => ({
        key,
        certifiedFrameHead: replica.certifiedFrameHead ?? null,
      })),
    })}`);
  }
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
  const postStateHash = timePerfPhase('recovery.verify.postState', () =>
    computeStoragePostStateHash({
      height,
      timestamp: env.state.timestamp,
      replicaMetaDigest: commitment.digest,
      runtimeComponentDigests: computeRuntimePostStateComponentDigests(
        buildReplayVerifiableRuntimePostStateView(env, {
          pendingNetworkOutputs: [],
          excludePersistedHistoryRecords: true,
        }),
      ),
      runtimeOutputCount: frame.runtimeOutputCount,
      runtimeOutputsDigest: frame.runtimeOutputsDigest,
    }));
  if (postStateHash !== frame.postStateHash) {
    throw new Error(
      `RECOVERY_JOURNAL_POST_STATE_HASH_MISMATCH:height=${height}:` +
      `expected=${frame.postStateHash}:actual=${postStateHash}`,
    );
  }
  if (frame.runtimeStateHash) {
    const stateHash = timePerfPhase('recovery.verify.runtimeState', () =>
      computeCanonicalStateHashFromEnv(env));
    if (stateHash !== frame.runtimeStateHash) {
      const actualMachine = buildStorageRuntimeMachineSnapshot(env);
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
  if (lineage) applyCertifiedEntityHeadPlan(env, lineage);
};
