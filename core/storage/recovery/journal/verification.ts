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
  projectReplayVerifiableRuntimePostStateView,
} from '../../wal/snapshot';
import {
  assertRecoveryRuntimeMachineMatches,
  listRecoveryRuntimeMachineMismatchFields,
} from '../machine';
import { canonicalConsensusValuesEqual, encodeCanonicalConsensusBytes } from '../../../protocol/serialization/binary-codec';
import { buildRouteOutputKey } from '../../../runtime/delivery/identity';
import { keccakBytesHash } from '../../../protocol/crypto/keccak-text';
import {
  prepareRuntimeOutputRows,
  type RuntimeOutputCommitment,
} from '../../wal/outbox-payload';
import { timePerfPhase } from '../../../support/performance/profile';

/**
 * Replay regenerates only this frame's outputs, so only they need the signer
 * the live route chose. A retained output keeps the signer it was committed
 * with; the peer may have re-announced a new signer since, and hinting from it
 * made replay throw a conflict on every restart.
 */
export const collectCurrentOutputSignerHints = (
  outputs: readonly RoutedEntityInput[],
  height: number,
): Map<string, string> => {
  const hints = new Map<string, string>();
  for (const output of outputs) {
    if (output.sourceRuntimeFrame?.height !== height) continue;
    // Account delivery has one persisted shape: a raw atomic AccountInput.
    const carriesAccountInput = (output.entityTxs ?? []).some(tx => tx.type === 'accountInput');
    if (!carriesAccountInput) continue;
    const entityId = String(output.entityId || '').trim().toLowerCase();
    const signerId = String(output.signerId || '').trim().toLowerCase();
    if (!entityId || !signerId) {
      throw new Error(`RECOVERY_OUTPUT_SIGNER_HINT_INVALID:height=${height}`);
    }
    const existing = hints.get(entityId);
    if (existing && existing !== signerId) {
      throw new Error(
        `RECOVERY_OUTPUT_SIGNER_HINT_CONFLICT:height=${height}:` +
        `entity=${entityId}:left=${existing}:right=${signerId}`,
      );
    }
    hints.set(entityId, signerId);
  }
  return hints;
};

/** Transport retirement is external; retained rows must be exact prior verified outputs. */
export const selectRetainedRecoveryOutbox = (
  previous: readonly RoutedEntityInput[],
  recorded: readonly RoutedEntityInput[],
  height: number,
): RoutedEntityInput[] => {
  const financialEvidence = (output: RoutedEntityInput): RoutedEntityInput => ({ ...output, runtimeId: '' });
  const prior = new Map(previous.map((output, index) => [buildRouteOutputKey(financialEvidence(output)), { output, index }]));
  const retained: RoutedEntityInput[] = [];
  let priorIndex = -1;
  for (const output of recorded) {
    const source = output.sourceRuntimeFrame;
    if (!source || source.height > height || !output.runtimeId) {
      throw new Error(`RECOVERY_OUTBOX_SOURCE_FRAME_INVALID:height=${height}`);
    }
    if (source.height === height) continue;
    const verified = prior.get(buildRouteOutputKey(financialEvidence(output)));
    if (!verified || !canonicalConsensusValuesEqual(financialEvidence(verified.output), financialEvidence(output))) {
      throw new Error(`RECOVERY_OUTBOX_RETAINED_OUTPUT_UNPROVEN:height=${height}`);
    }
    if (verified.index <= priorIndex) throw new Error(`RECOVERY_OUTBOX_RETAINED_ORDER_INVALID:height=${height}`);
    priorIndex = verified.index;
    // Reuse prior verified evidence; recorded bytes cannot manufacture a new
    // financial output by declaring an older source frame or changing a signature.
    // Verified route rebinding changes only the transport destination; the
    // frame's committed route map and complete digest are checked during replay.
    retained.push(verified.output.runtimeId === output.runtimeId
      ? verified.output : { ...verified.output, runtimeId: output.runtimeId });
  }
  return retained;
};

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
  const postState = timePerfPhase('recovery.verify.postState', () => {
    const runtimeComponentDigests = computeRuntimePostStateComponentDigests(
      buildReplayVerifiableRuntimePostStateView(env),
    );
    return {
      runtimeComponentDigests,
      hash: computeStoragePostStateHash({
        height,
        timestamp: env.state.timestamp,
        replicaMetaDigest: commitment.digest,
        runtimeComponentDigests,
        runtimeOutputCount: frame.runtimeOutputCount,
        runtimeOutputsDigest: frame.runtimeOutputsDigest,
      }),
    };
  });
  const postStateHash = postState.hash;
  if (postStateHash !== frame.postStateHash) {
    // Report only fixed field names and digests. Runtime-machine components
    // include encryption seeds; neither their values nor WAL inputs may enter
    // this diagnostic. Snapshot projection is evidence, never a second oracle.
    const recordedSnapshotComponents = expectedRuntimeMachine
      ? computeRuntimePostStateComponentDigests(
          projectReplayVerifiableRuntimePostStateView(expectedRuntimeMachine),
        )
      : null;
    const recordedByKey = new Map(recordedSnapshotComponents?.map(({ key, valueHash }) => [key, valueHash]));
    const actualByKey = new Map(postState.runtimeComponentDigests.map(({ key, valueHash }) => [key, valueHash]));
    throw new Error(
      `RECOVERY_JOURNAL_POST_STATE_HASH_MISMATCH:height=${height}:` +
      `expected=${frame.postStateHash}:actual=${postStateHash}:` +
      `diagnostics=${safeStringify({
        height,
        frameTimestamp: frame.timestamp,
        replayTimestamp: env.state.timestamp,
        runtimeTxTypes: frame.runtimeInput.runtimeTxs.map(tx => tx.type),
        replicaMetaDigest: commitment.digest,
        runtimeOutputCount: frame.runtimeOutputCount,
        runtimeOutputsDigest: frame.runtimeOutputsDigest,
        hasRecordedMachine: Boolean(expectedRuntimeMachine),
        actualComponents: postState.runtimeComponentDigests,
        recordedSnapshotComponents,
        componentMismatches: recordedSnapshotComponents
          ? [...new Set([...recordedByKey.keys(), ...actualByKey.keys()])]
              .sort().filter(key => recordedByKey.get(key) !== actualByKey.get(key))
          : null,
      })}`,
    );
  }
  if (frame.canonicalStateHash) {
    const stateHash = timePerfPhase('recovery.verify.runtimeState', () =>
      computeCanonicalStateHashFromEnv(env));
    if (stateHash !== frame.canonicalStateHash) {
      const actualMachine = buildStorageRuntimeMachineSnapshot(env);
      const fields = frame.runtimeMachine
        ? listRecoveryRuntimeMachineMismatchFields(
            frame.runtimeMachine,
            actualMachine,
          )
        : ['runtimeMachine'];
      throw new Error(
        `RECOVERY_JOURNAL_STATE_HASH_MISMATCH:height=${height}:` +
        `expected=${frame.canonicalStateHash}:actual=${stateHash}:` +
        `runtimeMachineDiff=${fields.join(',') || 'none'}`,
      );
    }
  }
  if (lineage) applyCertifiedEntityHeadPlan(env, lineage);
};
