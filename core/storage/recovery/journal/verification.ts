import { getCachedSignerPrivateKey } from '../../../account/crypto';
import { safeStringify } from '../../../protocol/serialization';
import type { RuntimeInputApplyResult } from '../../../runtime/frame/apply';
import type { RuntimeReplica } from '../../../runtime/types';
import { computeStoragePostStateHash } from '../..';
import { computeRuntimePostStateComponentDigests } from '../../hashes';
import { computeCanonicalStateHashFromEnv } from '../../canonical-hash';
import {
  applyCertifiedEntityLineagePlan,
  buildRuntimeCheckpointLineagePlan,
} from '../../replica/entity-lineage';
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
import { encodeCanonicalConsensusValue } from '../../../protocol/serialization/canonical-consensus-value';
import { prepareRuntimeOutputPayloadRows } from '../../wal/outbox-payload';
import type { RoutedEntityInput } from '../../../runtime/types';

export const assertRecoveryOutboxMatches = (
  expectedOutputs: readonly RoutedEntityInput[],
  actualOutputs: readonly RoutedEntityInput[],
  expectedRefs: readonly string[],
  height: number,
): void => {
  const canonicalExpectedRefs = expectedRefs.length > 0
    ? [...expectedRefs]
    : prepareRuntimeOutputPayloadRows(expectedOutputs).refs;
  const actualRefs = prepareRuntimeOutputPayloadRows(actualOutputs).refs;
  if (
    canonicalExpectedRefs.length === actualRefs.length &&
    canonicalExpectedRefs.every((hash, index) => hash === actualRefs[index])
  ) return;
  throw new Error(
    `RECOVERY_JOURNAL_OUTBOX_HASH_MISMATCH:height=${height}:` +
    safeStringify({
      expectedRefs: canonicalExpectedRefs,
      actualRefs,
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
  const expectedEntityContexts = encodeCanonicalConsensusValue(new Map(
    [...(frame.entityContexts ?? new Map())].map(([key, context]) => [
      key.split(':').length === 2 ? `${key}:${context.height}` : key,
      context,
    ]),
  ));
  const actualEntityContexts = encodeCanonicalConsensusValue(result.entityContexts);
  if (actualEntityContexts !== expectedEntityContexts) {
    throw new Error(
      `RECOVERY_JOURNAL_ENTITY_CONTEXTS_MISMATCH:height=${height}:` +
      `expected=${expectedEntityContexts}:actual=${actualEntityContexts}`,
    );
  }
  if (frame.runtimeMachine) {
    assertRecoveryRuntimeMachineMatches(env, frame.runtimeMachine, height);
  }
  const lineage = frame.replicaMetaCheckpoint
    ? buildRuntimeCheckpointLineagePlan(env)
    : null;
  const commitment = lineage
    ? buildStorageReplicaMetaCommitmentFromCheckpointPlan(env, lineage)
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
    timestamp: env.state.timestamp,
    replicaMetaDigest: commitment.digest,
    runtimeComponentDigests: computeRuntimePostStateComponentDigests(
      buildReplayVerifiableRuntimePostStateView(env, {
        pendingNetworkOutputs: [],
        excludeDeferredNetworkMeta: true,
        excludePersistedHistoryRecords: true,
      }),
    ),
    runtimeOutputRefs: frame.runtimeOutputRefs ?? [],
    runtimeOutputRetryState: frame.runtimeOutputRetryState ?? [],
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
  if (lineage) applyCertifiedEntityLineagePlan(env, lineage);
};
